import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCollection, loadDkb, loadLibrary, loadManifest, uniqueLoadedDkbs } from '@sjshovan/dkb-protocol/manifest.js';
import { deriveKnowledgeSpace } from '@sjshovan/dkb-protocol/space.js';
import type { DkbManifest, DkbSourceManifest, DkcManifest, DkrManifest, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import { validatePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';
import { readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';

export async function inspectTarget(root: string) {
  const resolvedRoot = path.resolve(root);
  const sourceManifest = await loadManifest(resolvedRoot);
  let manifest: InspectManifest;
  let dkbs: LoadedDkb[];

  if (sourceManifest.type === 'library') {
    const library = await loadLibrary(resolvedRoot);
    manifest = library.manifest;
    dkbs = uniqueLoadedDkbs([
      ...library.collections.flatMap((collection) => collection.dkbs),
      ...library.dkbs,
    ]);
  } else if (sourceManifest.type === 'collection') {
    const collection = await loadCollection(resolvedRoot);
    manifest = collection.manifest;
    dkbs = collection.dkbs;
  } else {
    const dkb = await loadDkb(resolvedRoot);
    manifest = dkb.manifest;
    dkbs = [dkb];
  }
  const compiled = await compiledCatalogs(dkbs);
  const verification = await maybeVerify(dkbs);

  return {
    type: sourceManifest.type,
    root: resolvedRoot,
    id: idFor(manifest),
    name: nameFor(manifest),
    version: versionFor(manifest),
    space: deriveKnowledgeSpace({
      owner: 'owner' in manifest ? manifest.owner : undefined,
      namespace: manifest.namespace,
      appId: manifest.appId,
      registryId: idFor(manifest),
    }),
    dkbs: dkbs.map((dkb) => ({
      id: dkb.manifest.id,
      name: dkb.manifest.name,
      version: dkb.manifest.version,
      adapter: dkb.manifest.adapter,
      stores: (dkb.manifest.stores ?? []).map((store) => ({
        id: store.id,
        type: store.type,
        path: store.path,
        connectionRef: store.connectionRef,
        mode: store.mode ?? 'read',
        permissions: {
          read: store.permissions?.read ?? dkb.manifest.permissions?.read ?? true,
          write: store.permissions?.write ?? dkb.manifest.permissions?.write ?? false,
        },
      })),
      permissions: dkb.manifest.permissions,
      domains: dkb.manifest.domains,
      roles: dkb.manifest.roles ?? [],
      space: deriveKnowledgeSpace({
        owner: dkb.manifest.owner,
        namespace: dkb.manifest.namespace,
        appId: dkb.manifest.appId,
        registryId: idFor(manifest),
        dkbId: dkb.manifest.id,
      }),
      write: dkb.manifest.write ?? null,
    })),
    indexes: {
      chunkCount: compiled.records,
      sourceAssetCount: compiled.assets,
      compiled: verification?.ok ?? false,
    },
    verification,
    warnings: warningsFor(dkbs, compiled.records),
  };
}

async function maybeVerify(dkbs: LoadedDkb[]) {
  if (dkbs.length === 0) return null;
  const checks = await Promise.all(dkbs.map(async (dkb) => {
    try {
      const graph = await validatePackageBuildGraph(dkb.root);
      return { name: dkb.manifest.id, ok: true, detail: graph.retrieval.retrievalBuildDigest };
    } catch (error) {
      return { name: dkb.manifest.id, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { ok: checks.every((check) => check.ok), checks };
}

async function compiledCatalogs(dkbs: LoadedDkb[]): Promise<{ assets: number; records: number }> {
  const catalogs = await Promise.all(dkbs.map(async (dkb) => {
    try {
      const graph = await validatePackageBuildGraph(dkb.root);
      return readEvidenceCatalog(graph.evidencePath);
    } catch {
      return null;
    }
  }));
  return {
    assets: catalogs.reduce((total, catalog) => total + (catalog?.assets.length ?? 0), 0),
    records: catalogs.reduce((total, catalog) => total + (catalog?.records.length ?? 0), 0),
  };
}

function warningsFor(dkbs: LoadedDkb[], chunkCount: number): string[] {
  const warnings: string[] = [];

  if (chunkCount === 0) {
    warnings.push('No compiled chunk records were found.');
  }

  for (const dkb of dkbs) {
    if (!dkb.manifest.owner?.id) {
      warnings.push(`DKB ${dkb.manifest.id} has no owner id.`);
    }

    if (dkb.manifest.permissions?.write === true && !dkb.manifest.write) {
      warnings.push(`DKB ${dkb.manifest.id} declares write permission without a write protocol.`);
    }
  }

  return warnings;
}

type InspectManifest = DkbManifest | DkbSourceManifest | DkcManifest | DkrManifest;

function idFor(manifest: InspectManifest): string {
  return 'id' in manifest ? manifest.id : safeId(manifest.name);
}

function nameFor(manifest: InspectManifest): string {
  return manifest.name;
}

function versionFor(manifest: InspectManifest): string {
  return manifest.version ?? '0.0.0-local';
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'dkb';
}
