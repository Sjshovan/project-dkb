import fs from 'node:fs/promises';
import path from 'node:path';
import { registryCollectionDigest } from '@sjshovan/dkb-protocol/registryCollections.js';

export function collectionSnapshot(id, revision, fixtures, name = 'Synthetic Collection') {
  const members = fixtures.map(fixture => ({ id: fixture.plan.package.id, version: fixture.plan.package.version,
    digest: fixture.plan.artifacts[0].receipt.payload.packageTreeHash })).sort((a, b) => a.id < b.id ? -1 : 1);
  const snapshot = { type: 'collection', id, name, revision, members };
  const digest = registryCollectionDigest(snapshot);
  return { collectionId: id, revision, digest, manifest: { ...snapshot, digest } };
}

/** Public fixture metadata can cross the crash-test child boundary; no signing secrets. */
export function collectionClient({ revision, keys, fixtures = [], baseUrl = 'https://registry.example.test' }) {
  return {
    baseUrl,
    async collectionRevision() { return revision; },
    async publicKeys() { return { keys }; },
    async installPlan(id, version) {
      const fixture = fixtures.find(item => item.plan.package.id === id && item.plan.package.version === version);
      if (!fixture) throw new Error(`Missing signed fixture ${id}@${version}`);
      return fixture.plan;
    },
    async writeInstallLayer(artifact, destination) {
      const fixture = fixtures.find(item => item.plan.artifacts.some(layer => layer.digest === artifact.digest));
      if (!fixture?.root) throw new Error('Retained exact members must not be downloaded');
      const file = artifact.kind === 'source' ? 'source.dkbpkg' : `${artifact.kind}.archive`;
      await fs.copyFile(path.join(fixture.root, file), destination);
    },
  };
}
