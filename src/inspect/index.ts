import fs from 'node:fs/promises';
import path from 'node:path';
import { readSourceIndex } from '../indexes/sourceIndex.js';
import { loadCollection, loadDkb, loadLibrary, loadManifest, uniqueLoadedDkbs } from '../protocol/manifest.js';
import { artifactLockPath } from '../protocol/paths.js';
import { deriveKnowledgeSpace } from '../protocol/space.js';
import type { DkbManifest, DkbSourceManifest, DkcManifest, DkrManifest, LoadedDkb } from '../protocol/types.js';
import { verifyComposeProject } from '../compiler/compile.js';

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
  const sourceIndex = await maybeReadSourceIndex(resolvedRoot);
  const verification = await maybeVerify(resolvedRoot, sourceManifest.type);

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
      chunkCount: sourceIndex.units.length,
      sourceAssetCount: sourceIndex.assets.length,
      compiled: await exists(artifactLockPath(resolvedRoot)),
    },
    verification,
    warnings: warningsFor(dkbs, sourceIndex.units.length),
  };
}

async function maybeVerify(root: string, manifestType: string) {
  if (manifestType !== 'library' || !(await exists(artifactLockPath(root)))) {
    return null;
  }

  return verifyComposeProject(root);
}

async function maybeReadSourceIndex(root: string) {
  try {
    return await readSourceIndex(root);
  } catch {
    return { assets: [], units: [], edges: [] };
  }
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

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}
