# Library Package Guidance

## Ownership

This directory owns local Library discovery, Collection membership resolution, Library locks, applied-state records, artifact snapshots, source adapters, compiled-artifact verification, signing, and filesystem-safe Library transactions.

The authoritative build boundary is [ADR 0005](../../docs/decisions/0005-evidence-and-retrieval-build-graph.md).

## Dependency direction

- Depend only on `@sjshovan/dkb-protocol` and Node platform APIs. Validate
  generic Evidence, Retrieval, artifact-manifest, and Runtime receipts without
  importing Pipeline or concrete providers.
- Expose domain operations to CLI, Runtime, compiler, and Registry client orchestration.
- Keep presentation and network transport outside this package.

## Invariants

- Source manifests and source files are canonical; generated artifacts are derived.
- Library state changes use locks, staging, atomic promotion, and rollback.
- Filesystem presence alone never activates knowledge.
- Resolve every package path inside its Library root and preserve provenance identity.
- Collection membership resolves exact versions through the Library lock.
- Build directories are immutable and content-addressed. Runtime locks are generated receipts; `.dkb/state.sqlite` remains authoritative applied state.

## Prohibited coupling

- Do not import CLI formatting, HTTP/MCP handlers, concrete providers, or compiler jobs.
- Do not move or rewrite source knowledge as a side effect of inventory or inspection.
- Do not treat remote Registry state as authoritative for local activation.

## Verification

- `npm run check --workspace @sjshovan/dkb-library`
- `npm run build --workspace @sjshovan/dkb-library`
- `node --test tests/library-contract.test.mjs`
