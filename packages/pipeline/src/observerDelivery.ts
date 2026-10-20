import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbProviderOptions, DkbQueryObservation, DkbQueryObserver } from './types.js';

export const QUERY_OBSERVER_DELIVERY_TIMEOUT_MS = 1_000;

/** Bounded, non-overlapping telemetry calls owned by one provider host. */
export class QueryObserverDelivery {
  private readonly pending = new Map<DkbQueryObserver, AbortController>();

  async run(
    observer: DkbQueryObserver,
    event: Readonly<DkbQueryObservation>,
    context: { root: string; options: DkbProviderOptions },
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new DkbError('Query observer delivery timeout must be a positive finite duration.', 'invalid_observer_timeout');
    }
    signal?.throwIfAborted();
    if (this.pending.has(observer)) {
      throw new DkbError(
        `Observer ${observer.id} still has an unfinished delivery. Honour context.signal and retry after it settles.`,
        'observer_delivery_pending',
      );
    }

    const controller = new AbortController();
    this.pending.set(observer, controller);
    const delivery = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return observer.observe(event, { ...context, signal: controller.signal });
    }).finally(() => {
      if (this.pending.get(observer) === controller) this.pending.delete(observer);
    });
    // A timed-out plugin may settle later. Its result is never admitted twice,
    // and its rejection must not become an unhandled process-level exception.
    void delivery.catch(() => undefined);

    let rejectAborted!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted(controller.signal.reason);
    const onCallerAbort = () => controller.abort(signal?.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DkbError(
      `Observer ${observer.id} exceeded its ${timeoutMs} ms delivery budget. Honour context.signal when exporting telemetry.`,
      'observer_delivery_timeout',
    )), timeoutMs);
    try {
      await Promise.race([delivery, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  abort(): void {
    for (const controller of this.pending.values()) {
      controller.abort(new DkbError('Provider host closed during observer delivery.', 'observer_delivery_cancelled'));
    }
  }
}
