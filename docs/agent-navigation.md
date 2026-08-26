# Agent Navigation

DKB exposes compiled knowledge as small navigation primitives. Semantic search
is one way to discover a chunk; it is not the only answer path and it does not
return an entire source by default.

## Runtime Primitives

The MCP server exposes:

- `dkb.semantic_search`: selected query embedder plus the active index-provider view.
  Results are stable references with package, source, locator, chunk offsets,
  hash, score, and a bounded preview.
- `dkb.find`: exact-token search over the package-local SQLite lexical tables.
  The tables are derived from compiled titles, keywords, and chunk text. The
  SQLite chunk catalog remains canonical. Older artifacts without the derived
  table use a bounded in-memory token fallback.
- `dkb.read`: direct fetch of one or more references returned by search. It
  returns stored compiled text and provenance; it does not re-read an adapter,
  re-chunk a source, or embed a document.
- `dkb.sources`: source-asset descriptions and chunk counts without returning
  source content.

`dkb.retrieve_knowledge` remains available as the compatibility wrapper for an
answer-oriented request. New agent integrations should use search results as
references, then call `dkb.read` for the evidence they choose to inspect.

## Storage Boundary

Each package contains compiled chunk text, provenance, and precomputed vectors
for its selected index provider. Packaged FAISS releases carry SQLite lexical
tables and immutable vector segments. Managed Meilisearch releases carry an
import manifest and existing vectors while live indexes stay outside the
package. The runtime opens either one FAISS shard view or fans out across one
immutable managed index per active package release; install, update, and
uninstall affect only that package state.

The first navigation slice deliberately does not add agent reasoning,
automatic multi-step workflows, graph traversal, or AI-generated knowledge
maps. Those are separate capabilities that can be evaluated against the stable
search-reference-read boundary later.
