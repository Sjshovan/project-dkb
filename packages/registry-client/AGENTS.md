# Registry Client Package Guidance

## Ownership

This directory owns the Laravel Registry HTTP client, Registry endpoint normalization and verification, authenticated publication/download calls, Collection requests, and safe DKB archive transport.

The canonical [provider architecture](../../docs/architecture/final-provider-architecture.md)
and [ADR 0006](../../docs/decisions/0006-final-provider-architecture-and-storage-cutover.md)
are authoritative.

## Dependency direction

- Depend on `@sjshovan/dkb-protocol` and transport/archive libraries only.
- Expose typed operations to CLI and Runtime orchestration.
- Keep host inventory selection and human output in `@sjshovan/dkb-cli`.

## Invariants

- Never persist Registry bearer tokens or return them in diagnostics.
- Validate remote identity, version, media type, digest, and signatures before activation.
- Archive extraction rejects traversal, links, and unsupported entry types.
- Strip `.dkb/plugins` and operator configuration from every knowledge archive.
- Downloads use bounded requests and atomic file promotion.

## Prohibited coupling

- Do not import Laravel internals, CLI presentation, Runtime state, compiler jobs, or concrete retrieval providers.
- Do not embed a Registry server implementation.
- Do not make remote responses authoritative for local activation without verification.

## Verification

- `npm run check --workspace @sjshovan/dkb-registry-client`
- `npm run build --workspace @sjshovan/dkb-registry-client`
- `node --test tests/cli-ux.test.mjs`
