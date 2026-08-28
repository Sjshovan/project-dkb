import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbEvidence, DkbRecord, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import { chunkSourceUnit } from '@sjshovan/dkb-providers-bundled/chunking.js';
import { capabilitiesForSourceType, type IndexedSourceUnit } from '@sjshovan/dkb-providers-bundled/sourceIndex.js';
import { assertNoSymlinkPath, readInertTextFile, renderUntrustedSourceBlock } from '@sjshovan/dkb-protocol/security/sourceContent.js';
import type { DkbCompileSourceUnitsInput, DkbExecuteReadPlanInput, DkbReader, DkbReadPlanResult, DkbWriter } from './adapter.js';
import { blocked, complete } from './sqlShared.js';

export class FolderAdapter implements DkbReader, DkbWriter {
  async readRecords(_dkb: LoadedDkb): Promise<DkbRecord[]> {
    return [];
  }

  async compileSourceUnits({ dkb, store }: DkbCompileSourceUnitsInput): Promise<IndexedSourceUnit[]> {
    if (!store.path) {
      throw new DkbError(`Filesystem store ${store.id} requires path`);
    }

    const root = resolveFrom(dkb.root, store.path);
    const dkbRoot = await fs.realpath(dkb.root);

    await assertNoSymlinkPath(dkbRoot, root);

    const files = (await fs.stat(root)).isFile()
      ? [root]
      : await listSafeFiles(root, dkb.root, store.meta?.includePaths, store.meta?.claimedByAdapters);
    const chunks = (await Promise.all(files.map((file) => fileChunks(file, dkb, store.id)))).flat();

    return chunks.sort((left, right) => left.id.localeCompare(right.id));
  }

  async executeReadPlan({ query, sourceUnits }: DkbExecuteReadPlanInput): Promise<DkbReadPlanResult> {
    const chunks = sourceUnits ?? [];

    if (chunks.length === 0) {
      return blocked(query, 'no_results', 'No compiled chunks were selected for filesystem evidence.', {});
    }

    const text = chunks
      .sort((left, right) => left.assetId.localeCompare(right.assetId) || left.chunkOrdinal - right.chunkOrdinal)
      .map((unit, index) => `Source chunk ${index + 1}\n${unit.text}`)
      .join('\n\n')
      .slice(0, Math.max(1000, Math.min((query.limit ?? 1) * 4000, 12000)));
    const first = chunks[0]!;
    const evidence: DkbEvidence = {
      type: 'text',
      label: first.title,
      text: renderUntrustedSourceBlock(text),
      source: {
        storeId: first.storeId,
        type: first.type,
        locator: first.locator,
        hash: first.hash,
      },
    };

    return complete(query, [evidence], {
      adapter: 'filesystem',
      dkbId: first.dkbId,
      storeId: first.storeId,
      chunksRead: chunks.length,
      sourceSelection: 'compiled-chunks',
    });
  }

  async appendRecord(dkb: LoadedDkb, record: DkbRecord): Promise<DkbRecord> {
    const directory = resolveFrom(dkb.root, dkb.manifest.entrypoint);
    const target = path.join(directory, `${record.id.replace(/[^a-zA-Z0-9._-]/g, '-')}.json`);

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });

    return {
      ...record,
      source: record.source || target,
    };
  }
}

async function fileChunks(file: string, dkb: LoadedDkb, storeId: string): Promise<IndexedSourceUnit[]> {
  const relative = path.relative(dkb.root, file).replace(/\\/g, '/');
  const stat = await fs.stat(file);
  const read = await readInertTextFile(file);
  const text = read?.raw ?? '';
  const title = path.basename(file);
  const sourceHash = await hashFile(file);
  const chunks = chunkSourceUnit({
    dkbId: dkb.manifest.id,
    storeId,
    type: 'filesystem',
    unit: {
      locator: { path: relative },
      title,
      text: text || `${relative}: filesystem source`,
      keywords: keywordsFor(`${relative} ${text}`),
      hash: sourceHash,
      updatedAt: stat.mtime.toISOString(),
    },
    fallbackTitle: title,
    fallbackUpdatedAt: stat.mtime.toISOString(),
  });

  return chunks.map((chunk) => ({
    ...chunk,
    dkbId: dkb.manifest.id,
    storeId,
    type: 'filesystem' as const,
    assetLocator: { path: relative },
    capabilities: capabilitiesForSourceType('filesystem'),
  }));
}

async function listSafeFiles(root: string, dkbRoot: string, includeValue: unknown, excludeValue: unknown): Promise<string[]> {
  const include = arraySet(includeValue);
  const exclude = arraySet(excludeValue);
  const realRoot = await fs.realpath(root);
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    await assertNoSymlinkPath(realRoot, directory);

    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (isSystemEntry(entry.name)) {
        continue;
      }

      const target = path.join(directory, entry.name);
      const relative = path.relative(dkbRoot, target).replace(/\\/g, '/');

      await assertNoSymlinkPath(realRoot, target);

      if (exclude?.has(relative) || (include && !include.has(relative) && ![...include].some((item) => item.startsWith(`${relative}/`)))) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && (!include || include.has(relative))) {
        files.push(target);
      }
    }
  }

  await visit(root);

  return files.sort((left, right) => left.localeCompare(right));
}

function arraySet(value: unknown): Set<string> | null {
  return Array.isArray(value)
    ? new Set(value.filter((item): item is string => typeof item === 'string'))
    : null;
}

function isSystemEntry(name: string): boolean {
  return name.startsWith('.')
    || name === 'dkb-lock.json'
    || name === 'dkb-profile.lock.json'
    || name === 'dkb-release.json';
}

function keywordsFor(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
    .flatMap((token) => token.includes('-') ? [token, ...token.split('-')] : [token])
    .filter((token) => token.length > 2 && !GENERIC_KEYWORDS.has(token)))]
    .slice(0, 32);
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');

  hash.update(await fs.readFile(file));

  return `sha256:${hash.digest('hex')}`;
}

const GENERIC_KEYWORDS = new Set([
  'and',
  'are',
  'for',
  'from',
  'into',
  'source',
  'sources',
  'that',
  'the',
  'this',
  'with',
]);
