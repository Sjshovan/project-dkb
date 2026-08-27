# Library Package Guidance

## Ownership

This directory owns local Library discovery, Collection membership resolution, Library locks, applied-state records, artifact snapshots, source adapters, compiled-artifact verification, signing, and filesystem-safe Library transactions.

The authoritative boundary is [ADR 0004](../../docs/decisions/0004-monorepo-release-units-and-local-stack.md).

## Dependency direction

- Depend on `@dkb/protocol` for durable formats, `@dkb/pipeline` for profile receipts, and bundled artifact readers only where verification requires a concrete format.
- Expose domain operations to CLI, Runtime, compiler, and Registry client orchestration.
- Keep presentation and network transport outside this package.

## Invariants

- Source manifests and source files are canonical; generated artifacts are derived.
- Library state changes use locks, staging, atomic promotion, and rollback.
- Filesystem presence alone never activates knowledge.
- Resolve every package path inside its Library root and preserve provenance identity.
- Collection membership resolves exact versions through the Library lock.

## Prohibited coupling

- Do not import CLI formatting, HTTP/MCP handlers, concrete providers, or compiler jobs.
- Do not move or rewrite source knowledge as a side effect of inventory or inspection.
- Do not treat remote Registry state as authoritative for local activation.

## Verification

- `npm run check --workspace @dkb/library`
- `npm run build --workspace @dkb/library`
- `node --test tests/library-contract.test.mjs`
