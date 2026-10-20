# Library Package Guidance

## Ownership

Own Library discovery, Collections, locks, applied state, artifact verification,
signing, source access, and filesystem-safe transactions.

The canonical [provider architecture](../../docs/architecture/final-provider-architecture.md)
and [ADR 0006](../../docs/decisions/0006-final-provider-architecture-and-storage-cutover.md)
are authoritative.

## Dependency direction

- Depend only on `@sjshovan/dkb-protocol` and Node platform APIs. Validate
  generic Evidence, Retrieval, artifact-manifest, and Runtime receipts without
  importing Pipeline or concrete providers.
- Expose domain operations to CLI, Runtime, compiler, and Registry client orchestration.
- Keep presentation and network transport outside this package.

## Invariants

- Source manifests and source files are canonical; generated artifacts are derived.
- Library state changes use locks, staging, atomic promotion, and rollback.
- `mutation.ts` owns the durable applied-state commit/recovery decision;
  use its path operations rather than direct live manifest or package moves.
  Database access goes through `stateStore.ts` on freshly verified local storage.
  Writers hold exclusive native leases; readers use short SQLite transactions
  and fresh phase-end fences. Windows/Docker shared database mounts are rejected;
  see [ADR 0013](../../docs/decisions/0013-library-storage-ownership.md).
  Never infer ownership from PID, file existence, or age. Read paths reject
  pending recovery; [ADR 0012](../../docs/decisions/0012-crash-safe-library-mutations.md)
  owns the journal and recovery decision.
- Filesystem presence alone never activates knowledge.
- Resolve every package path inside its Library root and preserve provenance identity.
- Collection membership resolves exact versions through the Library lock.
- Build directories are immutable and content-addressed. Runtime activation
  state never lives in a Library; `.dkb/state.sqlite` remains authoritative
  applied state for installed knowledge.

## Prohibited coupling

- Do not import CLI formatting, HTTP/MCP handlers, concrete providers, or compiler jobs.
- Do not move or rewrite source knowledge as a side effect of inventory or inspection.
- Do not treat remote Registry state as authoritative for local activation.

## Verification

- `npm run check --workspace @sjshovan/dkb-library`
- `npm run build --workspace @sjshovan/dkb-library`
- `node --test tests/library-contract.test.mjs`
- `node --test tests/library-lock-ownership.test.mjs tests/library-mutation-recovery.test.mjs`
