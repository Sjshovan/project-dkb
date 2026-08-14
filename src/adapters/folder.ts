import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DkbError } from '../protocol/errors.js';
import { resolveFrom } from '../protocol/paths.js';
import type { DkbEvidence, KnowledgeRegion, KnowledgeSourceUnit, LoadedDkb } from '../protocol/types.js';
import { tokenize } from '../router/scoring.js';
import { sourceUnitsFromKnowledgeRegion } from '../indexes/sourceIndex.js';
import { assertNoSymlinkPath, readInertTextFile, renderUntrustedSourceBlock, resolveContainedSourcePath } from '../security/sourceContent.js';
import type { DkbCompileRegionsInput, DkbCompileSourceUnitsInput, DkbExecuteReadPlanInput, DkbReader, DkbReadPlanResult, DkbWriter } from './adapter.js';

interface FileRegionInput {
  file: string;
  root: string;
  dkb: LoadedDkb;
  storeId: string;
  parentRegionId?: string;
  siblingRegionIds?: string[];
}

interface FolderRegionInput {
  directory: string;
  files: string[];
  root: string;
  dkb: LoadedDkb;
  storeId: string;
  parentRegionId?: string;
  childRegionIds: string[];
  siblingRegionIds?: string[];
}

interface CompiledFileStats {
  file: string;
  hash: string;
  stat: Stats;
  parsed: KnowledgeRegion | null;
  indexText: string | null;
  sourceText: string | null;
}

const MAX_FILE_INDEX_CHARS = 1600;
const MAX_FOLDER_FILE_INDEX_CHARS = 900;
const MAX_FOLDER_INDEX_CHARS = 5200;
const GENERIC_INDEX_TOKENS = new Set([
  'about',
  'adapter',
  'also',
  'been',
  'direct',
  'file',
  'files',
  'folder',
  'from',
  'have',
  'into',
  'knowledge',
  'region',
  'source',
  'sources',
  'table',
  'tables',
  'that',
  'their',
  'there',
  'these',
  'this',
  'with',
]);

export class FolderAdapter implements DkbReader, DkbWriter {
  async readRecords(dkb: LoadedDkb): Promise<KnowledgeRegion[]> {
    return this.compileRegions({
      dkb,
      store: {
        id: dkb.manifest.stores?.[0]?.id ?? 'root',
        type: 'filesystem',
        path: dkb.manifest.entrypoint,
        mode: 'read',
      },
    });
  }

  async compileSourceUnits(input: DkbCompileSourceUnitsInput) {
    const regions = await this.compileRegions(input);

    return regions.flatMap(sourceUnitsFromKnowledgeRegion);
  }

  async compileRegions({ dkb, store }: DkbCompileRegionsInput) {
    if (!store.path) {
      throw new DkbError(`Filesystem store ${store.id} requires path`);
    }

    const root = resolveFrom(dkb.root, store.path);

    await assertNoSymlinkPath(await fs.realpath(dkb.root), root);

    const stats = await fs.stat(root);

    if (stats.isFile()) {
      return [await buildFileRegion({ file: root, root, dkb, storeId: store.id })];
    }

    const directFilesByDirectory = await directFilesByDirectoryFor(root, excludedSourcePathsFor(store), dkb.root);
    const directoryRegions = [...directFilesByDirectory.keys()].sort((a, b) => a.localeCompare(b));
    const regionIdByDirectory = new Map(directoryRegions.map((directory) => [directory, folderRegionId(dkb.root, directory)]));
    const childDirectoriesByParent = childDirectoriesByParentFor(directoryRegions);
    const records = [];

    for (const directory of directoryRegions) {
      const files = directFilesByDirectory.get(directory) ?? [];
      const parentDirectory = path.dirname(directory);
      const siblingRegionIds = (childDirectoriesByParent.get(parentDirectory) ?? [])
        .filter((candidate) => candidate !== directory)
        .map((candidate) => regionIdByDirectory.get(candidate))
        .filter((candidate): candidate is string => Boolean(candidate));
      const childRegionIds = (childDirectoriesByParent.get(directory) ?? [])
        .map((candidate) => regionIdByDirectory.get(candidate))
        .filter((candidate): candidate is string => Boolean(candidate));
      const parentRegionId = directory === root ? undefined : regionIdByDirectory.get(parentDirectory);

      records.push(await buildFolderRegion({
        directory,
        files,
        root,
        dkb,
        storeId: store.id,
        parentRegionId,
        childRegionIds,
        siblingRegionIds,
      }));
    }

    return records;
  }

  async executeReadPlan({ dkb, store, record, query, sourceUnits }: DkbExecuteReadPlanInput): Promise<DkbReadPlanResult> {
    if (!store.path) {
      return blocked(query, 'missing_connection', `Filesystem store ${store.id} has no path`, { storeId: store.id });
    }

    const selectedChunks = (sourceUnits ?? [])
      .filter((unit) => typeof unit.assetLocator.path === 'string' || typeof unit.locator.path === 'string');
    const selectedPaths = selectedChunks
      .map((unit) => unit.assetLocator.path ?? unit.locator.path)
      .filter((item): item is string => typeof item === 'string');
    const sourcePath = typeof record.sourceRef?.locator.path === 'string' ? record.sourceRef.locator.path : null;
    const sourcePaths = Array.isArray(record.sourceRef?.locator.paths)
      ? record.sourceRef.locator.paths.filter((item): item is string => typeof item === 'string')
      : [];

    if (selectedPaths.length === 0 && !sourcePath && sourcePaths.length === 0) {
      return blocked(query, 'source_unavailable', `Filesystem target has no path locator: ${dkb.manifest.id}/${record.id}`, { target: record.id });
    }

    const locatorPaths = sourcePaths.length > 0 ? sourcePaths : sourcePath ? [sourcePath] : [];
    const invalidLocatorPath = await firstInvalidContainedPath(dkb.root, store.path, locatorPaths);

    if (invalidLocatorPath) {
      return blocked(query, 'permission_denied', `Filesystem source path is outside its declared store: ${invalidLocatorPath}`, {
        adapter: 'filesystem',
        dkbId: dkb.manifest.id,
        storeId: store.id,
        path: invalidLocatorPath,
        sourceSafety: 'path_containment_failed',
      });
    }

    if (selectedChunks.length > 0) {
      const reads = [];
      const skipped = [];

      for (const item of selectedPaths) {
        const resolved = await resolveContainedSourcePath({
          dkbRoot: dkb.root,
          storePath: store.path,
          sourcePath: item,
        });

        if (!resolved) {
          return blocked(query, 'permission_denied', `Filesystem source path is outside its declared store: ${item}`, {
            adapter: 'filesystem',
            dkbId: dkb.manifest.id,
            storeId: store.id,
            path: item,
            sourceSafety: 'path_containment_failed',
          });
        }

        const read = await readInertTextFile(resolved);

        if (!read) {
          skipped.push({
            path: item,
            reason: 'not_inert_text',
          });

          continue;
        }

        reads.push({
          path: item,
          bytesRead: read.bytesRead,
          truncated: read.truncated,
        });
      }

      const readablePaths = new Set(reads.map((read) => read.path));
      const selectedReadableChunks = selectedChunks.filter((unit) => readablePaths.has(String(unit.assetLocator.path ?? unit.locator.path)));

      if (selectedReadableChunks.length === 0) {
        return blocked(query, 'source_unavailable', 'No readable inert text chunks were available for the filesystem target.', {
          adapter: 'filesystem',
          dkbId: dkb.manifest.id,
          storeId: store.id,
          skipped,
          sourceSafety: 'inert_text_required',
        });
      }

      const excerptBudget = Math.max(1000, Math.min((query.limit ?? 1) * 4000, 12000));
      const text = selectedReadableChunks
        .sort((left, right) => String(left.assetLocator.path ?? left.locator.path).localeCompare(String(right.assetLocator.path ?? right.locator.path))
          || left.chunkOrdinal - right.chunkOrdinal)
        .map((unit, index) => `Source chunk ${index + 1}\n${unit.text}`)
        .join('\n\n')
        .slice(0, excerptBudget);
      const evidence: DkbEvidence = {
        type: 'text',
        label: record.title,
        text: renderUntrustedSourceBlock(text),
        source: record.sourceRef!,
      };

      return complete(query, [evidence], {
        adapter: 'filesystem',
        dkbId: dkb.manifest.id,
        storeId: store.id,
        chunksRead: selectedReadableChunks.length,
        pathsRead: [...readablePaths].sort((left, right) => left.localeCompare(right)),
        filesScanned: reads.length,
        bytesRead: reads.reduce((sum, read) => sum + read.bytesRead, 0),
        truncated: reads.some((read) => read.truncated),
        skipped,
        sourceSafety: 'inert_text_only',
        sourceSelection: 'source.index.chunks',
      });
    }

    const paths = selectedPaths.length > 0 ? selectedPaths : sourcePaths.length > 0 ? sourcePaths : sourcePath ? [sourcePath] : [];
    const readLimit = Math.max(1, Math.min(query.limit ?? record.queryable?.defaultLimit ?? 20, record.queryable?.maxLimit ?? 100));
    const scanLimit = Math.max(1, Math.min(paths.length, record.queryable?.maxLimit ?? 100));
    const reads = [];
    const skipped = [];

    for (const item of paths.slice(0, scanLimit)) {
      const resolved = await resolveContainedSourcePath({
        dkbRoot: dkb.root,
        storePath: store.path!,
        sourcePath: item,
      });

      if (!resolved) {
        return blocked(query, 'permission_denied', `Filesystem source path is outside its declared store: ${item}`, {
          adapter: 'filesystem',
          dkbId: dkb.manifest.id,
          storeId: store.id,
          path: item,
          sourceSafety: 'path_containment_failed',
        });
      }

      const read = await readInertTextFile(resolved);

      if (!read) {
        skipped.push({
          path: item,
          reason: 'not_inert_text',
        });

        continue;
      }

      reads.push({
        path: item,
        raw: read.raw,
        bytesRead: read.bytesRead,
        truncated: read.truncated,
        text: extractKnowledgeText(read.raw),
      });
    }

    const selectedReads = filterReads(reads, query).slice(0, readLimit);

    if (reads.length === 0 || selectedReads.length === 0) {
      if (reads.length > 0) {
        return complete(query, [], {
          adapter: 'filesystem',
          dkbId: dkb.manifest.id,
          storeId: store.id,
          filesScanned: reads.length,
          bytesRead: reads.reduce((sum, read) => sum + read.bytesRead, 0),
          truncated: reads.some((read) => read.truncated),
          skipped,
          sourceSafety: 'inert_text_only',
          reason: 'no_matching_source_items',
        });
      }

      return blocked(query, 'source_unavailable', 'No readable inert text sources were available for the filesystem target.', {
        adapter: 'filesystem',
        dkbId: dkb.manifest.id,
        storeId: store.id,
        skipped,
        sourceSafety: 'inert_text_required',
      });
    }

    const excerptBudget = Math.max(1000, Math.min((query.limit ?? 1) * 4000, 12000));
    const text = selectedReads
      .map((read, index) => `Source item ${index + 1}\n${read.text}`)
      .join('\n\n')
      .slice(0, excerptBudget);
    const evidence: DkbEvidence = {
      type: 'text',
      label: record.title,
      text: renderUntrustedSourceBlock(text),
      source: record.sourceRef!,
    };

    return complete(query, [evidence], {
      adapter: 'filesystem',
      dkbId: dkb.manifest.id,
      storeId: store.id,
      pathsRead: selectedReads.map((read) => read.path),
      filesScanned: reads.length,
      bytesRead: selectedReads.reduce((sum, read) => sum + read.bytesRead, 0),
      truncated: selectedReads.some((read) => read.truncated),
      skipped,
      sourceSafety: 'inert_text_only',
    });
  }

  async appendRecord(dkb: LoadedDkb, record: KnowledgeRegion): Promise<KnowledgeRegion> {
    const directory = resolveFrom(dkb.root, dkb.manifest.entrypoint);
    const target = path.join(directory, `${safeFileStem(record.id)}.json`);

    await fs.mkdir(directory, { recursive: true });

    try {
      await fs.writeFile(target, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      throw new DkbError(`Unable to append folder record at ${target}: ${reason}`);
    }

    return {
      ...record,
      source: record.source || target,
    };
  }
}

async function readRecord(sourcePath: string, sourceName: string): Promise<KnowledgeRegion> {
  const value = JSON.parse(await fs.readFile(sourcePath, 'utf8')) as Partial<KnowledgeRegion> & { metadata?: Record<string, unknown> };

  if (!value.id || !value.title || !value.content) {
    throw new DkbError(`Invalid folder record at ${sourcePath}: id, title, and content are required`);
  }

  const topics = normalizeStringArray(value.topics ?? value.metadata?.topics ?? value.metadata?.topic);
  const entities = normalizeStringArray(value.entities ?? value.metadata?.entities ?? value.metadata?.entity);
  const updatedAt = typeof value.updatedAt === 'string'
    ? value.updatedAt
    : typeof value.metadata?.updatedAt === 'string'
      ? value.metadata.updatedAt
      : null;

  if (topics.length === 0 || entities.length === 0 || !updatedAt) {
    throw new DkbError(`Invalid folder record at ${sourcePath}: topics, entities, and updatedAt are required`);
  }

  return {
    id: value.id,
    title: value.title,
    content: value.content,
    source: value.source || sourceName,
    topics,
    entities,
    updatedAt,
    aliases: normalizeStringArray(value.aliases ?? value.metadata?.aliases),
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))].sort((a, b) => a.localeCompare(b));
  }

  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function safeFileStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function maybeReadRecord(sourcePath: string): Promise<KnowledgeRegion | null> {
  if (!sourcePath.endsWith('.json')) {
    return null;
  }

  try {
    return await readRecord(sourcePath, path.basename(sourcePath));
  } catch {
    return null;
  }
}

async function buildFileRegion(input: FileRegionInput): Promise<KnowledgeRegion & { dkbId: string; storeIds: string[] }> {
  const relative = path.relative(input.dkb.root, input.file).replace(/\\/g, '/');
  const hash = await hashFile(input.file);
  const parsed = await maybeReadRecord(input.file);
  const sourceText = parsed?.content ?? await maybeReadSourceText(input.file);
  const indexText = sourceText ? normalizeIndexText(sourceText) : null;
  const fallbackTitle = path.basename(input.file);
  const fallbackSummary = `Filesystem file region at ${relative}`;
  const source = parsed?.source || relative;
  const content = indexText
    ? `${fallbackSummary}. ${summarizeIndexText(indexText, MAX_FILE_INDEX_CHARS)}`
    : fallbackSummary;
  const ancestry = ancestryFor(input.dkb.root, input.file);

  return {
    id: parsed?.id ?? `file:${relative}`,
    dkbId: input.dkb.manifest.id,
    title: parsed?.title ?? fallbackTitle,
    content,
    source,
    topics: parsed?.topics?.length
      ? parsed.topics
      : unique([...(input.dkb.manifest.domains ?? []), ...pathTokens(relative), ...indexTokens(indexText ?? '')]).slice(0, 48),
    entities: parsed?.entities?.length ? parsed.entities : unique([fallbackTitle]),
    updatedAt: parsed?.updatedAt ?? (await fs.stat(input.file)).mtime.toISOString(),
    aliases: unique([...(parsed?.aliases ?? []), relative, dotAlias(relative)]),
    regionType: parsed ? 'record' : 'file',
    parentRegionId: input.parentRegionId,
    relatedRegionIds: input.siblingRegionIds ?? [],
    ancestry,
    relationships: relationshipsFor(input.parentRegionId, [], input.siblingRegionIds ?? []),
    grouping: {
      strategy: parsed ? 'json_record' : 'single_source',
      reason: parsed ? 'JSON source defines one adapter-bounded Knowledge Region.' : 'Single file source compiles into one adapter-bounded file region.',
    },
    sourceRef: {
      storeId: input.storeId,
      type: 'filesystem',
      locator: {
        path: relative,
      },
      hash,
    },
    queryable: {
      operations: ['fetch', 'search'],
      fields: filesystemQueryableFields(),
      defaultLimit: 1,
      maxLimit: 20,
    },
    sourceUnits: [{
      locator: {
        path: relative,
      },
      title: parsed?.title ?? fallbackTitle,
      text: sourceText ?? content,
      keywords: unique([
        ...(parsed?.topics ?? []),
        ...(parsed?.entities ?? []),
        ...indexTokens(indexText ?? ''),
      ]).slice(0, 32),
      hash,
      updatedAt: parsed?.updatedAt ?? (await fs.stat(input.file)).mtime.toISOString(),
    }],
    storeIds: [input.storeId],
  };
}

async function buildFolderRegion(input: FolderRegionInput): Promise<KnowledgeRegion & { dkbId: string; storeIds: string[] }> {
  const relativeDirectory = path.relative(input.dkb.root, input.directory).replace(/\\/g, '/') || '.';
  const relativeFiles = input.files.map((file) => path.relative(input.dkb.root, file).replace(/\\/g, '/'));
  const fileStats = await Promise.all(input.files.map((file) => compiledFileStatsFor(file)));
  const latestMtime = fileStats
    .map((item) => item.stat.mtimeMs)
    .reduce((max, value) => Math.max(max, value), 0);
  const title = path.basename(input.directory) || input.dkb.manifest.name;
  const parsedTopics = fileStats.flatMap((item) => item.parsed?.topics ?? []);
  const parsedEntities = fileStats.flatMap((item) => item.parsed?.entities ?? []);
  const summaries = fileStats.map((item, index) => {
    const parsed = item.parsed;
    const relative = relativeFiles[index];
    const indexText = parsed?.content ?? item.indexText;

    return indexText
      ? `${relative}: ${summarizeIndexText(indexText, MAX_FOLDER_FILE_INDEX_CHARS)}`
      : `${relative}: filesystem source`;
  });
  const content = [
    `Filesystem folder region ${relativeDirectory} with direct files: ${relativeFiles.map((file) => path.basename(file)).join(', ')}.`,
    summaries.join(' '),
  ].join(' ').slice(0, MAX_FOLDER_INDEX_CHARS);
  const ancestry = ancestryFor(input.dkb.root, input.directory);
  const regionHash = stableFolderHash(relativeDirectory, fileStats.map((item, index) => ({
    path: relativeFiles[index],
    hash: item.hash,
  })));

  return {
    id: folderRegionId(input.dkb.root, input.directory),
    dkbId: input.dkb.manifest.id,
    title,
    content,
    source: relativeDirectory,
    topics: unique([
      ...(input.dkb.manifest.domains ?? []),
      ...pathTokens(relativeDirectory),
      ...fileStats.flatMap((item) => indexTokens(item.indexText ?? '')),
      ...parsedTopics,
    ]).slice(0, 64),
    entities: unique([...relativeFiles.map((file) => path.basename(file)), ...parsedEntities]),
    updatedAt: latestMtime > 0 ? new Date(latestMtime).toISOString() : regionHash,
    aliases: unique([relativeDirectory, dotAlias(relativeDirectory)]),
    regionType: 'folder',
    parentRegionId: input.parentRegionId,
    childRegionIds: input.childRegionIds,
    relatedRegionIds: input.siblingRegionIds ?? [],
    ancestry,
    relationships: relationshipsFor(input.parentRegionId, input.childRegionIds, input.siblingRegionIds ?? []),
    grouping: {
      strategy: 'filesystem_direct_files',
      reason: 'Direct files in the same filesystem folder compile into one adapter-bounded Knowledge Region.',
    },
    sourceRef: {
      storeId: input.storeId,
      type: 'filesystem',
      locator: {
        path: relativeDirectory,
        paths: relativeFiles,
      },
      hash: regionHash,
    },
    queryable: {
      operations: ['fetch', 'search'],
      fields: filesystemQueryableFields(),
      defaultLimit: Math.min(relativeFiles.length, 20),
      maxLimit: Math.max(20, relativeFiles.length),
    },
    sourceUnits: folderSourceUnits(relativeFiles, fileStats),
    storeIds: [input.storeId],
  };
}

function folderSourceUnits(relativeFiles: string[], fileStats: CompiledFileStats[]): KnowledgeSourceUnit[] {
  return fileStats.map((item, index) => {
    const relative = relativeFiles[index]!;
    const title = item.parsed?.title ?? path.basename(relative);
    const text = item.sourceText ?? item.indexText ?? `${relative}: filesystem source`;

    return {
      locator: {
        path: relative,
      },
      title,
      text,
      keywords: unique([
        ...(item.parsed?.topics ?? []),
        ...(item.parsed?.entities ?? []),
        ...pathTokens(relative),
        ...indexTokens(text),
      ]).slice(0, 32),
      hash: item.hash,
      updatedAt: item.parsed?.updatedAt ?? item.stat.mtime.toISOString(),
    };
  });
}

async function compiledFileStatsFor(file: string): Promise<CompiledFileStats> {
  const parsed = await maybeReadRecord(file);

  return {
    file,
    hash: await hashFile(file),
    stat: await fs.stat(file),
    parsed,
    sourceText: parsed?.content ?? await maybeReadSourceText(file),
    indexText: parsed?.content ?? await maybeReadIndexableText(file),
  };
}

async function directFilesByDirectoryFor(root: string, excludedSourcePaths = new Set<string>(), dkbRoot = root): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const realRoot = await fs.realpath(root);

  async function visit(directory: string): Promise<void> {
    await assertNoSymlinkPath(realRoot, directory);

    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => !isDkbSystemArtifact(entry.name));
    const entryPaths = entries.map((entry) => path.join(directory, entry.name));

    for (const entryPath of entryPaths) {
      await assertNoSymlinkPath(realRoot, entryPath);
    }

    const fileEntries = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(directory, entry.name))
      .filter((file) => !excludedSourcePaths.has(path.relative(dkbRoot, file).replace(/\\/g, '/')))
      .sort((a, b) => a.localeCompare(b));

    if (fileEntries.length > 0) {
      result.set(directory, fileEntries);
    }

    await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => visit(path.join(directory, entry.name))));
  }

  await visit(root);

  return result;
}

function excludedSourcePathsFor(store: DkbCompileRegionsInput['store']): Set<string> {
  const claimed = store.meta?.claimedByAdapters;

  return Array.isArray(claimed)
    ? new Set(claimed.filter((item): item is string => typeof item === 'string'))
    : new Set();
}

function isDkbSystemArtifact(name: string): boolean {
  return name === '.dkb' || name === 'dkb-lock.json' || name === 'dkb-release.json' || name === '.dkb-package.json';
}

function childDirectoriesByParentFor(directories: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const directory of directories) {
    const parent = path.dirname(directory);
    const children = result.get(parent);

    if (children) {
      children.push(directory);
    } else {
      result.set(parent, [directory]);
    }
  }

  return result;
}

function folderRegionId(dkbRoot: string, directory: string): string {
  const relative = path.relative(dkbRoot, directory).replace(/\\/g, '/') || '.';

  return `folder:${relative}`;
}

function ancestryFor(dkbRoot: string, target: string): string[] {
  const relative = path.relative(dkbRoot, target).replace(/\\/g, '/');
  const parts = relative.split('/').filter(Boolean);
  const folderParts = (path.extname(target) ? parts.slice(0, -1) : parts);

  return folderParts.map((_, index) => folderParts.slice(0, index + 1).join('/'));
}

function relationshipsFor(parentRegionId: string | undefined, childRegionIds: string[], siblingRegionIds: string[]): NonNullable<KnowledgeRegion['relationships']> {
  const relationships: NonNullable<KnowledgeRegion['relationships']> = [];

  if (parentRegionId) {
    relationships.push({ type: 'parent', regionId: parentRegionId });
  }

  relationships.push(...childRegionIds.map((regionId) => ({ type: 'child' as const, regionId })));
  relationships.push(...siblingRegionIds.map((regionId) => ({ type: 'sibling' as const, regionId })));

  return relationships;
}

function dotAlias(value: string): string {
  return value.replace(/[\\/]+/g, '.').replace(/\s+/g, '-');
}

function stableFolderHash(directory: string, files: Array<{ path: string; hash: string }>): string {
  const hash = createHash('sha256');

  hash.update(JSON.stringify({
    directory,
    files,
  }));

  return `sha256:${hash.digest('hex')}`;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');

  hash.update(await fs.readFile(file));

  return `sha256:${hash.digest('hex')}`;
}

function pathTokens(value: string): string[] {
  return value
    .split(/[\\/._\-\s]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 1);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function maybeReadIndexableText(file: string): Promise<string | null> {
  try {
    const read = await readInertTextFile(file);

    if (!read) {
      return null;
    }

    const text = normalizeIndexText(extractKnowledgeText(read.raw));

    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function maybeReadSourceText(file: string): Promise<string | null> {
  try {
    const read = await readInertTextFile(file);

    if (!read) {
      return null;
    }

    const text = extractKnowledgeText(read.raw)
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();

    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function summarizeIndexText(value: string, maxChars: number): string {
  const text = normalizeIndexText(value);

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars).trim()}...`;
}

function normalizeIndexText(value: string): string {
  return value
    .replace(/\r/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function firstInvalidContainedPath(dkbRoot: string, storePath: string, sourcePaths: string[]): Promise<string | null> {
  for (const sourcePath of sourcePaths) {
    const resolved = await resolveContainedSourcePath({
      dkbRoot,
      storePath,
      sourcePath,
    });

    if (!resolved) {
      return sourcePath;
    }
  }

  return null;
}

function indexTokens(value: string): string[] {
  return pathTokens(value)
    .filter((token) => token.length > 2 && !GENERIC_INDEX_TOKENS.has(token))
    .slice(0, 96);
}

function extractKnowledgeText(raw: string): string {
  try {
    const value = JSON.parse(raw) as { content?: unknown };

    if (typeof value.content === 'string') {
      return value.content;
    }
  } catch {
    // Non-JSON files are first-class filesystem knowledge sources.
  }

  return raw;
}

function filesystemQueryableFields(): NonNullable<KnowledgeRegion['queryable']>['fields'] {
  return {
    id: {
      type: 'string',
      operators: ['equals', 'contains'],
      searchable: true,
      returnable: true,
    },
    title: {
      type: 'string',
      operators: ['equals', 'contains'],
      searchable: true,
      returnable: true,
    },
    content: {
      type: 'string',
      operators: ['equals', 'contains'],
      searchable: true,
      returnable: true,
    },
  };
}

function filterReads<T extends { raw: string; text: string; path: string }>(reads: T[], query: DkbExecuteReadPlanInput['query']): T[] {
  const filters = query.filters ?? [];

  if (query.operation === 'fetch' || filters.length === 0) {
    return reads;
  }

  return reads
    .map((read) => ({
      read,
      score: filters.reduce((total, filter) => total + filterMatchScore(read, filter), 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.read.path.localeCompare(right.read.path))
    .map((item) => item.read);
}

function filterMatchScore<T extends { raw: string; text: string; path: string }>(
  read: T,
  filter: NonNullable<DkbExecuteReadPlanInput['query']['filters']>[number],
): number {
    const value = filter.field === 'content'
      ? `${read.raw}\n${read.text}`
      : filter.field === 'title' || filter.field === 'id'
        ? read.path
        : '';
    const normalized = value.toLowerCase();
    const filterValue = String(filter.value).toLowerCase();

    if (filter.op === 'contains') {
      if (normalized.includes(filterValue)) {
        return 100;
      }

      const tokens = tokenize(filterValue).filter((token) => token.length > 2);
      const readTokens = new Set(tokenize(normalized));
      const matched = tokens.filter((token) => readTokens.has(token)).length;
      const minimum = Math.max(1, Math.ceil(tokens.length * 0.35));

      if (matched < minimum) {
        return 0;
      }

      return matched + phraseBonus(tokens, normalized);
    }

    if (filter.op === 'equals') {
      return normalized === filterValue ? 100 : 0;
    }

    return 0;
}

function phraseBonus(tokens: string[], normalized: string): number {
  let score = 0;

  for (let size = Math.min(4, tokens.length); size >= 2; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phrase = tokens.slice(index, index + size).join(' ');

      if (normalized.includes(phrase)) {
        score += size * 5;
      }
    }
  }

  return score;
}

function complete(query: DkbExecuteReadPlanInput['query'], evidence: DkbEvidence[], trace: Record<string, unknown>): DkbReadPlanResult {
  return {
    id: query.id,
    target: query.target,
    status: 'complete',
    reason: null,
    message: 'DKB read query completed.',
    evidence,
    trace,
  };
}

function blocked(query: DkbExecuteReadPlanInput['query'], reason: DkbReadPlanResult['reason'], message: string, trace: Record<string, unknown>): DkbReadPlanResult {
  return {
    id: query.id || 'unknown',
    target: query.target || '',
    status: 'blocked',
    reason,
    message,
    evidence: [],
    trace,
  };
}
