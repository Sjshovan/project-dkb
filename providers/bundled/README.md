# @dkb/providers-bundled

The developer-preview provider bundle for DKB.

It supplies the default LlamaIndex/Docling ingestion service, FastEmbed document/query embeddings, packaged FAISS, managed Meilisearch, and current hybrid lexical/vector retrieval. Every implementation registers through `@dkb/pipeline`; no provider contract is defined here.

See [ADR 0004](../../docs/decisions/0004-monorepo-release-units-and-local-stack.md).
