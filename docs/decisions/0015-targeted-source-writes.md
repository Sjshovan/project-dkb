# 0015 - Explicit source destinations and retained revisions

- **Status:** Accepted
- **Date:** 2026-10-20
- **Scope:** Local stdio text writes and exact historical evidence fetch
- **Supersedes:** ADR 0014's prohibition on explicit source paths for opted-in packages

## Decision

Separate creation of a source from byte append to an existing source. The operator
controls append/create/exclude path patterns in the package write policy. Agents
can discover eligible paths and source hashes, select a destination, and submit an
explicit operation. Server policy, source preconditions and ownership remain the
authority; semantic destination choice is not a new trusted capability.

Use a bounded, documented glob subset without another dependency. Deny unsupported
syntax, constraints, formats, control paths, Registry packages, symlinks and linked
source files. Missing targeted permissions deny. Exclusions always win. Keep the
pathless generated-asset form only for manifests without destination policy.

## Identity and ownership

Evidence IDs bind an entire source hash, so even a byte append changes the source's
evidence identities. Do not mislabel old evidence with new hashes or current build
digests. Retain the exact old source bytes, matching evidence IDs and exact old
Evidence/Retrieval selection in the same Library journal transaction as the append.
The bytes are content addressed; the history index is explicit, not a newest-build
scan. Unrelated prior records must remain identical in the new build.

Search providers receive only current evidence. Exact fetch can read a retained
revision belonging to the installed local package/version. Runtime input snapshots
cover the history index, archived bytes and selected immutable builds, with normal
build-chain validation. Historical citations identify their revision, and audit
candidates bind its original evidence and retrieval digests. Uninstall invalidates
access. No compiler runs during reads. Runtime still takes compiler composition
only from the CLI for writes; HTTP MCP remains read-only.

## Concurrency and recovery

Serialize with existing Runtime/Library leases. Require a source hash for existing
append, stage clean source inputs, and verify both live and staged source stability.
Commit with a byte-hash precondition in the existing journal. Preserve old bytes as
an exact prefix; never silently insert separators. Create requires an absent path.

The request identity includes operation, path and expected hash as well as text and
references. Preserve old v1 receipt identity for compatibility. Replays after later
appends resolve the earlier evidence via retained history and keep the current
activation. A failed refresh reports committed state and can retry without another
source write. Unexpected journal uncertainty requires normal Library recovery.

## Limits and consequences

Synchronous compilation still processes the target package. Every revision retains
source bytes and old builds; storage grows, with no automatic pruning in this scope.
History is local state rather than a portable source export. Package version changes
or removed history invalidate old-version fetches. Required semantic dedupe, schemas
and nonempty accepted-intent constraints fail closed until implemented. Source text
remains inert and caller references remain unauthenticated.

See [MCP contract and pattern examples](../chatgpt-mcp.md) for exact syntax, bounds,
legacy compatibility, discovery, retry and confirmation behavior.

## Acceptance

Exercise real in-memory MCP discovery/create/append/fetch on temporary Libraries,
including an empty package. Prove root/basename/folder patterns, exclusion precedence,
reserved paths, permission denials, prefix/UTF-8 preservation, stale and concurrent
writes, idempotency, source races, compiler failure and committed-refresh recovery.
Prove current-only search, historical fetch/audit digests, restart, uninstall and
reinstall, and corrupted-history rejection. Keep remote tools read-only. Run type
checks, focused tests and the full repository suite before handoff.
