# 0012 - Crash-safe Library mutations

Date: 2026-09-14

Status: Implemented candidate; final validation and the limitations below remain
part of the acceptance boundary.

**2026-10-09 supersession:** [ADR 0013](0013-library-storage-ownership.md)
replaces the mixed Windows/Linux guard with one OS/storage environment per
Library and native ownership leases. The former shared-mount protocol and its
specific fault tests below are historical, not supported behavior. The journal,
exact-path recovery, fresh read fences, and partial-deletion limit remain.

## Outcome and ownership

An interrupted package install, upgrade, uninstall, or Collection edit must
recover to one complete applied Library state. Until recovery is resolved,
Runtime activation, queries, and installed-state reads fail closed. Recovery
does not compile, contact a Registry, or change a Runtime's selected Pipeline.

The Library package owns this boundary. `dkb.json` remains desired state,
`dkb-lock.json` remains the resolved package receipt, and `.dkb/state.sqlite`
remains authoritative applied state. Immutable builds and sources remain
Library-owned; Runtime binding and activation remain Runtime-owned as specified
in [ADR 0008](0008-runtime-bound-pipelines-and-shared-libraries.md).

## Decision

Extend the existing Library mutation boundary with a durable operation journal,
a shared filesystem ownership guard, and exact-path recovery. Reuse SQLite transactions for
the applied-state commit decision; do not invent a database engine, new service,
or general-purpose workflow framework.

1. Acquire exclusive mutation ownership. An expired timestamp or apparently
   missing PID is not permission to take over a live operation.
2. Persist an operation's intent before changing any live path. Keep staging
   and old-path backups inside the same Library filesystem.
3. Journal manifest and package-path changes. Retain old package directories
   by renaming them, not by copying the whole Library or its large indexes.
4. Nested package work joins the enclosing operation. A Collection's member
   changes cannot independently commit mixed applied generations.
5. Commit the final applied entries and operation decision atomically in SQLite.
6. Only then retire the exact operation-owned backups and journal.

### Windows and Docker ownership boundary

An isolated September 14 proof acquired `BEGIN EXCLUSIVE` concurrently from
native Windows Node and a Linux Docker container against the same bind-mounted
SQLite file. SQLite-only ownership is therefore rejected for this deployment.

The shared ownership guard must be atomically visible across both environments.
Its complete owner record is persisted before exclusive publication; a
partially written owner record cannot grant takeover. A same-domain OS lease
may prove that its previous owner released or died. It must never be used to
infer that a foreign Windows/Linux owner is dead. Ambiguous foreign ownership
fails closed and requires recovery from the owning environment.

Every Library database connection, including short read snapshots, participates
in the shared guard and closes before releasing it. SQLite rollback journaling
avoids treating cross-OS shared memory as a supported WAL coordination channel.
Long-running retrieval does not hold this database guard; its read fence detects
intervening mutations. Unsupported filesystems are rejected, not silently
switched to an age-based lock. Existing writers must be stopped before changing
the development Library locking protocol.

Recovery follows the durable decision, never an assumed last completed step:

| Durable state | Recovery |
| --- | --- |
| Not committed | Restore the exact prior files and applied state. |
| Committed | Keep the next state and finish verified cleanup. |
| Ambiguous, corrupt, externally changed, or unsafe paths | Preserve the journal and files; refuse further operations. |

Recovery must be repeatable after another interruption. It validates path
containment, ownership, and expected file identity before moving or removing
anything. It must not roll back Registry trust updates or resurrect revoked
keys; those are independent security state.

## Read safety and operator experience

Normal reads never repair a Library implicitly. They return a structured
`library_recovery_required` error and the exact `dkb library recover --library
"<path>"` command. Recovery accepts an explicit Library root even if an
interrupted replacement temporarily displaced its manifest.

A monotonic internal mutation fence supplements the logical generation.
Runtime operations validate it before admitting evidence and at finalization.
This detects a mutation followed by rollback even when the original generation
and package bytes were restored. The fence is not part of package identity or
the portable activation contract.

Read phases may share a deeply immutable SQLite snapshot within one request.
Every phase ends with a fresh guarded pending-operation and fence check before
it releases success. Runtime admission and audit finalization use separate
phases; neither file validation nor provider/trust checks are cached. No live
database connection or cross-request permission is retained.

After successful recovery, the CLI attempts the existing refresh flow for local
Runtimes serving that Library. Failed or offline Runtimes remain visibly stale;
they do not change the Library's recovery decision.

## Alternatives considered

- Keep catch-only rollback: insufficient when the process exits without running
  catch/finally, particularly between lock-file replacement and database commit.
- Copy entire Libraries before mutation: duplicates large source/build trees
  and adds avoidable disk and installation cost.
- Rely on atomic rename alone: it cannot atomically commit several package
  directories, two manifests, and SQLite applied state.
- Add an external transaction service: adds deployment and recovery ownership
  without replacing the need to validate DKB-specific files and receipt state.

SQLite already provides atomic database commits and OS-managed locking. The
missing layer is DKB's narrow filesystem-to-ledger contract. See
[SQLite transactions](https://www.sqlite.org/lang_transaction.html) and
[atomic commit](https://www.sqlite.org/atomiccommit.html). Its
[WAL documentation](https://www.sqlite.org/wal.html) requires compatible
shared-memory coordination; it is not a cross-filesystem ownership service.
Filesystem durability
still depends on the host; process-death tests are not power-loss certification.

## Acceptance

- Real child-process termination before and after path promotion, metadata
  replacement, SQLite commit, and cleanup restores one complete prior or next
  state from a fresh process, including multi-member Collections.
- Recovery is idempotent; corrupt journals, unsafe paths, missing backups,
  external edits, and cleanup failures retain recoverable state and fail closed.
- Concurrent writers and recovery cannot take ownership from a paused live
  process. Actual owner death allows exactly one recovery owner.
- A native Windows writer and Linux Docker contender cannot simultaneously
  enter the same Library. Guarded database reads and writes preserve complete
  snapshots across that actual bind mount; foreign recovery never guesses.
- Pending recovery and mutation/rollback races cannot return evidence through
  CLI, HTTP, MCP, or installed-evidence inspection.
- Install, upgrade, uninstall, dependency reuse, rollback, and retry preserve
  package provenance and unrelated sources without reparsing or recompilation.
- Windows and Linux proofs, CLI errors/help, focused and full tests, package
  boundaries, and documentation checks pass. Compile and warm-query performance
  must not be represented as improved or release-verified without measurement.

This decision does not claim the broader signed multi-recipe lifecycle,
signing-key history, Console retention, or public-release gate is complete.

## Explicit recovery limits

- Same-domain process or container death is different from a Linux VM/kernel
  restart. A changed kernel boot identity cannot prove that a foreign domain
  has stopped using the Library. Automatic foreign-owner takeover is forbidden;
  operator-confirmed recovery after a VM/kernel change still needs an explicit
  authority policy. There is no unsafe force flag in this candidate.
- The named process-death tests cover intent, staging, promotion, commit,
  restoration, and cleanup boundaries. They do not prove automatic replay
  halfway through recursive deletion of a directory. A partially removed tree
  no longer matches its complete receipt, so recovery retains remaining data
  and the journal and fails closed. Automatically retiring such a remainder
  requires per-file deletion receipts or a separately authorized retirement
  policy; it cannot be inferred from an incomplete hash.
- Guard metadata reads retry the same Docker bind-mount `EIO` or Windows sharing
  denial (`EPERM`) for a
  bounded interval. Persistent unreadable ownership remains an error, never
  evidence that no owner exists. Native leases are retained explicitly for
  the full operation lifetime, including idle operations and garbage collection.
- Atomic guard publication may retry transient `EIO`/`ENOENT` only while the
  exact prepared owner remains intact. An ambiguous successful link requires
  matching owner bytes and hardlink identity before admission. Unreadable or
  copied records are not ownership proof. Guard removal is never blindly retried
  because a subsequent contender may already own that path.

These limits must stay visible until their corresponding proof and operator
policy are implemented. Passing the bounded tests is not a claim that every
instruction-level interruption or arbitrary shared filesystem is recoverable
without operator intervention.
