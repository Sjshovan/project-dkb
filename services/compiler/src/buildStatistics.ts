import fs from 'node:fs/promises';
import path from 'node:path';
import type { DkbEvidenceIr } from '@dkb/protocol/evidence/ir.js';
import type { DkbArtifactManifest } from '@dkb/library/artifacts.js';
import { listPackageBuilds } from '@dkb/library/builds.js';

export interface DkbDistributionStatistics {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export interface DkbCorpusStatistics {
  sourceFiles: number;
  sourceBytes: number;
  sourceAssets: number;
  evidenceRecords: number;
  evidenceChunks: number;
  evidenceCharacters: number;
  evidenceTextBytes: number;
  textBytesPerRecord: DkbDistributionStatistics;
  recordsPerSource: DkbDistributionStatistics;
  densestSources: Array<{
    source: string;
    records: number;
    textBytes: number;
  }>;
}

export interface DkbBuildStorageStatistics {
  artifactFiles: number;
  artifactBytes: number;
  evidenceBuildBytes: number;
  retrievalBuildBytes: number;
  totalDerivedBytes: number;
  sourceToDerivedRatio: number | null;
  largestArtifacts: Array<{
    path: string;
    bytes: number;
  }>;
}

export interface DkbSourceStatistics {
  files: number;
  bytes: number;
}

export interface DkbCompilerDeliveryStatistics {
  corpus: Omit<DkbCorpusStatistics, 'textBytesPerRecord' | 'densestSources'>;
  storage: Omit<DkbBuildStorageStatistics, 'largestArtifacts'>;
  timingsMs: {
    collectState: number;
    aggregateArtifacts: number;
    total: number;
  };
}

/**
 * Keep HTTP compiler metadata bounded. Detailed source and artifact rankings
 * remain in the local build receipt; the Registry only needs stable aggregate
 * values for inspection and UI presentation.
 */
export function summarizeCompilerDeliveryStatistics(input: {
  corpus: DkbCorpusStatistics;
  storage: DkbBuildStorageStatistics;
  timingsMs: {
    collectState: number;
    aggregateArtifacts: number;
    total: number;
  };
}): DkbCompilerDeliveryStatistics {
  const { textBytesPerRecord: _textBytesPerRecord, densestSources: _densestSources, ...corpus } = input.corpus;
  const { largestArtifacts: _largestArtifacts, ...storage } = input.storage;

  return {
    corpus,
    storage,
    timingsMs: {
      collectState: input.timingsMs.collectState,
      aggregateArtifacts: input.timingsMs.aggregateArtifacts,
      total: input.timingsMs.total,
    },
  };
}

export function summarizeEvidenceCorpus(
  evidence: DkbEvidenceIr,
  source: DkbSourceStatistics,
): DkbCorpusStatistics {
  const textBytes = evidence.evidence.map((record) => Buffer.byteLength(record.text, 'utf8'));
  const bySource = new Map<string, { label: string; records: number; textBytes: number }>();

  for (let index = 0; index < evidence.evidence.length; index += 1) {
    const record = evidence.evidence[index]!;
    const current = bySource.get(record.assetId) ?? {
      label: sourceLabel(record.assetLocator, record.title, record.assetId),
      records: 0,
      textBytes: 0,
    };
    current.records += 1;
    current.textBytes += textBytes[index] ?? 0;
    bySource.set(record.assetId, current);
  }

  const sources = [...bySource.values()];

  return {
    sourceFiles: source.files,
    sourceBytes: source.bytes,
    sourceAssets: sources.length,
    evidenceRecords: evidence.evidence.length,
    evidenceChunks: evidence.chunks.length,
    evidenceCharacters: evidence.evidence.reduce((total, record) => total + record.text.length, 0),
    evidenceTextBytes: textBytes.reduce((total, value) => total + value, 0),
    textBytesPerRecord: distribution(textBytes),
    recordsPerSource: distribution(sources.map((item) => item.records)),
    densestSources: sources
      .sort((left, right) => right.records - left.records || right.textBytes - left.textBytes || left.label.localeCompare(right.label))
      .slice(0, 5)
      .map((item) => ({ source: item.label, records: item.records, textBytes: item.textBytes })),
  };
}

export async function summarizeBuildStorage(
  root: string,
  manifest: DkbArtifactManifest,
  sourceBytes: number,
): Promise<DkbBuildStorageStatistics> {
  const artifactBytes = manifest.files.reduce((total, file) => total + file.size, 0);
  const builds = await listPackageBuilds(root);
  const [evidenceBuildBytes, retrievalBuildBytes] = await Promise.all([
    sumUniqueDirectories(builds.evidence.filter((build) => build.active).map((build) => build.path)),
    sumUniqueDirectories(builds.retrieval.filter((build) => build.active).map((build) => build.path)),
  ]);
  const totalDerivedBytes = artifactBytes + evidenceBuildBytes + retrievalBuildBytes;

  return {
    artifactFiles: manifest.files.length,
    artifactBytes,
    evidenceBuildBytes,
    retrievalBuildBytes,
    totalDerivedBytes,
    sourceToDerivedRatio: sourceBytes > 0 ? round(totalDerivedBytes / sourceBytes, 3) : null,
    largestArtifacts: [...manifest.files]
      .sort((left, right) => right.size - left.size || left.path.localeCompare(right.path))
      .slice(0, 8)
      .map((file) => ({ path: file.path, bytes: file.size })),
  };
}

async function sumUniqueDirectories(paths: readonly string[]): Promise<number> {
  const sizes = await Promise.all([...new Set(paths)].map((target) => directorySize(target)));
  return sizes.reduce((total, value) => total + value, 0);
}

export function distribution(values: readonly number[]): DkbDistributionStatistics {
  if (values.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
    mean: round(total / sorted.length, 2),
  };
}

async function directorySize(root: string): Promise<number> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return directorySize(target);
    if (!entry.isFile()) return 0;
    return (await fs.stat(target)).size;
  }));

  return sizes.reduce((total, value) => total + value, 0);
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function sourceLabel(locator: Record<string, unknown>, title: string, fallback: string): string {
  for (const key of ['path', 'file', 'url', 'table']) {
    if (typeof locator[key] === 'string' && locator[key]) return locator[key];
  }
  return title || fallback;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
