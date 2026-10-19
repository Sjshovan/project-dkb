// CLI cancellation must await container cleanup, not just kill the Docker client.
const active = new Set<AbortController>();

export async function withOwnerCancellation<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  active.add(controller);
  try { return await action(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal); }
  finally { active.delete(controller); }
}

export function cancelLibraryOwnerOperations(): boolean {
  for (const controller of active) controller.abort();
  return active.size > 0;
}
