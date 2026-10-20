# Hybrid Retrieval Provider Guidance

This package owns the `@dkb/retrieval-hybrid` search, ranking, and fusion implementation. It depends only on Pipeline contracts.

Keep relevance filtering, candidate fusion, ranking, trace metadata, cancellation,
and Runtime disposal here. Consume provider-neutral candidate IDs and the Evidence
catalog supplied through the contract. Never load provider-native files, Evidence
text, provenance, Library state, or compiler output directly from storage, and
never import another provider package. Transport adapters must not duplicate
this provider's relevance policy or require its optional token diagnostics.

Verify with `npm run check --workspace @sjshovan/dkb-retrieval-hybrid` and retrieval contract/lifecycle tests. See [the canonical architecture](../../docs/architecture/final-provider-architecture.md).
