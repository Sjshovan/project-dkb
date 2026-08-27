# Bundled Providers Guidance

## Ownership

This directory owns DKB's concrete developer-preview providers: LlamaIndex/Docling ingestion, FastEmbed, FAISS, Meilisearch, source/lexical/vector artifacts, and hybrid retrieval.

The authoritative boundary is [ADR 0004](../../docs/decisions/0004-monorepo-release-units-and-local-stack.md).

## Dependency direction

- Implement contracts from `@dkb/pipeline`; use durable formats from `@dkb/protocol`.
- Export explicit plugin modules and provider-specific diagnostics.
- Keep provider-side Python under `python/` and include it through the package allowlist.

## Invariants

- Document and query embeddings share the exact recorded model, dimensions, metric, and normalization.
- Preserve source identity, locator, hashes, chunk bounds, parser fallback, and provider build provenance.
- FAISS packages immutable indexes; Meilisearch imports existing vectors into one release-specific index.
- Provider failures never promote partial artifacts or silently change the selected implementation.
- Secrets are environment references only.

## Prohibited coupling

- Do not define shared provider interfaces here.
- Do not import CLI, Runtime HTTP/MCP, Registry client, or Registry service code.
- Do not parse, chunk, or embed during Runtime installation.

## Verification

- `npm run check --workspace @dkb/providers-bundled`
- `npm run build --workspace @dkb/providers-bundled`
- `npm run proof:pipeline`
- `npm run proof:meilisearch`
