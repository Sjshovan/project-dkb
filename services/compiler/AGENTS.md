# Compiler Service Guidance

## Ownership

This directory owns the shared compilation runner, staging and rollback, source analysis, Evidence IR production, artifact locks, and the trusted Registry-facing compiler HTTP service.

The authoritative boundary is [ADR 0004](../../docs/decisions/0004-monorepo-release-units-and-local-stack.md).

## Dependency direction

- Depend on protocol, Library transactions, pipeline contracts, Registry archive transport, and explicitly supplied provider bundles.
- Local and HTTP compilation must call the same job runner.
- Keep provider-specific work behind `@dkb/pipeline` contracts.

## Invariants

- Compile isolated staged source; never mutate or move caller knowledge.
- Strip uploaded plugins, operator configuration, caches, vendor content, and generated state.
- Preserve stable evidence identity and complete parser/chunker/embedder/index provenance.
- Validate all artifacts before atomic promotion; rollback leaves the previous complete build intact.
- Enforce cancellation, timeouts, target compatibility, and trusted context-root containment.

## Prohibited coupling

- Do not import CLI presentation, Runtime HTTP/MCP, host inventory, or Laravel internals.
- Do not select providers with model-specific environment branches in the runner.
- Do not mount or invoke the Docker socket from the HTTP service.

## Verification

- `npm run check --workspace @dkb/compiler`
- `npm run build --workspace @dkb/compiler`
- `node --test tests/profiles-evidence.test.mjs tests/provider-host.test.mjs`
- `npm run proof:pipeline`
