# 0011 - Worker-confirmed compilation cancellation

- **Status:** Accepted
- **Date:** 2026-09-13
- **Scope:** Existing compiler job control and the concrete Evidence worker

## Decision

Cancellation is a request until the process that owns the work confirms that
writes have stopped. An aborted HTTP request, expired deadline, missing client
process, or empty in-memory job map is not that confirmation.

Keep one warm, supervised child inside the existing Linux Evidence service.
Normal jobs reuse the imported compiler, converters, and tokenizer. Each job
drains its asynchronous executor before completion. Cancellation terminates and
reaps the owned worker and descendants before replacing it with a fresh worker
and fresh IPC. The supervisor remains responsive during parsing and accepts one
active compilation. No additional service or generic execution framework is added.

The Evidence service runs as PID 1 in its existing Docker container; this is an
explicit safety boundary, not a supported native Windows worker. The container
must not wrap this service in another init process. Windows hosts continue using
the Linux container. Bare native Python service launches fail closed.

## Ownership and protocol

- The compiler persists an exclusive execution claim and private pending-worker
  records before dispatch. Records bind the exact selected provider identity,
  recipe and options digest to opaque operational recovery data.
- The SDK exposes optional `compile.execution` registration/settlement and
  `cancelPending`. Concrete providers alone interpret worker URLs, container
  handles, and their artifact/scratch paths. This data is not build provenance.
- Worker requests carry a unique job ID, random job token, and deadline.
  Cancel-before-start writes an exact tombstone. Terminal acknowledgments bind
  the job ID and token hash; wrong or missing acknowledgments cannot authorize
  cleanup. Raw tokens never enter logs or responses.
- Pending records are settled only after verified cessation of writes and
  owned-path cleanup. Unresolved records survive expiry and restart. Provider or
  configuration drift prevents reconciliation by a replacement implementation.
- Unresolved or unreadable worker records reject both JSON and binary delivery,
  even if a provider returned otherwise valid records. Cleanup also requires a
  durable finished marker; a failed uncertainty-marker write cannot authorize
  deletion. Recovery persists its confirmation before clearing pending handles.
- The disabled-service Docker path owns a named, labeled container. Stopping a
  Docker client is not stopping that container: its actual state must be
  inspected, stopped/killed, waited for, and removed.

## Registry outcome

`compile_termination_unconfirmed` is an HTTP 409, not a normal retryable failure.
The Registry retains the original request/execution and shows `cancelling`.
Operators retry cancellation for the same job after restoring connectivity;
they do not delete its working files or enqueue duplicate work. Published
variants and immutable source are untouched.

Recovery distinguishes a finished/dead Node execution from another live owner
using an exclusive OS-held lock through the already-used built-in SQLite API.
The lease is a private per-execution file, not another database service or state
model. This avoids PID reuse and cross-container namespace inference. An
unverifiable owner remains pending rather than being stolen based on lease age.
Releasing the Node owner lock only permits worker reconciliation; it never
substitutes for the worker acknowledgment. Use local filesystems with working
SQLite locks, not unsupported network filesystem semantics.

Uploaded archive display names never select local write paths. The compiler
uses fixed filenames inside its owned workspace for source and Evidence uploads.

## Verification and limits

Require real in-flight service cancellation, no post-acknowledgment writes,
cancel-before-start, lost acknowledgments, restart recovery, provider drift,
concurrent cancellation, and cleanup-error tests. Compare successful outputs and
warm job medians against the previous worker; do not claim that preserving one
warm PID alone proves the full system performance budget.

Keep the worker endpoint stable across restarts. A changed ephemeral Docker host
port is not authority to forward a retained private job token elsewhere; restore
the configured endpoint before recovery. Compose's fixed internal URL avoids
that test-only randomized-port behavior.

## Sources

- [Python task cancellation](https://docs.python.org/3/library/asyncio-task.html#task-cancellation)
  is cooperative; cancelling an awaiting coroutine is not evidence of stopped
  thread work.
- [Python process termination](https://docs.python.org/3/library/multiprocessing.html#multiprocessing.Process.terminate)
  warns about descendants and damaged IPC. Terminated workers do not reuse IPC.
- [Docker stop](https://docs.docker.com/reference/cli/docker/container/stop/)
  sends a termination signal and escalates to a kill after its grace period.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html) provide
  the exclusive transaction used for the existing Node execution owner lease.
