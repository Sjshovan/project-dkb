import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { compileComposeProject } from '@dkb/compiler/compile.js';
import { estimateIngestionWorkingBytes } from '@dkb/compiler/diskCapacity.js';

const MEBIBYTE = 1024 ** 2;
const tiers = {
  smoke: { sourceBytes: 128 * 1024, files: 8 },
  small: { sourceBytes: 1 * MEBIBYTE, files: 24 },
  medium: { sourceBytes: 8 * MEBIBYTE, files: 80 },
  large: { sourceBytes: 32 * MEBIBYTE, files: 160 },
};
const selected = (process.env.DKB_SCALE_TIERS ?? 'smoke').split(',').map((value) => value.trim()).filter(Boolean);
const target = process.env.DKB_SCALE_TARGET ?? 'tei-faiss';
const maxProjectedMs = positiveNumber(process.env.DKB_SCALE_MAX_PROJECTED_MINUTES ?? '15', 'DKB_SCALE_MAX_PROJECTED_MINUTES') * 60_000;
const maxWorkingBytes = positiveNumber(process.env.DKB_SCALE_MAX_WORKING_BYTES ?? String(8 * 1024 ** 3), 'DKB_SCALE_MAX_WORKING_BYTES');
const benchmarkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-corpus-scale-'));
const results = [];

try {
  for (const name of selected) {
    const tier = tiers[name];
    if (!tier) throw new Error(`Unknown scale tier "${name}". Choose ${Object.keys(tiers).join(', ')}.`);
    const estimatedWorkingBytes = estimateIngestionWorkingBytes(tier.sourceBytes);
    if (estimatedWorkingBytes > maxWorkingBytes) {
      results.push({ tier: name, status: 'skipped', reason: 'working-set-limit', estimatedWorkingBytes });
      break;
    }
    const previous = results.findLast((result) => result.status === 'completed');
    if (previous) {
      const projectedMs = previous.wallMs * (tier.sourceBytes / previous.corpus.sourceBytes);
      if (projectedMs > maxProjectedMs) {
        results.push({ tier: name, status: 'skipped', reason: 'time-limit', projectedMs });
        break;
      }
    }

    const root = path.join(benchmarkRoot, name);
    const generated = await generateCorpus(root, name, tier);
    const started = performance.now();
    const compiled = await compileComposeProject(root, { force: true, mode: 'package', target, contextRoot: root });
    const wallMs = performance.now() - started;
    const statistics = compiled.profile?.statistics;
    assert.ok(statistics, `Compiler did not return scale statistics for ${name}`);
    assert.equal(statistics.corpus.sourceFiles, generated.files);
    assert.ok(statistics.corpus.evidenceRecords > 0, `${name} produced no Evidence records`);

    results.push({
      tier: name,
      status: 'completed',
      target,
      wallMs,
      corpus: statistics.corpus,
      storage: statistics.storage,
      timingsMs: compiled.profile.timingsMs,
      aggregateTimingsMs: compiled.profile.aggregateTimingsMs,
      diskCapacity: sanitizeDiskCapacity(statistics.diskCapacity),
    });
  }

  const report = {
    format: 'dkb.corpus-scale-benchmark.v1',
    generatedAt: new Date().toISOString(),
    target,
    boundaries: {
      maxProjectedMs,
      maxWorkingBytes,
      generatedCorpusRetained: false,
    },
    results,
  };
  const output = process.env.DKB_SCALE_OUTPUT?.trim();
  if (output) await writeJson(path.resolve(output), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await fs.rm(benchmarkRoot, { recursive: true, force: true });
}

async function generateCorpus(root, tierName, tier) {
  await fs.mkdir(path.join(root, 'sources'), { recursive: true });
  await writeJson(path.join(root, 'dkb.json'), {
    manifestVersion: 1,
    type: 'dkb',
    name: `@benchmark/dense-${tierName}`,
    displayName: `Dense ${tierName} scale corpus`,
    version: '1.0.0',
    permissions: { read: true, write: false },
  });
  const perFile = Math.ceil(tier.sourceBytes / tier.files);
  let bytes = 0;

  for (let index = 0; index < tier.files; index += 1) {
    const content = denseDocument(index, perFile);
    const targetPath = path.join(root, 'sources', `document-${String(index + 1).padStart(4, '0')}.md`);
    await fs.writeFile(targetPath, content, 'utf8');
    bytes += Buffer.byteLength(content, 'utf8');
  }

  return { files: tier.files, bytes };
}

function denseDocument(documentIndex, targetBytes) {
  const sections = [];
  let section = 0;
  while (Buffer.byteLength(sections.join('\n'), 'utf8') < targetBytes) {
    const marker = `DENSE-${documentIndex}-${section}`;
    sections.push(`## Operational section ${section}\n\n`
      + `The ${marker} workflow validates an immutable package receipt before activation. `
      + `Operators compare source identity, Evidence identity, and Retrieval compatibility so a dense document remains attributable after chunking. `
      + `This paragraph is deliberately substantive and unique to prevent an embedding cache from collapsing the scale test.\n\n`
      + `| Field | Value | Meaning |\n|---|---:|---|\n`
      + `| source | ${documentIndex} | Original document identity |\n`
      + `| section | ${section} | Dense table row and locator |\n`
      + `| checksum | ${documentIndex * 100_003 + section} | Deterministic synthetic provenance |\n\n`
      + '```ts\n'
      + `export const record_${documentIndex}_${section} = { marker: '${marker}', active: true, revision: ${section} };\n`
      + '```\n\n'
      + `- ${marker} preserves citations.\n- ${marker} rejects incompatible vectors.\n- ${marker} remains searchable after installation.\n`);
    section += 1;
  }
  return `# Dense benchmark document ${documentIndex}\n\n${sections.join('\n')}`;
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function sanitizeDiskCapacity(capacity) {
  return {
    ...(capacity.ingestion ? { ingestion: withoutPath(capacity.ingestion) } : {}),
    retrieval: capacity.retrieval.map(withoutPath),
  };
}

function withoutPath({ path: _path, ...capacity }) {
  return capacity;
}
