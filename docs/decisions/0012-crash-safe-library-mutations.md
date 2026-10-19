# 0012 - Crash-safe Library mutations

Date: 2026-09-14

Status: Accepted. Storage ownership is superseded by
[ADR 0013](0013-library-storage-ownership.md); the transaction design remains.

## Context

An install or Collection update changes more than a database row: package
directories, manifests, logical locks and applied state must agree after an
interruption. A catch/finally rollback cannot run after process death, and an
atomic rename cannot commit several paths and SQLite as one operation.

## Decision

The Library package owns a durable operation journal and exact-path recovery.
Reuse SQLite for the applied-state commit decision rather than adding a
transaction service. Keep staging and rollback directories on the Library's
native filesystem.

1. Acquire exclusive mutation ownership.
2. Persist intent before changing a live path.
3. Journal manifest and package changes; rename existing directories into
   operation-owned backups instead of copying large build trees.
4. Join nested member work to the enclosing Collection transaction.
5. Commit final applied entries and the operation decision atomically in SQLite.
6. Retire only the exact verified backups and journal after that commit.

`dkb.json` expresses desired roots, `dkb-lock.json` records exact resolution,
and `.dkb/state.sqlite` owns applied state. Runtime activation remains separate.

## Recovery

| Durable decision | Action |
| --- | --- |
| Not committed | Restore the exact prior files and applied state. |
| Committed | Retain the next state and finish verified cleanup. |
| Ambiguous, corrupt or externally changed | Preserve data and journal; refuse mutation and retrieval. |

Recovery validates containment, ownership and expected file identity before
moving or removing anything. Repeated recovery must be safe after another
interruption. Registry trust updates and revoked keys are independent security
state and must not be rolled back.

Normal reads never repair implicitly. They return `library_recovery_required`
with the exact `dkb library recover --library "<path>"` command. Recovery can
locate an explicit Library whose manifest was temporarily displaced.

A monotonic mutation fence detects intervening changes even when a rollback
restores the original logical generation. Runtime admission and finalization
perform fresh checks; neither a cached context nor a previously valid snapshot
authorizes serving removed evidence.

After recovery, associated local Runtimes are refreshed where possible. An
offline Runtime remains stale; it does not change the recovery decision.

## Alternatives

- Catch-only rollback cannot cover process death.
- Whole-Library backup duplicates large sources and indexes on every mutation.
- Rename alone cannot coordinate all filesystem and ledger state.
- A new workflow service adds deployment complexity without removing the need
  for DKB-specific receipt and path validation.

## Limits and verification

A partially deleted rollback tree no longer matches its complete receipt.
Recovery preserves the remainder and journal instead of inferring permission
to delete it. There is no age-based or PID-based force takeover.

Tests must interrupt real processes around intent, path promotion, metadata
replacement, commit and cleanup; repeat recovery; exercise concurrent owners;
and reject corrupt journals, unsafe paths, missing backups and external edits.
Pending recovery must block installed-state reads and CLI/HTTP/MCP evidence.

Process-death recovery is not a power-loss or arbitrary-filesystem guarantee.
Use the [supported storage configurations](../developer-preview.md).

References: [SQLite transactions](https://www.sqlite.org/lang_transaction.html),
[atomic commit](https://www.sqlite.org/atomiccommit.html).
