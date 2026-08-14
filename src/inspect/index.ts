import fs from 'node:fs/promises';
import path from 'node:path';
import { readKrIndex } from '../indexes/knowledgeIndex.js';
import { loadDkb, loadManifest, loadRegistry } from '../protocol/manifest.js';
import { manifestPath } from '../protocol/paths.js';
import { deriveKnowledgeSpace } from '../protocol/space.js';
import type { DkbSourceManifest, DkrManifest, LoadedDkb } from '../protocol/types.js';
import { verifyComposeProject } from '../compiler/compile.js';

export async function inspectTarget(root: string) {
  const resolvedRoot = path.resolve(root);
  const manifestType = await exists(manifestPath(resolvedRoot, 'dkb.json')) ? 'dkb' : 'dkr';
  const registry = manifestType === 'dkr' ? await loadRegistry(resolvedRoot) : null;
  const manifest = registry?.manifest ?? await loadManifest(resolvedRoot);
  const dkbs = registry
    ? uniqueDkbs([...registry.collections.flatMap((collection) => collection.dkbs), ...registry.dkbs])
    : [await loadDkb(resolvedRoot)];
  const krIndex = await maybeReadKrIndex(resolvedRoot);
  const verification = await maybeVerify(resolvedRoot, manifestType);

  return {
    type: manifestType,
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
      krCount: krIndex.length,
      regionDescriptorCount: krIndex.length,
      compiled: await exists(manifestPath(resolvedRoot, 'dkb-lock.json')),
    },
    verification,
    warnings: warningsFor(dkbs, krIndex.length),
  };
}

async function maybeVerify(root: string, manifestType: string) {
  if (manifestType !== 'dkr' || !(await exists(manifestPath(root, 'dkb-lock.json')))) {
    return null;
  }

  return verifyComposeProject(root);
}

async function maybeReadKrIndex(root: string) {
  try {
    return await readKrIndex(root);
  } catch {
    return [];
  }
}

function warningsFor(dkbs: LoadedDkb[], krCount: number): string[] {
  const warnings: string[] = [];

  if (krCount === 0) {
    warnings.push('No compiled KR index records were found.');
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

type InspectManifest = DkbSourceManifest | DkrManifest;

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

function uniqueDkbs(dkbs: LoadedDkb[]): LoadedDkb[] {
  const seen = new Set<string>();

  return dkbs.filter((dkb) => {
    if (seen.has(dkb.manifest.id)) {
      return false;
    }

    seen.add(dkb.manifest.id);

    return true;
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}
