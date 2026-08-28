import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverLibraryEntries, loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import { readLibraryState } from './state.js';

export interface LibraryOverviewEntry {
  identity: string;
  kind: 'dkb' | 'collection';
  source: 'local' | 'registry';
  status: 'installed' | 'inactive' | 'broken' | 'untracked';
  version: string;
  path: string;
  requiredBy: string[];
  members?: Record<string, string>;
}

export async function inspectLibraryOverview(libraryRoot: string): Promise<{
  root: string;
  name: string;
  registryUrl: string | null;
  generation: number;
  roots: string[];
  counts: Record<'installed' | 'inactive' | 'broken' | 'untracked', number>;
  entries: LibraryOverviewEntry[];
}> {
  const root = path.resolve(libraryRoot);
  const manifest = await loadManifest(root);
  if (manifest.type !== 'library') throw new Error(`Not a DKB Library: ${root}`);
  const [direct, state, vendor] = await Promise.all([
    discoverLibraryEntries(root),
    readLibraryState(root),
    discoverVendorEntries(root),
  ]);
  const entries = new Map<string, LibraryOverviewEntry>();

  for (const item of [...direct, ...vendor]) {
    const applied = state.entries[item.manifest.name];
    entries.set(item.manifest.name, {
      identity: item.manifest.name,
      kind: item.manifest.type as 'dkb' | 'collection',
      source: item.source,
      status: applied?.status ?? (item.source === 'local' ? 'inactive' : 'untracked'),
      version: item.manifest.type === 'dkb'
        ? item.manifest.version!
        : typeof item.manifest.meta?.revision === 'number'
          ? `r${item.manifest.meta.revision}`
          : 'local',
      path: path.relative(root, item.root).replace(/\\/g, '/'),
      requiredBy: applied?.requiredBy ?? [],
      ...(item.manifest.type === 'collection' ? { members: item.manifest.members ?? {} } : {}),
    });
  }

  for (const applied of Object.values(state.entries)) {
    if (!entries.has(applied.identity)) {
      entries.set(applied.identity, {
        identity: applied.identity,
        kind: applied.kind,
        source: applied.source,
        status: 'broken',
        version: applied.version ?? (applied.revision ? `r${applied.revision}` : 'local'),
        path: applied.path,
        requiredBy: applied.requiredBy,
      });
    }
  }

  const sorted = [...entries.values()].sort((left, right) => left.identity.localeCompare(right.identity));
  const counts = { installed: 0, inactive: 0, broken: 0, untracked: 0 };
  for (const entry of sorted) counts[entry.status] += 1;

  return {
    root,
    name: manifest.name,
    registryUrl: manifest.registry?.url ?? null,
    generation: state.generation,
    roots: Object.keys(manifest.roots ?? {}).sort(),
    counts,
    entries: sorted,
  };
}

async function discoverVendorEntries(root: string) {
  const vendorRoot = path.join(root, 'vendor');
  const entries: Array<{
    root: string;
    source: 'registry';
    manifest: Awaited<ReturnType<typeof loadManifest>>;
  }> = [];

  try {
    for (const namespace of await fs.readdir(vendorRoot, { withFileTypes: true })) {
      if (!namespace.isDirectory() || !namespace.name.startsWith('@')) continue;
      const namespaceRoot = path.join(vendorRoot, namespace.name);
      for (const item of await fs.readdir(namespaceRoot, { withFileTypes: true })) {
        if (!item.isDirectory() || item.name.includes('.replace-')) continue;
        const entryRoot = path.join(namespaceRoot, item.name);
        try {
          const manifest = await loadManifest(entryRoot);
          if (manifest.type !== 'library') entries.push({ root: entryRoot, source: 'registry', manifest });
        } catch {
          // Invalid payloads are surfaced by doctor/health rather than hidden
          // as active knowledge.
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return entries;
}
