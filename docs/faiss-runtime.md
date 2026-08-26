# FAISS Runtime Boundary

DKB runtime retrieval is chunk-first. Published packages carry compiled chunk records produced by the compiler path, including Docling rich-file chunks and LlamaIndex/database chunks, all embedded with FastEmbed. Runtime install does not read raw sources, rechunk documents, or embed documents.

## Package Artifacts

Each compiled package includes:

- `.dkb/artifacts/faiss/chunks.sqlite`
- `.dkb/artifacts/faiss/chunks.faiss`
- `.dkb/artifacts/faiss/manifest.json`
- LlamaIndex compiler record shards under `.dkb/artifacts/llamaindex.records/`

The SQLite catalog is DKB-owned canonical runtime data for chunk text and provenance. It also contains a derived `lexical_tokens` table for exact-token navigation. The FAISS file is a derived dense vector segment. The manifest records package ID, package version, model, vector dimensions, metric, index type, file hashes, and chunk count.

## Install And Update

Install/update order:

1. Verify package receipt, package tree hash, and artifact hashes.
2. Validate package-local FAISS catalog and segment.
3. Promote the package into `vendor/@namespace/name` with its signed receipt.
4. Refresh the local aggregate catalog without rebuilding a global search index.
5. Load active package segments into one in-memory FAISS `IndexShards` view.
6. Mark the runtime query snapshot active only after the expected package/version is present.

Uninstall removes the package directory and invalidates the runtime query snapshot. The next snapshot loads only remaining package segments.

## Retrieval

HTTP and MCP retrieval share the same query path:

1. Embed the query through the configured FastEmbed query endpoint.
2. Search the active FAISS `IndexShards` view.
3. Map FAISS numeric IDs back to deterministic DKB chunk IDs.
4. Resolve evidence text and provenance from the package-local SQLite catalogs.
5. Return model-facing evidence while keeping metadata/provenance available in the response metadata channel.

FAISS never embeds text and does not own provenance. It only stores/searches vectors. Agent navigation also exposes exact-token search over the derived lexical tables and direct read by stable chunk reference; neither path invokes a source adapter during normal retrieval.

## Compatibility

One Runtime serves one Library. All active packages in that Library must use
the same embedding profile: compiler ID, model, dimensions, and metric. If a
package differs, activation fails with a clear embedding-profile mismatch and
the previous manifest, lock, ledger, installed paths, and query catalog are
restored.

## Current Performance Gate

The current accepted runtime result on the existing 2,004-record stress corpus is:

- Warm direct retrieval: p50 72.857 ms, p95 83.978 ms.
- Warm HTTP retrieval: p50 64.32 ms, p95 87.815 ms.
- Cold first direct retrieval: 1031.458 ms.
- Evidence correctness: all measured stress queries returned the expected marker evidence.

This is accepted as close enough for the current production boundary. It does not meet the earlier aspirational 34.5 ms target against the prior txtai baseline. The remaining non-blocking performance observation is that most measured warm latency is inside `vectorQuery`, which includes FastEmbed query embedding plus FAISS helper search. No query-path workaround is planned without a later explicit performance task.
