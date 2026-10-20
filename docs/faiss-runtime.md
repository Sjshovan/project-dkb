# FAISS Runtime Boundary

DKB runtime retrieval is chunk-first. A selected Retrieval Build carries vectors
and package indexes produced from one exact, embedding-free Evidence Build.
FastEmbed and TEI can each produce a FAISS Retrieval Build. Runtime install does
not read raw sources, rechunk documents, or embed documents.

## Package Artifacts

Each FAISS Retrieval Build includes:

- `.dkb/builds/retrieval/<profile>/<digest>/artifacts/faiss/chunks.sqlite`
- `.dkb/builds/retrieval/<profile>/<digest>/artifacts/faiss/chunks.faiss`
- `.dkb/builds/retrieval/<profile>/<digest>/artifacts/faiss/manifest.json`
- `.dkb/builds/retrieval/<profile>/<digest>/artifacts.manifest.json`

The FAISS SQLite file is provider-owned search data, including derived lexical
tokens. Canonical text and provenance live in the DKB-owned
`.dkb/builds/evidence/<profile>/<digest>/evidence.catalog.sqlite`. The FAISS file
is a derived dense vector segment. The provider manifest records package ID,
package version, model, vector dimensions, metric, index type, file hashes, and
chunk count; the generic artifact manifest binds the complete Retrieval tree.

## Install And Update

Install/update order:

1. Verify the PackageVersion, Evidence, Retrieval, and install-plan receipt chain.
2. Validate package-local FAISS catalog and segment.
3. Promote the source and exact build chain into `vendor/@namespace/name`.
4. Point the staged Runtime snapshot at the immutable Evidence and Retrieval paths.
5. Load active package segments into one in-memory FAISS `IndexShards` view.
6. Mark the runtime query snapshot active only after the expected package/version is present.

Uninstall removes the package directory and invalidates the runtime query snapshot. The next snapshot loads only remaining package segments.

## Retrieval

HTTP and MCP retrieval share the same query path:

1. Embed the query through the provider recorded by the active Retrieval Profile.
2. Search the active FAISS `IndexShards` view.
3. Map FAISS numeric IDs back to deterministic DKB chunk IDs.
4. Resolve evidence text and provenance from the package-local Evidence catalog.
5. Return model-facing evidence while keeping metadata/provenance available in the response metadata channel.

FAISS never embeds text and does not own provenance. It only stores/searches vectors. Agent navigation also exposes exact-token search over the derived lexical tables and direct read by stable chunk reference; neither path invokes a source adapter during normal retrieval.

## Compatibility

One Runtime serves one Library. All active packages in that Library must match
the exact Evidence Profile and retrieval compatibility digest: embedding
provider/space, pinned model revision, dimensions, transforms, normalization,
metric, FAISS format, and Runtime protocol. If a package differs, activation
fails and the previous config, Runtime lock, installed paths, managed-index
state, and query snapshot are restored.


## Performance measurement

Measure complete validated Runtime queries separately from query embedding and
index search. Record the corpus, exact provider/build identities, cold startup,
warm latency distribution, concurrency and memory. See the
[benchmark methodology](benchmarks/README.md).
