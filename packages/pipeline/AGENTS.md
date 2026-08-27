# Pipeline Package Guidance

## Ownership

This directory owns provider and processor interfaces, context-local plugin discovery, configuration precedence, lifecycle/disposal, middleware ordering, and retrieval compatibility receipts.

The authoritative boundary is [ADR 0004](../../docs/decisions/0004-monorepo-release-units-and-local-stack.md).

## Dependency direction

- Depend only on `@dkb/protocol` and Node platform APIs.
- Expose contracts consumed by compiler, Runtime, bundled providers, and CLI.
- Keep every provider host isolated to one context root.

## Invariants

- Resolution remains context-local, then user-global, then explicitly supplied bundled providers.
- A broken local override fails closed; it never falls through silently.
- Load only selected plugins. Uploaded knowledge must never contribute executable plugin code.
- Preserve deterministic processor order, exact source/build digests, compatibility validation, cancellation, and disposal.
- Configuration stores secret references, never secret values.

## Prohibited coupling

- Do not import concrete providers, compiler jobs, Runtime code, Registry clients, or CLI presentation.
- Do not add provider-specific option schemas to shared contracts.
- Do not use global mutable provider state.

## Verification

- `npm run check --workspace @dkb/pipeline`
- `npm run build --workspace @dkb/pipeline`
- `node --test tests/provider-host.test.mjs tests/profiles-evidence.test.mjs`
