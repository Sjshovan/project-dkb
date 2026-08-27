import { DkbError } from '@dkb/protocol/errors.js';
import { parseDkbIdentity } from '@dkb/protocol/identity.js';
import { discoverLibraryEntries, loadManifest } from '@dkb/protocol/manifest.js';
import { DkbRegistryClient, type DkbRegistryCollectionRevision, type DkbRegistryRelease } from './client.js';

export async function publishCollectionFromLibrary(options: {
  collectionPath: string;
  libraryRoot: string;
  client: DkbRegistryClient;
  visibility?: 'public' | 'private' | 'unlisted';
}): Promise<DkbRegistryCollectionRevision> {
  const manifest = await loadManifest(options.collectionPath);
  if (manifest.type !== 'collection') throw new DkbError(`Publish target is not a Collection: ${options.collectionPath}`);

  const collectionIdentity = parseDkbIdentity(manifest.name, 'Collection identity');
  const localEntries = new Map((await discoverLibraryEntries(options.libraryRoot)).map((entry) => [entry.manifest.name, entry]));
  const members: Array<{ id: string; version: string }> = [];

  for (const [identity, selector] of Object.entries(manifest.members ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    const parsed = parseDkbIdentity(identity, `Collection ${manifest.name} member`);
    let release: DkbRegistryRelease;

    try {
      release = await options.client.packageRelease(identity, selector === 'latest' ? undefined : selector);
    } catch (error) {
      const local = localEntries.get(identity);
      if (parsed.namespace !== collectionIdentity.namespace || !local || local.manifest.type !== 'dkb') {
        const detail = error instanceof Error ? ` Registry response: ${error.message}` : '';
        throw new DkbError(
          `Collection member ${identity}@${selector} is not published. `
          + (parsed.namespace === collectionIdentity.namespace
            ? `No editable local DKB named ${identity} exists in this Library.`
            : `Foreign namespace @${parsed.namespace} must publish it first.`)
          + detail,
        );
      }
      if (selector !== 'latest' && selector !== local.manifest.version) {
        throw new DkbError(`Local ${identity}@${local.manifest.version} cannot satisfy Collection selector ${selector}.`);
      }
      await options.client.publish({
        sourcePath: local.root,
        visibility: options.visibility === 'public' ? 'public' : 'private',
      });
      release = await options.client.packageRelease(identity, selector === 'latest' ? undefined : selector);
    }
    members.push({ id: release.packageId, version: release.version });
  }

  if (members.length === 0) throw new DkbError(`Collection ${manifest.name} has no members to publish.`);

  return options.client.publishCollection({
    id: manifest.name,
    name: manifest.displayName ?? manifest.name,
    description: manifest.description,
    visibility: options.visibility ?? 'private',
    members,
  });
}
