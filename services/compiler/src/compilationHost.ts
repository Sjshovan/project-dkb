import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { resolveProviderRetrievalProfile, type DkbResolvedRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';

/** Resolve and execute through the same job-scoped provider instances. */
export async function withCompilationHost<T>(
  options: Parameters<typeof DkbProviderHost.create>[0],
  operation: (host: DkbProviderHost, profile: DkbResolvedRetrievalProfile) => Promise<T>,
): Promise<T> {
  const host = await DkbProviderHost.create(options);
  let failed = false;
  try {
    return await operation(host, await resolveProviderRetrievalProfile(host));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await host.dispose(); }
    catch (error) {
      // Cleanup must not replace worker-stop uncertainty or the primary failure.
      if (!failed) throw error;
    }
  }
}
