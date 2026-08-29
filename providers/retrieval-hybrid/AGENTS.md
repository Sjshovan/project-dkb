# Hybrid Retrieval Provider Guidance

This package owns the `@dkb/retrieval-hybrid` search, ranking, and fusion implementation. It depends only on Pipeline contracts.

Keep candidate fusion, ranking, trace metadata, cancellation, and Runtime disposal here. It receives provider-neutral candidate IDs and must never read provider-native files, canonical evidence text, provenance, Library state, compiler output, or another provider package.

Verify with `npm run check --workspace @sjshovan/dkb-retrieval-hybrid` and retrieval contract/lifecycle tests. See [the canonical architecture](../../docs/architecture/final-provider-architecture.md).
