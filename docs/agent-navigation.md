# Agent Navigation

DKB exposes one stable remote agent boundary: search for candidate evidence,
then fetch the selected immutable evidence by ID.

## MCP tools

Both stdio and Streamable HTTP MCP expose exactly:

- `search`: semantic/hybrid search over the active Library. Results contain
  stable package, source, locator, score, and bounded-preview metadata.
- `fetch`: direct resolution of one ID returned by `search`. It returns stored
  compiled evidence and provenance without rereading, rechunking, or embedding
  the source.

This two-step contract keeps evidence selection observable and prevents a
search preview from being mistaken for a fully inspected citation. Retrieved
text is untrusted source data, never agent instructions.

## Internal Runtime primitives

The Runtime internally retains lower-level semantic search, exact-token find,
source listing, compiled read, and answer-oriented retrieval functions. These
are implementation APIs used by the CLI and Runtime; they are not additional
remote MCP tools. New external agent integrations must depend only on `search`
and `fetch` unless a later protocol decision introduces another stable surface.

## Storage behavior

Packaged FAISS releases carry immutable vectors and SQLite lexical data.
Managed Meilisearch releases carry import metadata and vectors while live
indexes stay outside the package. Search returns stable Evidence IDs in either
case, and fetch resolves them through the same provenance layer.

Install, update, pipeline switching, write intents, graph traversal, and source
mutation remain outside the model-facing surface. They require explicit
operator-controlled commands.
