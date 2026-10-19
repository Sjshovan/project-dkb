import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import type { DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import { resolveCliLibraryReference, withCliLibraryWriteContext, type CliLibraryReference } from './context.js';
import { dockerLibraryOwner } from '../host/libraryLocation.js';
import { libraryOwnerMutates, type LibraryOwnerCommand } from '../host/libraryOwnerContract.js';
import { readDockerLibraryCommand } from '../host/libraryOwnerResult.js';
import { refreshLibraryRuntimes, refreshServingLocalRuntimes, withRuntimeRefreshes, withManagedCleanupWarning } from '../runtime/refresh.js';

/** One context choice, existing domain operation, then host-owned Runtime refresh. */
export async function executeCliLibraryOperation<T extends object>(options: {
  library?: string;
  reference?: CliLibraryReference;
  command: LibraryOwnerCommand;
  input?: Record<string, unknown>;
  progress?: DkbProgressReporter;
  signal?: AbortSignal;
  runtimeClient?: (url: string) => Promise<Pick<DkbRuntimeClient, 'reload'>>;
  /** Explicit reload destination; never forwarded into the offline owner worker. */
  runtimeUrl?: string;
}, local: (root: string) => Promise<T>): Promise<T> {
  const mutation = libraryOwnerMutates(options.command);
  const reference = options.reference ?? await resolveCliLibraryReference({ explicit: options.library, allowUnavailableManifest: mutation });
  const result = reference.kind === 'docker'
    ? await readDockerLibraryCommand<T>(dockerLibraryOwner(reference.storage), options.command, options.input, { ...options, libraryName: reference.name })
    : mutation && options.command !== 'library.recover'
      ? await withCliLibraryWriteContext({ explicit: reference.path }, local)
      : await local(reference.path);
  if (!mutation || !options.runtimeClient || ('status' in result && result.status === 'unchanged')) return result;
  return refreshCliLibraryMutation(result, reference, options.runtimeClient, options.runtimeUrl);
}

/** A committed Library mutation stays successful when a Runtime cannot refresh. */
export async function refreshCliLibraryMutation<T extends object>(result: T, reference: CliLibraryReference,
  clientFor: (url: string) => Promise<Pick<DkbRuntimeClient, 'reload'>>, explicitUrl?: string): Promise<T> {
  const refreshes = reference.kind === 'docker'
    ? await refreshLibraryRuntimes(reference.name, clientFor)
    : await refreshServingLocalRuntimes(reference.path, clientFor);
  if (explicitUrl && !refreshes.some(item => item.url.replace(/\/+$/u, '') === explicitUrl.replace(/\/+$/u, ''))) {
    try {
      const reloaded = await (await clientFor(explicitUrl)).reload();
      refreshes.push(withManagedCleanupWarning({ name: 'explicit-runtime', url: explicitUrl, status: 'refreshed',
        message: 'Requested Runtime refreshed.' }, reloaded, 'dkb runtime refresh --url <runtime-url>'));
    } catch {
      // A supplied URL can contain sensitive input. The client validates it; do
      // not repeat it or transport diagnostics in a post-commit warning.
      refreshes.push({ name: 'explicit-runtime', url: '', status: 'stale',
        message: 'The requested Runtime could not refresh.', recovery: 'dkb runtime refresh --url <runtime-url>' });
    }
  }
  return withRuntimeRefreshes(result, refreshes);
}
