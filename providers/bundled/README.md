# @sjshovan/dkb-providers-bundled

The developer-preview provider bundle for DKB.

It supplies LlamaIndex/Docling ingestion, independent FastEmbed and TEI
document/query embedding providers, packaged FAISS, managed Meilisearch, and
hybrid lexical/vector retrieval. Every implementation registers through
`@sjshovan/dkb-pipeline`; no provider contract is defined here. TEI/FAISS is the default
for new contexts; FastEmbed remains explicitly selectable.

See [ADR 0005](../../docs/decisions/0005-evidence-and-retrieval-build-graph.md).
