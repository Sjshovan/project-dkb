import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadDkb } from '@sjshovan/dkb-protocol/manifest.js';
import { runPluginConformance } from '@sjshovan/dkb-pipeline/testing.js';
import { EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN } from '@sjshovan/dkb-evidence-docling-llamaindex/plugin.js';
import {
  compilerServiceStatus,
  startLlamaIndexCompilerService,
  stopLlamaIndexCompilerService,
} from '@sjshovan/dkb-evidence-docling-llamaindex/compiler.js';
import { FASTEMBED_PLUGIN } from '@sjshovan/dkb-embedding-fastembed/plugin.js';
import {
  ensureFastEmbedService,
  fastEmbedServiceStatus,
  stopFastEmbedService,
} from '@sjshovan/dkb-embedding-fastembed/service.js';
import { TEI_PLUGIN } from '@sjshovan/dkb-embedding-tei/plugin.js';
import {
  ensureTeiService,
  stopTeiService,
  teiServiceStatus,
} from '@sjshovan/dkb-embedding-tei/tei.js';
import { FAISS_PLUGIN } from '@sjshovan/dkb-index-faiss/plugin.js';
import { FAISS_PROVIDER_IMAGE } from '@sjshovan/dkb-index-faiss/faissStore.js';
import { MEILISEARCH_PLUGIN } from '@sjshovan/dkb-index-meilisearch/plugin.js';
import { HYBRID_RETRIEVAL_PLUGIN } from '@sjshovan/dkb-retrieval-hybrid/plugin.js';

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environmentNames = [
  'DKB_FAISS_DOCKER_IMAGE',
  'DKB_FAISS_SERVICE_URL',
  'DKB_LLAMA_COMPILER_SERVICE_ROOT',
  'DKB_LLAMA_COMPILER_SERVICE_URL',
  'DKB_QUERY_EMBEDDER_URL',
  'DKB_TEI_URL',
  'MEILI_MASTER_KEY',
  'MEILI_URL',
];
const savedEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
const requiredChecks = {
  '@dkb/evidence-docling-llamaindex': [
    'evidence health',
    'evidence cancellation',
    'Evidence output and provenance',
    'Evidence deterministic output',
  ],
  '@dkb/embedding-fastembed': [
    'embedding health',
    'embedding cancellation',
    'Document and query vector compatibility',
  ],
  '@dkb/embedding-tei': [
    'embedding health',
    'embedding cancellation',
    'Document and query vector compatibility',
  ],
  '@dkb/index-faiss': [
    'index health',
    'index cancellation',
    'packaged index lifecycle',
  ],
  '@dkb/index-meilisearch': [
    'index health',
    'index cancellation',
    'managed index lifecycle',
  ],
  '@dkb/retrieval-hybrid': [
    'retrieval cancellation',
    'Retrieval Runtime and result validation',
  ],
};
const reports = [];
const cleanupErrors = [];
let proofRoot;
let meilisearchContainer;
let meilisearchSecret;
let outcome;

try {
  await requireDockerEngine();
  proofRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-conformance-'));
  const fixtureRoot = path.join(proofRoot, 'fixture');
  await writeFixture(fixtureRoot);
  const dkb = await loadDkb(fixtureRoot);

  delete process.env.DKB_LLAMA_COMPILER_SERVICE_URL;
  delete process.env.DKB_QUERY_EMBEDDER_URL;
  delete process.env.DKB_TEI_URL;
  delete process.env.DKB_FAISS_SERVICE_URL;
  process.env.DKB_FAISS_DOCKER_IMAGE = FAISS_PROVIDER_IMAGE;

  reports.push(await withService({
    label: 'Evidence worker',
    status: () => compilerServiceStatus(),
    start: async () => {
      process.env.DKB_LLAMA_COMPILER_SERVICE_ROOT = path.join(proofRoot, 'evidence-service');
      return startLlamaIndexCompilerService();
    },
    stop: () => stopLlamaIndexCompilerService(),
    run: () => conform(EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN, { root: fixtureRoot, dkb }),
  }));

  reports.push(await withService({
    label: 'FastEmbed service',
    status: () => fastEmbedServiceStatus(),
    start: () => ensureFastEmbedService(),
    stop: () => stopFastEmbedService(),
    run: () => conform(FASTEMBED_PLUGIN),
  }));

  reports.push(await withService({
    label: 'TEI service',
    status: () => teiServiceStatus(),
    start: () => ensureTeiService(),
    stop: () => stopTeiService(),
    run: () => conform(TEI_PLUGIN),
  }));

  await ensureDockerImage(FAISS_PROVIDER_IMAGE, path.join(repositoryRoot, 'providers', 'index-faiss', 'python'));
  reports.push(await conform(FAISS_PLUGIN));

  const meilisearch = await startDisposableMeilisearch();
  meilisearchContainer = meilisearch.container;
  meilisearchSecret = meilisearch.secret;
  process.env.MEILI_URL = meilisearch.url;
  process.env.MEILI_MASTER_KEY = meilisearch.secret;
  reports.push(await conform(MEILISEARCH_PLUGIN));

  reports.push(await conform(HYBRID_RETRIEVAL_PLUGIN));

  outcome = {
    ok: true,
    proof: 'bundled-provider-conformance',
    plugins: reports.map(summarizeReport),
  };
} catch (error) {
  outcome = {
    ok: false,
    proof: 'bundled-provider-conformance',
    error: redact(message(error)),
    recovery: dockerRecovery(error),
  };
} finally {
  if (meilisearchContainer) {
    await removeProofContainer(meilisearchContainer).catch((error) => cleanupErrors.push(redact(message(error))));
  }
  restoreEnvironment();
  if (proofRoot) {
    await fs.rm(proofRoot, { recursive: true, force: true }).catch((error) => cleanupErrors.push(redact(message(error))));
  }
}

if (cleanupErrors.length > 0) {
  outcome = outcome?.ok
    ? {
        ok: false,
        proof: 'bundled-provider-conformance',
        error: 'Provider conformance passed but disposable resource cleanup failed',
        recovery: 'Resolve the reported cleanup errors before rerunning npm.cmd run proof:providers.',
      }
    : outcome;
}
outcome = { ...outcome, cleanupErrors };
const output = `${JSON.stringify(outcome, null, 2)}\n`;
if (outcome.ok) process.stdout.write(output);
else {
  process.stderr.write(output);
  process.exitCode = 1;
}

async function conform(plugin, fixture = {}) {
  const report = await runPluginConformance(plugin, fixture);
  const required = requiredChecks[plugin.id] ?? [];
  const failures = report.checks.filter((check) => check.status === 'failed');
  const missing = required.filter((name) => report.checks.find((check) => check.name === name)?.status !== 'passed');
  if (!report.ok || failures.length > 0 || missing.length > 0) {
    throw new Error(`${plugin.id} conformance failed: ${JSON.stringify({ failures, requiredChecksNotPassed: missing })}`);
  }
  return report;
}

async function withService(input) {
  const initial = await input.status();
  if (initial.running && !initial.ready) {
    throw new Error(`${input.label} is already running but unhealthy; repair or stop it before running the bundled provider proof`);
  }
  const startedByProof = !initial.running;
  let report;
  let failure;
  try {
    if (!initial.ready) {
      const started = await input.start();
      if (!started.ready) throw new Error(`${input.label} did not become ready`);
    }
    report = await input.run();
  } catch (error) {
    failure = error;
  }
  if (startedByProof) {
    try {
      await input.stop();
    } catch (error) {
      const detail = redact(`${input.label}: ${message(error)}`);
      cleanupErrors.push(detail);
      failure ??= new Error(`Unable to clean up ${input.label}: ${detail}`);
    }
  }
  if (failure) throw failure;
  return report;
}

async function requireDockerEngine() {
  try {
    const result = await execFile('docker', ['info', '--format', '{{json .ServerVersion}}'], {
      timeout: 30_000,
      windowsHide: true,
    });
    if (!result.stdout.trim() || result.stdout.trim() === '""') throw new Error('Docker did not report a server version');
  } catch (error) {
    const failure = new Error(`Docker Desktop Linux engine is unavailable: ${message(error)}`);
    failure.code = 'docker_unavailable';
    throw failure;
  }
}

async function ensureDockerImage(image, context) {
  try {
    await execFile('docker', ['image', 'inspect', image], { timeout: 30_000, windowsHide: true });
    return;
  } catch {
    await execFile('docker', ['build', '--pull', '--tag', image, context], {
      timeout: 20 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
  }
}

async function startDisposableMeilisearch() {
  const container = `dkb-provider-conformance-meili-${randomUUID()}`;
  const secret = randomBytes(32).toString('base64url');
  await execFile('docker', [
    'run', '-d',
    '--name', container,
    '--label', 'org.dkb.proof=bundled-provider-conformance',
    '-p', '127.0.0.1::7700',
    '-e', 'MEILI_MASTER_KEY',
    '-e', 'MEILI_ENV=development',
    'getmeili/meilisearch:v1.29',
  ], {
    env: { ...process.env, MEILI_MASTER_KEY: secret, MEILI_ENV: 'development' },
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  meilisearchContainer = container;
  const portOutput = await execFile('docker', ['port', container, '7700/tcp'], { timeout: 30_000, windowsHide: true });
  const port = parseLoopbackPort(portOutput.stdout);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return { container, secret, url };
    } catch {
      // The disposable service is still starting.
    }
    await delay(250);
  }
  throw new Error(`Disposable Meilisearch service ${container} did not become healthy`);
}

async function removeProofContainer(container) {
  if (!/^dkb-provider-conformance-meili-[0-9a-f-]+$/u.test(container)) {
    throw new Error(`Refusing to remove unexpected container ${container}`);
  }
  try {
    await execFile('docker', ['rm', '-f', container], { timeout: 30_000, windowsHide: true });
  } catch (error) {
    if (!/No such (container|object)/iu.test(message(error))) throw error;
  }
}

async function writeFixture(root) {
  await fs.mkdir(path.join(root, 'sources'), { recursive: true });
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1,
    type: 'dkb',
    name: '@dkb/conformance-bundled',
    displayName: 'Bundled Provider Conformance',
    version: '1.0.0',
    permissions: { read: true, write: false },
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    path.join(root, 'sources', 'knowledge.md'),
    '# Bundled Provider Conformance\n\nMarker CONFORMANCE-SOURCE-31 verifies real Evidence, embedding, index, and retrieval provider behavior.\n',
    'utf8',
  );
}

function summarizeReport(report) {
  return {
    id: report.plugin.id,
    version: report.plugin.version,
    registrations: report.registrations,
    passed: report.checks.filter((check) => check.status === 'passed').length,
    skipped: report.checks.filter((check) => check.status === 'skipped').map((check) => ({ name: check.name, detail: check.detail })),
  };
}

function parseLoopbackPort(value) {
  const match = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/u.exec(value);
  if (!match) throw new Error(`Docker did not publish a loopback Meilisearch port: ${value.trim()}`);
  return Number.parseInt(match[1], 10);
}

function restoreEnvironment() {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function redact(value) {
  return meilisearchSecret ? value.replaceAll(meilisearchSecret, '[REDACTED]') : value;
}

function dockerRecovery(error) {
  return error && typeof error === 'object' && error.code === 'docker_unavailable'
    ? 'Start Docker Desktop and rerun npm.cmd run proof:providers.'
    : 'Review the failed provider check, repair its reported service or contract, and rerun npm.cmd run proof:providers.';
}

function message(error) {
  if (error && typeof error === 'object' && 'stderr' in error) {
    return `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
