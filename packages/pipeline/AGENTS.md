# Pipeline Package Guidance

## Ownership

This directory owns provider and processor interfaces, context-local plugin discovery, configuration precedence, lifecycle/disposal, middleware ordering, and retrieval compatibility receipts.

The authoritative build boundary is [ADR 0005](../../docs/decisions/0005-evidence-and-retrieval-build-graph.md).

## Dependency direction

- Depend only on `@sjshovan/dkb-protocol` and Node platform APIs.
- Expose contracts consumed by compiler, Runtime, bundled providers, and CLI.
- Keep every provider host isolated to one context root.

## Invariants

- Resolution remains context-local, then user-global, then explicitly supplied bundled providers.
- A broken local override fails closed; it never falls through silently.
- Load only selected plugins. Uploaded knowledge must never contribute executable plugin code.
- Preserve deterministic processor order, exact source/build digests, compatibility validation, cancellation, and disposal.
- Keep Evidence Profile, Retrieval Profile, compatibility, and concrete build identities separate; profile names are never artifact selectors.
- Configuration stores secret references, never secret values.

## Prohibited coupling

- Do not import concrete providers, compiler jobs, Runtime code, Registry clients, or CLI presentation.
- Do not add provider-specific option schemas to shared contracts.
- Do not use global mutable provider state.

## Verification

- `npm run check --workspace @sjshovan/dkb-pipeline`
- `npm run build --workspace @sjshovan/dkb-pipeline`
- `node --test tests/provider-host.test.mjs tests/profiles-evidence.test.mjs`
