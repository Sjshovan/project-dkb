# 0002 - Library And Collections Hard Cutover

- **Status:** Implemented; public publication not authorized
- **Date:** 2026-08-26
- **Scope:** local Library layout, namespaced identities, Collections, remote Registry snapshots, install state, Runtime, and MCP

## TL;DR

Rename the old local-registry concept to **Library** and keep **Registry** for the remote distribution service. A flat Library contains editable DKBs and Collections at the top level and Registry-managed downloads under `vendor/`. Manifest type determines entry kind; the lock and applied-state ledger determine installation. Collections are first-class namespaced dependency bundles whose Registry revisions resolve to exact immutable DKB releases. One Runtime serves one Library and the remote MCP remains read-only.

## Decision

### Identity and layout

- Every DKB and Collection uses a lowercase `@namespace/name` identity.
- The change is a hard cutover. Legacy manifest types and unscoped identities are rejected; no migration reader or manifest-version branch is added.
- Editable DKBs and Collections are direct child folders of a Library. Discovery is not recursive.
- Registry downloads live only at `vendor/@namespace/name`.
- Folder placement does not determine kind or installed state. `dkb.json.type` determines kind; desired roots, exact lock state, and the applied-state ledger determine activation.

### Collection releases

- Editable Collection members use an exact semantic version or `latest`; version ranges are not supported.
- The Registry resolves every selector at publish time and assigns the next integer revision.
- A revision is immutable and contains sorted exact DKB identities, versions, and release digests.
- Every referenced DKB release must exist before the revision is created. The CLI may publish a missing valid DKB from the publisher's own namespace; it never manufactures or republishes a foreign dependency.

### Local resolution

- One DKB identity has one installed version and digest per Library.
- The same exact release is shared when multiple roots or Collections require it.
- Different versions of one identity conflict before download or mutation.
- `requiredBy` edges make ownership explicit. Uninstall prunes Registry content only when no edge remains.
- `dkb.json` is desired roots, `dkb-lock.json` is human-auditable exact resolution, and `.dkb/state.sqlite` is deterministic applied state.

### Runtime and MCP

- One Runtime serves one Library and builds one aggregate query snapshot from its active DKB set.
- Shared DKBs are deduplicated before aggregate SQLite and FAISS construction.
- All active DKBs must match the Library retrieval profile. A mismatch restores the previous filesystem, manifest, lock, ledger, and catalog.
- Local stdio MCP retains the broad local surface. Remote Streamable HTTP MCP exposes only read-only `search` and `fetch` with untrusted-evidence boundaries and stable citations.

## Acceptance Evidence

The implementation was exercised with an isolated Registry and synthetic packages:

- published two compiled signed DKBs and an immutable two-member Collection;
- installed into a fresh Library and retrieved known markers through the Runtime and HTTP MCP;
- confirmed ChatGPT independently selected the DKB connector, searched and
  fetched the three known-answer records, and returned evidence-insufficient
  for an unrelated question;
- confirmed the public evidence URL and evidence-insufficient unrelated search;
- uninstalled and reinstalled the Collection with no additional compile job;
- shared one exact DKB across two Collections and pruned only the unshared member;
- rejected a conflicting Collection update without changing the lock;
- installed the update after removing the conflicting owner;
- rejected a 768-dimensional package from a 384-dimensional Library with the
  aggregate lock and artifact manifest restored byte for byte;
- installed and queried that package in a separate valid 768-dimensional Library;
- verified signed receipts remain with installed Registry DKBs.

This evidence is a local development gate, not authorization to publish, merge to `main`, or claim production hosting readiness.

## Non-Goals

This decision does not add agent-controlled writes, automatic decay, a dashboard, permanent hosting, nested Libraries, multiple Libraries per Runtime, version ranges, side-by-side versions of one DKB identity, or a second retrieval engine.
