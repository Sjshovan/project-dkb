import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import type { DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { resolveCliLibraryReference } from './context.js';
import { executeCliLibraryOperation } from './libraryOperation.js';
import { summarizeCollectionUninstall, summarizeLibrarySync, summarizeRemoveResult } from './summaries.js';

/** Both public removal commands keep their domain behavior in the owning environment. */
export async function removeCliKnowledge(options: {
  identity: string;
  library?: string;
  collectionOnly?: boolean;
  runtimeUrl?: string;
  progress?: DkbProgressReporter;
  runtimeClient: (url?: string) => Promise<Pick<DkbRuntimeClient, 'reload'>>;
}) {
  const identity = parseDkbIdentity(options.identity, 'Installed knowledge identity').identity;
  const reference = await resolveCliLibraryReference({ explicit: options.library, allowUnavailableManifest: true });
  const remove = async (libraryRoot: string) => {
    const { readLibraryState } = await import('@sjshovan/dkb-library/state.js');
    const entry = (await readLibraryState(libraryRoot)).entries[identity];
    if (options.collectionOnly || (entry?.kind === 'collection' && entry.source === 'registry')) {
      const { uninstallRegistryCollection } = await import('@sjshovan/dkb-runtime/runtime/collections.js');
      return uninstallRegistryCollection({ libraryRoot, collectionId: identity });
    }
    if (entry?.kind === 'collection') {
      const { removeLibraryRoot } = await import('@sjshovan/dkb-library/resolver.js');
      return removeLibraryRoot(libraryRoot, identity);
    }
    const { removeDkbFromLibrary } = await import('@sjshovan/dkb-runtime/runtime/state.js');
    return removeDkbFromLibrary(identity, libraryRoot, { progress: options.progress });
  };

  return executeCliLibraryOperation({ reference, command: options.collectionOnly ? 'collection.uninstall' : 'package.uninstall',
    input: { identity }, progress: options.progress, runtimeClient: options.runtimeClient, runtimeUrl: options.runtimeUrl }, remove);
}

export function summarizeKnowledgeRemoval(value: unknown): string[] {
  if (value && typeof value === 'object') {
    if ('collectionId' in value) return summarizeCollectionUninstall(value);
    if ('lock' in value) return summarizeLibrarySync(value);
  }
  return summarizeRemoveResult(value);
}
