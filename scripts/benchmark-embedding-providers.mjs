import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { compileComposeProject, compileRetrievalFromEvidence } from '@sjshovan/dkb-compiler/compile.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { readEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import {
  ensureFastEmbedService,
  fastEmbedServiceStatus,
  stopFastEmbedService,
} from '@sjshovan/dkb-embedding-fastembed/service.js';
import {
  ensureTeiService,
  stopTeiService,
  teiServiceStatus,
} from '@sjshovan/dkb-embedding-tei/tei.js';

const executeFile = promisify(execFile);
const sourceRoot = path.resolve(required(process.env.DKB_BENCHMARK_CORPUS_ROOT, 'DKB_BENCHMARK_CORPUS_ROOT'));
const runs = positiveInteger(process.env.DKB_BENCHMARK_RUNS ?? '3', 'DKB_BENCHMARK_RUNS');
const benchmarkFileLimit = positiveInteger(process.env.DKB_BENCHMARK_MAX_FILES ?? '32', 'DKB_BENCHMARK_MAX_FILES');
const benchmarkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-embedding-benchmark-'));
const templateRoot = path.join(benchmarkRoot, 'template');
const contextRoots = {
  'fastembed-faiss': path.join(benchmarkRoot, 'contexts', 'fastembed'),
  'tei-faiss': path.join(benchmarkRoot, 'contexts', 'tei'),
};
const initialFast = await fastEmbedServiceStatus();
const initialTei = await teiServiceStatus();
const previousCacheSetting = process.env.DKB_EMBEDDING_CACHE;
let sequence = 0;

try {
  const corpus = await copySanitizedCorpus(sourceRoot, templateRoot);
  assert.ok(corpus.includedFiles >= Math.min(24, benchmarkFileLimit), `benchmark corpus contains only ${corpus.includedFiles} sanitized files`);
  assert.ok(corpus.includedBytes > 100_000, `benchmark corpus contains only ${corpus.includedBytes} sanitized bytes`);
  await writeJson(path.join(templateRoot, 'dkb.json'), {
    manifestVersion: 1,
    type: 'dkb',
    name: '@benchmark/assembly-toolbox',
    displayName: 'Embedding provider benchmark',
    version: '1.0.0',
    permissions: { read: true, write: false },
  });

  // Materialize the canonical Evidence Build once. This setup is deliberately
  // excluded from provider timings because both spaces consume identical
  // embedding-free Evidence IR.
  process.env.DKB_EMBEDDING_CACHE = '0';
  await ensureTeiService({}, false);
  await compileComposeProject(templateRoot, {
    force: true,
    mode: 'package',
    target: 'tei-faiss',
    contextRoot: contextRoots['tei-faiss'],
  });
  const evidence = await readEvidenceIr(templateRoot);
  assert.ok(evidence.evidence.length > 0, 'benchmark Evidence Build is empty');

  const providers = {};
  for (const target of ['fastembed-faiss', 'tei-faiss']) {
    providers[target] = await benchmarkTarget(target, evidence);
  }

  const fast = providers['fastembed-faiss'];
  const tei = providers['tei-faiss'];
  const freshImprovement = improvement(fast.fresh.medianWallMs, tei.fresh.medianWallMs);
  const throughputImprovement = improvement(fast.twoJob.medianRecordsPerSecond, tei.twoJob.medianRecordsPerSecond, true);
  const freshRegression = regression(fast.fresh.medianWallMs, tei.fresh.medianWallMs);
  const throughputRegression = regression(fast.twoJob.medianRecordsPerSecond, tei.twoJob.medianRecordsPerSecond, true);
  const performanceGate = (freshImprovement >= 0.20 && throughputRegression <= 0.10)
    || (throughputImprovement >= 0.30 && freshRegression <= 0.10);
  const queryGate = tei.query.p50Ms <= fast.query.p50Ms * 1.10;
  const memoryGate = tei.peakCombinedGiB <= 3.5;
  const report = {
    format: 'dkb.embedding-benchmark.v1',
    generatedAt: new Date().toISOString(),
    corpus: {
      scope: 'architecture',
      availableFiles: corpus.availableFiles,
      includedFiles: corpus.includedFiles,
      includedBytes: corpus.includedBytes,
      evidenceRecords: evidence.evidence.length,
      evidenceDigest: evidence.evidenceDigest,
      evidenceProfileDigest: evidence.evidenceProfileDigest,
    },
    runs,
    providers,
    comparison: {
      freshSingleWallTimeImprovement: freshImprovement,
      twoJobThroughputImprovement: throughputImprovement,
      freshSingleRegression: freshRegression,
      twoJobThroughputRegression: throughputRegression,
      queryLatencyRatio: tei.query.p50Ms / fast.query.p50Ms,
    },
    gates: {
      performance: performanceGate,
      queryLatency: queryGate,
      memory: memoryGate,
      eligibleForDefaultPromotion: performanceGate && queryGate && memoryGate,
    },
  };
  const output = process.env.DKB_BENCHMARK_OUTPUT?.trim();
  if (output) await writeJson(path.resolve(output), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (previousCacheSetting === undefined) delete process.env.DKB_EMBEDDING_CACHE;
  else process.env.DKB_EMBEDDING_CACHE = previousCacheSetting;
  if (!initialFast.running) await stopFastEmbedService().catch(() => undefined);
  if (!initialTei.running) await stopTeiService({}).catch(() => undefined);
  await fs.rm(benchmarkRoot, { recursive: true, force: true });
}

async function benchmarkTarget(target, evidence) {
  const contextRoot = contextRoots[target];
  await fs.mkdir(contextRoot, { recursive: true });
  const status = target === 'fastembed-faiss'
    ? await fastEmbedServiceStatus()
    : await teiServiceStatus();
  const container = status.container;
  const cold = [];
  for (let index = 0; index < runs; index += 1) {
    process.env.DKB_EMBEDDING_CACHE = '0';
    cold.push(await measured(async () => {
      if (target === 'fastembed-faiss') await ensureFastEmbedService({ restart: true });
      else await ensureTeiService({}, true);
      return compileOne(target, evidence, contextRoot);
    }, container));
  }

  if (target === 'fastembed-faiss') await ensureFastEmbedService();
  else await ensureTeiService({}, false);
  const fresh = [];
  process.env.DKB_EMBEDDING_CACHE = '0';
  for (let index = 0; index < runs; index += 1) fresh.push(await measured(() => compileOne(target, evidence, contextRoot), container));

  process.env.DKB_EMBEDDING_CACHE = '1';
  await fs.rm(path.join(contextRoot, '.dkb', 'cache', 'embeddings.sqlite'), { force: true });
  await compileOne(target, evidence, contextRoot);
  const cached = [];
  for (let index = 0; index < runs; index += 1) cached.push(await measured(() => compileOne(target, evidence, contextRoot), container));

  process.env.DKB_EMBEDDING_CACHE = '0';
  const twoJob = [];
  for (let index = 0; index < runs; index += 1) {
    twoJob.push(await measured(async () => {
      const [left, right] = await Promise.all([
        compileOne(target, evidence, contextRoot),
        compileOne(target, evidence, contextRoot),
      ]);
      return { recordCount: left.recordCount + right.recordCount };
    }, container));
  }
  const query = await benchmarkQueries(target, contextRoot);
  const all = [...cold, ...fresh, ...cached, ...twoJob];

  return {
    cold: summarize(cold),
    fresh: summarize(fresh),
    cached: summarize(cached),
    twoJob: {
      ...summarize(twoJob),
      medianRecordsPerSecond: median(twoJob.map((sample) => sample.recordCount / (sample.wallMs / 1_000))),
    },
    query,
    peakCombinedGiB: Math.max(...all.map((sample) => sample.peakCombinedBytes)) / (1024 ** 3),
  };
}

async function compileOne(target, evidence, contextRoot) {
  const root = path.join(benchmarkRoot, 'runs', `${target}-${sequence += 1}`);
  await copyPortableSource(templateRoot, root);
  try {
    return await compileRetrievalFromEvidence(root, evidence, { target, contextRoot });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function benchmarkQueries(target, contextRoot) {
  const host = await DkbProviderHost.create({ root: contextRoot, target, distribution: DEFAULT_DKB_DISTRIBUTION });
  try {
    const provider = host.provider('embedding');
    const options = host.optionsFor(host.config.target.embedding);
    await provider.embedQuery({ text: 'How does ModuleServiceProvider register ModuleManager?', options });
    const samples = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      await provider.embedQuery({ text: 'How does ModuleServiceProvider register ModuleManager?', options });
      samples.push(performance.now() - started);
    }
    return { p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), samplesMs: samples };
  } finally {
    await host.dispose();
  }
}

async function measured(operation, container) {
  let running = true;
  let peakCombinedBytes = process.memoryUsage().rss;
  const sampler = (async () => {
    while (running) {
      const containerBytes = await containerMemoryBytes(container).catch(() => 0);
      peakCombinedBytes = Math.max(peakCombinedBytes, process.memoryUsage().rss + containerBytes);
      await delay(200);
    }
  })();
  const started = performance.now();
  let result;
  try {
    result = await operation();
  } finally {
    running = false;
    await sampler;
  }
  return {
    wallMs: performance.now() - started,
    compilerMs: result.profile?.timingsMs?.total ?? null,
    recordCount: result.recordCount,
    peakCombinedBytes,
  };
}

function summarize(samples) {
  return {
    medianWallMs: median(samples.map((sample) => sample.wallMs)),
    medianCompilerMs: median(samples.map((sample) => sample.compilerMs).filter((value) => typeof value === 'number')),
    samples,
  };
}

async function containerMemoryBytes(container) {
  const { stdout } = await executeFile('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', container], {
    timeout: 10_000,
    windowsHide: true,
  });
  const value = stdout.split('/')[0]?.trim();
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)$/iu.exec(value ?? '');
  if (!match) return 0;
  const units = { b: 1, kb: 1_000, kib: 1024, mb: 1_000 ** 2, mib: 1024 ** 2, gb: 1_000 ** 3, gib: 1024 ** 3, tb: 1_000 ** 4, tib: 1024 ** 4 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

async function copyPortableSource(source, destination) {
  await fs.cp(source, destination, {
    recursive: true,
    filter: (candidate) => {
      const relative = path.relative(source, candidate).replace(/\\/gu, '/');
      return relative !== '.dkb' && !relative.startsWith('.dkb/');
    },
  });
}

async function copySanitizedCorpus(source, destination) {
  const roots = [path.join('app', 'Providers'), path.join('app', 'Services', 'Module'), 'routes', 'config'];
  const topLevel = ['composer.json'];
  const extensions = new Set(['.php', '.json', '.js', '.ts', '.vue', '.xml', '.yml', '.yaml', '.ini', '.conf']);
  const secretPath = /(^|\/)(?:\.env(?:\.|$)|auth\.json$|[^/]*(?:credential|private[-_]?key|oauth[-_]?key)[^/]*$)|\.(?:pem|p12|pfx|key|crt|cer)$/iu;
  const secretContent = [
    /-----BEGIN [^-]*PRIVATE KEY-----/u,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
    /\bAIza[0-9A-Za-z_-]{30,}\b/u,
    /\bgh[pousr]_[0-9A-Za-z]{30,}\b/u,
    /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/u,
    /\b(?:token|secret|password|api[_-]?key|client[_-]?secret)\b\s*(?:=>|=|:)\s*["'][^"'$\s][^"']{11,}["']/iu,
  ];
  const candidates = [
    ...await Promise.all(roots.map((relative) => listFiles(path.join(source, relative)))),
    ...topLevel.map((relative) => path.join(source, relative)),
  ].flat().sort((left, right) => left.localeCompare(right));
  const eligible = [];

  for (const candidate of candidates) {
    const relative = path.relative(source, candidate).replace(/\\/gu, '/');
    if (secretPath.test(relative) || !extensions.has(path.extname(candidate).toLowerCase())) continue;
    const contents = await fs.readFile(candidate);
    if (contents.length > 512 * 1024) continue;
    const text = contents.toString('utf8');
    if (text.includes('\uFFFD') || secretContent.some((pattern) => pattern.test(text))) continue;
    eligible.push({
      candidate,
      relative,
      contents,
      order: createHash('sha256').update(relative).digest('hex'),
    });
  }

  const selected = eligible
    .sort((left, right) => left.order.localeCompare(right.order) || left.relative.localeCompare(right.relative))
    .slice(0, benchmarkFileLimit);
  let includedBytes = 0;
  for (const { relative, contents } of selected) {
    const target = path.join(destination, 'sources', 'project', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
    includedBytes += contents.length;
  }
  return { availableFiles: eligible.length, includedFiles: selected.length, includedBytes };
}

async function listFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return listFiles(target);
    return entry.isFile() ? [target] : [];
  }));
  return nested.flat();
}

function improvement(baseline, candidate, higherIsBetter = false) {
  return higherIsBetter ? (candidate - baseline) / baseline : (baseline - candidate) / baseline;
}

function regression(baseline, candidate, higherIsBetter = false) {
  return Math.max(0, higherIsBetter ? (baseline - candidate) / baseline : (candidate - baseline) / baseline);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function required(value, label) {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
