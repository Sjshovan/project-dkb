# FAISS index provider

Ownership: packaged FAISS artifact creation, validation, query-time loading, and the isolated FAISS helper.

Authoritative contracts: `packages/pipeline/src/types.ts`, `packages/protocol/src/artifacts.ts`, and `docs/architecture/final-provider-architecture.md`.

Dependencies point only to Pipeline and Protocol. This provider must not import another provider, compiler internals, Runtime internals, or the default distribution.

Artifacts contain vector-index data and Evidence ID mappings only. Canonical evidence text and provenance belong to the Evidence Build catalog. Provider options are validated here and secrets must remain environment references.

Verify with:

- `npm run check --workspace @sjshovan/dkb-index-faiss`
- `npm run build --workspace @sjshovan/dkb-index-faiss`
- `node --test tests/provider-host.test.mjs tests/profiles-evidence.test.mjs`
