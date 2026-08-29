# Meilisearch index provider

Ownership: managed Meilisearch import metadata, lifecycle, validation, health, and candidate search.

Authoritative contracts: `packages/pipeline/src/types.ts`, `packages/protocol/src/artifacts.ts`, and `docs/architecture/final-provider-architecture.md`.

Dependencies point only to Pipeline, Protocol, and the Meilisearch client. This provider must not import another provider, compiler internals, Runtime internals, or the default distribution.

Live indexes are replaceable managed state and are never packaged. Artifact content is import material bound to exact Evidence IDs and vectors. Connection secrets remain environment references.

Verify with:

- `npm run check --workspace @sjshovan/dkb-index-meilisearch`
- `npm run build --workspace @sjshovan/dkb-index-meilisearch`
- `node --test tests/provider-host.test.mjs tests/provider-pipeline.test.mjs`
