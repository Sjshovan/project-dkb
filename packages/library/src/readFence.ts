import { assertLibraryReadFence, captureLibraryReadFence } from './mutation.js';

/** Inspections never recover implicitly, including on missing-file and rollback races. */
export async function withLibraryReadFence<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const fence = await captureLibraryReadFence(root);
  try { return await operation(); }
  finally { await assertLibraryReadFence(root, fence); }
}

/** Drain sibling filesystem reads before an inspection releases its final fence. */
export async function allLibraryReads<T extends readonly unknown[] | []>(inputs: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const results = await Promise.allSettled(inputs);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
}
