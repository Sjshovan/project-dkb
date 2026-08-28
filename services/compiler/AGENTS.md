# Compiler Service Guidance

## Ownership

This directory owns the shared compilation runner, staging and rollback, source analysis, Evidence IR production, artifact locks, and the trusted Registry-facing compiler HTTP service.

The authoritative build boundary is [ADR 0005](../../docs/decisions/0005-evidence-and-retrieval-build-graph.md).

## Dependency direction

- Depend on protocol, Library transactions, pipeline contracts, Registry archive transport, and explicitly supplied provider bundles.
- Local and HTTP compilation must call the same job runner.
- Keep provider-specific work behind `@sjshovan/dkb-pipeline` contracts.

## Invariants

- Compile isolated staged source; never mutate or move caller knowledge.
- Strip uploaded plugins, operator configuration, caches, vendor content, and generated state.
- Finish every text mutation before Evidence IR, then route the exact Evidence Build through the selected embedder and index provider.
- Preserve stable source anchors and enforce exact Evidence/Retrieval parent digests.
- Validate all artifacts before atomic promotion; rollback leaves the previous complete build intact.
- Enforce cancellation, timeouts, target compatibility, and trusted context-root containment.

## Prohibited coupling

- Do not import CLI presentation, Runtime HTTP/MCP, host inventory, or Laravel internals.
- Do not select providers with model-specific environment branches in the runner.
- Do not mount or invoke the Docker socket from the HTTP service.

## Verification

- `npm run check --workspace @sjshovan/dkb-compiler`
- `npm run build --workspace @sjshovan/dkb-compiler`
- `node --test tests/profiles-evidence.test.mjs tests/provider-host.test.mjs`
- `npm run proof:pipeline`
