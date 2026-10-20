/** One owner disposes each registered object at most once, including rollback. */
export class RegistrationDisposer {
  private readonly disposed = new WeakSet<object>();

  async dispose(resource: unknown): Promise<void> {
    if ((typeof resource !== 'object' || resource === null) && typeof resource !== 'function') return;
    const object = resource as object;
    if (this.disposed.has(object)) return;
    this.disposed.add(object);
    const dispose = (resource as { dispose?: unknown }).dispose;
    if (typeof dispose === 'function') await Reflect.apply(dispose, resource, []);
  }

  async disposeAll(resources: readonly unknown[]): Promise<void> {
    // Cleanup failure must never replace the original setup/admission error.
    await Promise.allSettled(resources.map((resource) => this.dispose(resource)));
  }
}
