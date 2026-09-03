import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';

export const SYSTEM_BENCHMARK_FORMAT = 'dkb.system-benchmark.v1';
export const WORKLOAD = Object.freeze({
  search: { query: 'DENSE-0-0', marker: 'DENSE-0-0', limit: 10 },
  fetch: { operation: 'fetch', selection: 'first matching search Evidence ID' },
  insufficient: { query: 'qzxxnonexistent', limit: 10, expectedResults: 0 },
});
export const MEASUREMENT_SCOPE = Object.freeze({
  compile: 'full public compileComposeProject: source -> Evidence -> Retrieval, including disposal',
  queries: 'public searchRuntime/readRuntime: activation admission, retrieval, mandatory audit commit and observers',
  transport: 'in-process public Runtime API; excludes HTTP/MCP transport and LLM generation',
  serviceStartup: 'excluded; required services must already be healthy',
});
export const CACHE_POLICY = Object.freeze({
  source: 'fresh identical bytes and fixed mtimes per run',
  builds: 'absent at start; force full compilation',
  embedding: 'disabled through DKB_EMBEDDING_CACHE=0',
  providerModels: 'pre-existing services and operator-managed model caches; not a cold-model measurement',
  queries: 'same admitted Runtime per run, explicit untimed warmups; audit remains enabled',
});

export function digest(value) { return stableHash(value); }
export function median(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid timing samples');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(samples) {
  const completed = samples.filter((sample) => sample.status === 'completed');
  return {
    validRuns: completed.length,
    ...(completed.length ? {
      compileMedianMs: median(completed.map((sample) => sample.compile.wallMs)),
      queryMediansMs: Object.fromEntries(Object.keys(WORKLOAD).map((kind) => [kind,
        median(completed.map((sample) => median(sample.queries.filter((query) => query.kind === kind).map((query) => query.wallMs)))),
      ])),
    } : {}),
  };
}

function invalidReason(report) {
  if (report?.format !== SYSTEM_BENCHMARK_FORMAT) return 'unsupported report format';
  if (report.status !== 'completed' || !Array.isArray(report.samples) || report.samples.length < 3) return 'at least three completed full runs are required';
  if (!report.identity || report.identityDigest !== digest(report.identity)) return 'missing or changed comparison identity';
  if (digest(report.identity.scope) !== digest(MEASUREMENT_SCOPE) || digest(report.identity.cache) !== digest(CACHE_POLICY)) return 'measurement or cache scope differs';
  if (digest(report.identity.workload) !== digest(WORKLOAD)) return 'workload differs';
  if (!Number.isInteger(report.identity.querySamples) || report.identity.querySamples < 3) return 'at least three timed queries per kind are required';
  if (!Number.isInteger(report.identity.warmups) || report.identity.warmups < 1) return 'warmup evidence is missing';
  for (const sample of report.samples) {
    if (sample.status !== 'completed' || sample.identityDigest !== report.identityDigest || sample.compile?.cacheHit !== false) return 'failed, cached or identity-drifted run';
    if (!Number.isFinite(sample.compile.wallMs) || sample.compile.wallMs <= 0) return 'invalid full compile timing';
    if (!sample.compile.evidenceRecords || !sample.build?.evidenceDigest || !sample.build?.retrievalBuildDigest) return 'missing compiled build evidence';
    if (!sample.audit?.validated || sample.audit.terminalEvents !== (report.identity.querySamples + report.identity.warmups) * 3) return 'incomplete mandatory audit evidence';
    for (const kind of Object.keys(WORKLOAD)) {
      const timings = sample.queries?.filter((query) => query.kind === kind);
      if (timings?.length !== report.identity.querySamples || timings.some((query) => !Number.isFinite(query.wallMs) || query.wallMs <= 0 || !query.auditEventId)) return 'invalid completed Runtime query timings';
    }
  }
  return null;
}

export function compareSystemBenchmarks(current, baseline) {
  const invalid = invalidReason(current);
  if (invalid) return { status: 'not-evaluated', reason: `Current measurement is incomplete: ${invalid}.` };
  if (baseline === undefined) return { status: 'not-evaluated', reason: 'No comparable baseline supplied; this report establishes measurements, not a regression pass.' };
  const baselineInvalid = invalidReason(baseline);
  if (baselineInvalid) return { status: 'not-evaluated', reason: `Baseline rejected: ${baselineInvalid}.` };
  if (current.identityDigest !== baseline.identityDigest) return { status: 'not-evaluated', reason: 'Baseline corpus, workload, host, cache policy or exact provider/profile identity differs.' };
  const now = summarize(current.samples);
  const before = summarize(baseline.samples);
  const comparisons = [{ metric: 'compile', currentMs: now.compileMedianMs, baselineMs: before.compileMedianMs },
    ...Object.keys(WORKLOAD).map((kind) => ({ metric: kind, currentMs: now.queryMediansMs[kind], baselineMs: before.queryMediansMs[kind] }))]
    .map((entry) => ({ ...entry, ratio: entry.currentMs / entry.baselineMs, passed: entry.currentMs <= entry.baselineMs * 1.1 }));
  return { status: comparisons.every((entry) => entry.passed) ? 'passed' : 'failed', maximumRegressionPercent: 10, comparisons };
}

export function hostIdentity() {
  const cpus = os.cpus();
  return { platform: process.platform, release: os.release(), architecture: process.arch, node: process.version,
    cpuModels: [...new Set(cpus.map((cpu) => cpu.model))].sort(), logicalCpus: cpus.length, totalMemoryBytes: os.totalmem(),
    machineDigest: digest({ hostname: os.hostname(), platform: process.platform, architecture: process.arch }) };
}

export async function fileInventory(root) {
  const files = [];
  async function visit(relative) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Benchmark inventory cannot include links');
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(root, name));
        files.push({ path: name, bytes: bytes.length, hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
      }
    }
  }
  await visit('');
  return files;
}
