# 0014 - Permission-gated local MCP append

- **Status:** Accepted
- **Date:** 2026-10-20
- **Scope:** Local stdio MCP append to editable installed DKBs
- **Supersedes:** The local source-write exclusion in 0010; remote MCP remains read-only

## Decision

The local `dkb mcp serve` composition exposes `append` alongside `search` and
`fetch`. HTTP MCP continues to expose only read tools. A package permission does
not authorize arbitrary filesystem access, remote writes, package installation,
updates, deletion, plugin changes, or permission changes.

The Library owns the source append and durable transaction. The Runtime owns its
exclusive mutation lease, exact activation selection and evidence readback.
The CLI injects its existing trusted compiler composition. Runtime code does not
import compiler internals, and MCP arguments cannot choose executable providers,
source paths, a Library, or a Runtime.

An append requires an installed editable direct Library child, an explicit
`permissions.write: true`, accepted append intent in direct mode, and
`confirmed: true` when the package requires confirmation. Confirmation is the
caller's assertion that the user approved this operation, not independent proof
of a human action. Clients must obtain that approval before making the call.

Each request supplies a stable request ID, clean text and caller-known evidence
references. The source asset is `append-<requestId>.md`; text is stored exactly.
This preserves existing source bytes and evidence identities. A request ID
cannot replace an existing asset or be reused for different text/references.

## Compilation and commit

Under existing Runtime/Library ownership, the Library stages the target package's
canonical inputs and the new asset. The trusted compiler prepares an immutable
package build. The operation checks version/profile compatibility, inclusion of
the new source hash, preservation of previous evidence and unchanged live source.
It commits only the new asset, new immutable builds, an idempotency receipt and
the exact current append selection using the existing Library journal.

The package version is unchanged. The Library generation advances, invalidating
stale Runtime snapshots. Existing builds and records remain present. The active
Runtime selects the exact committed build, refreshes and fetches the new evidence
before returning `appended`. Other Runtimes refresh explicitly.

This uses the existing synchronous target-package compiler; it is not an
incremental indexing API or a whole-Library rebuild. Provider compilation cost
still applies. Input text is limited to 64 KiB per request. The change introduces
no new service, dependency, embedding provider, credential or background worker.

Before commit, errors leave canonical content and the old build intact. After
commit, refresh/readback errors return `committed_refresh_required`, with
`committed: true` and the receipt. Retry the same request after restoring the
service; do not append another copy. Journal recovery uncertainty is reported
separately with `committed: null`. A stale Runtime cannot append a new fact.

## Provenance boundary

The Evidence pipeline already owns source hashes, asset locators, chunk/evidence
identities, package versions and build identities. Append reuses those contracts.
It never adds a `Provenance:` paragraph, a message ID, a date or a heading to the
fact text.

The existing write-intent `evidenceRefs` are caller-supplied references, checked
for presence and included in request identity. They are not authenticated
conversation attribution and are not injected into source text or Evidence IR.
This decision adds no conversation-message schema. Structured originating
conversation attribution requires a separate contract and explicit input; the
Runtime cannot infer a message ID it never received.

## Acceptance

Real MCP calls must prove append success, disabled/missing write permission,
unsupported policy, missing confirmation, invalid/escaping targets, unchanged
prior facts and version, clean fact text, immediate search/fetch, idempotent
retry, conflict rejection and compiler failure preservation. Existing HTTP MCP
tests must continue to prove a read-only authenticated surface.
