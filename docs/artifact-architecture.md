# DKB Artifact Architecture

DKB keeps the user-facing project simple: a Library, Collection, or DKB is
identified by the `type` in `dkb.json`, and source assets remain the source of
truth. Runtime
retrieval reads compiled chunks, not raw files.

## Current Contracts To Preserve

- Source asset provenance is canonical. A retrieved chunk must still identify
  the DKB, store, asset locator, chunk ordinal, offsets, and hashes needed to
  trace evidence back to its source.
- Compiled indexes are swapped atomically. A query should see the previous
  ready artifact or the next complete artifact, not a half-written index.
- Remote DKBs are read-only targets. Remote discovery and retrieval can expose
  evidence, but cannot become write destinations.
- MCP evidence returned to the model stays compact text. Rich metadata and
  traces remain available out of band.
- Agent navigation is reference-first: semantic and exact search discover
  stable compiled chunk IDs, and an explicit read returns stored evidence with
  provenance. DKB does not choose an agent's investigation workflow.
- One Library activates one retrieval compatibility space. Packages with a
  different embedding space, dimension count, metric, normalization, index
  format, Evidence Profile, or evidence protocol are rejected before they can
  enter the live query snapshot.

## Portable And Runtime-Specific Layers

DKB deliberately separates knowledge identity from retrieval acceleration:

```text
PackageVersion
  -> Evidence Build
       -> Retrieval Build
            -> Runtime
```

- A PackageVersion owns immutable source, source hashes, and release provenance.
- An Evidence Build owns embedding-free Evidence IR for one exact parser,
  chunker, processor, and Evidence-schema recipe.
- A Retrieval Build owns embeddings, index data, mappings, and search metadata
  for one exact Evidence digest and retrieval recipe.

The same PackageVersion may have multiple Evidence Builds. One Evidence Build
may feed FastEmbed/FAISS, TEI/FAISS, or TEI/Meilisearch Retrieval Builds without
reparsing or rechunking. FAISS segments, vectors, and managed-index import data
are reusable only by compatible runtimes and may be deleted and regenerated.

This lets another retrieval system import DKB evidence and provenance without
pretending DKB's vectors are universally portable. DKB's own runtime provides
the out-of-the-box path for users who want install/uninstall without building a
second ingestion stack.

## Build and activation pipeline

1. Source adapters discover immutable PackageVersion assets.
2. The Evidence Profile parses, chunks, and applies every text mutation.
3. DKB writes a content-addressed Evidence Build.
4. The selected embedder and index provider write one Retrieval Build.
5. The Registry signs source, Evidence, and Retrieval receipts as a parent chain.
6. A Runtime stages exact build chains for every installed package and replaces
   the active Library snapshot only after complete validation.

This keeps commodity infrastructure replaceable:

- Docling is the rich filesystem document compiler lane, not the DKB protocol.
- LlamaIndex remains the fallback filesystem lane and the database/source
  adapter lane.
- OCI/ORAS is an artifact transport adapter, not the package identity model.
- Cosign is a signing adapter, not the trust contract itself.

## Compiler Source Routing

Compile-time routing is source-aware, but the Evidence contract is not. All
routes emit the same unembedded DKB records: deterministic Evidence identity,
package/version, store/source identity, source hash, locator/provenance, and
final post-processor text.

- Rich filesystem documents default to Docling conversion plus Docling
  `HybridChunker`: `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.html`, and `.htm`.
- Plain text, Markdown, CSV, and other ordinary filesystem inputs stay on the
  existing LlamaIndex filesystem reader and sentence-splitting path.
- SQLite and external SQL/database sources stay on the existing
  LlamaIndex/database path and are not routed through Docling.
- If a discovered source is claimed by a more specific adapter, the generic
  filesystem route excludes it explicitly.
- Docling fallback is visible. With fallback enabled, failed rich documents are
  retried through the generic filesystem path and the fallback reason is stored
  in record metadata. With fallback disabled, compilation fails before artifact
  promotion.

The tokenizer and chunk budget used by Docling `HybridChunker` are exact
Evidence Profile inputs. The bundled default uses the BGE small tokenizer with
a 512-token budget. Embedding happens only after Evidence IR is complete;
FastEmbed and TEI are independent embedding providers and never share vectors
or compatibility digests.

## Local Compiler Service

Local LlamaIndex compiles use a warm Docker compiler service by default. The
service runs the same pinned compiler image as the one-shot path, binds only to
`127.0.0.1`, and receives isolated per-job staged input under a generated local
compiler-service work directory. It is a compiler helper only; it is not part of
runtime query serving.

The TypeScript compiler wrapper remains responsible for cache planning,
Evidence/embedding reuse, checkpoint state, atomic build promotion, and final
validation. The ingestion service reuses initialized Docling and LlamaIndex
parser/tokenizer state; it does not create final vectors. The selected
embedding provider owns both document and query embeddings.

FastEmbed uses a bounded native sidecar with 32-text batches on the proof host.
TEI uses its own bounded HTTP batches and server-side dynamic batching. Both
paths validate dimensions and finite values, honor cancellation/timeouts, and
cache document vectors by Evidence digest, embedding-space digest, and
normalized text hash.

The 2026-08-28 promotion benchmark used one shared 178-record Evidence Build
from a deterministic, sanitized 32-file real-project slice. Across three valid
runs, TEI reduced fresh single-job median embedding time from 176.7 seconds to
59.4 seconds (66.4%), increased two-job throughput from 1.692 to 3.094 records
per second (82.8%), reduced query p50 from 770.8 ms to 470.3 ms, and reduced
measured combined peak memory from 2.410 GiB to 0.817 GiB. Correctness and
security lifecycle proofs also passed, so `tei-faiss` is the default recipe for
new Libraries. Explicit FastEmbed Libraries remain unchanged and selectable.

Corpus scale is measured after parsing by Evidence records and their text,
not by file count alone. A compile result reports source files/bytes, Evidence
records/chunks, text bytes, per-record size distribution, chunks-per-source
distribution, densest sources, artifact bytes, immutable build-layer bytes,
and the source-to-derived expansion ratio. This makes a dense PDF, table-heavy
document, or large code file visible even when the corpus has few files.

Compilation performs two free-space checks. The first uses source size before
ingestion. The second uses exact Evidence text/record counts plus the selected
embedding dimensions before vectors and indexes are created. Both include a
working-space estimate and a 512 MiB safety reserve by default. A failed check
does not change the active build. Operators may set `DKB_MIN_FREE_DISK_BYTES`
to a different non-negative byte reserve for a controlled environment.

The bounded `npm run benchmark:scale` harness creates mixed dense prose,
Markdown tables, and code only under a `dkb-corpus-scale-*` temporary root. It
removes that root in `finally`, records no corpus in Git, and stops before the
next tier when projected compilation exceeds 15 minutes or estimated working
space exceeds 8 GiB unless an operator explicitly changes those limits. The
checked-in 2026-08-28 reports show 88 records from 134 KiB in 33.4 seconds and
682 records from 1.01 MiB in 3m27s. Derived storage was about 31x source in both
runs because active artifacts and immutable Evidence/Retrieval layers coexist.

Operational commands:

- `dkb compiler start` starts or reuses the warm compiler service.
- `dkb compiler status` reports image/container/readiness and drift.
- `dkb compiler doctor` prints actionable Docker/image/service guidance.
- `dkb compiler stop` stops the warm compiler service.

The CLI presentation layer is intentionally outside the compiler/runtime
contract. Interactive terminals receive a single indeterminate spinner plus a
durable summary for compiler, package, and artifact phases. Package download,
archive verification, single-pass extraction, artifact file verification,
retrieval validation, activation, and local uninstall expose distinct phases.
Determinate bars appear only when the code has a real byte/file/step total.
`--no-progress` and non-TTY output keep concise human-readable results without
ANSI animation. Only explicit `--json` selects machine-readable output. DKB does
not display invented percentages for Docker, compiler, registry, or artifact
phases that do not expose a real total.

The durable compile summary includes source and Evidence sizes, record count,
chunks-per-source p50/p95/max, total derived storage, and expansion ratio.
`--json` returns the complete distributions, largest artifacts, timing stages,
and both disk-capacity preflights.

Set `DKB_LLAMA_COMPILER_SERVICE=0` to use the one-shot compiler container path.
If the pinned image is missing or lacks the current service label, DKB rebuilds
it from `providers/bundled/python/llamaindex` before starting the service.

## First Vertical Slice

This slice introduces an artifact layer without removing the existing compiler
or direct source flows:

- `.dkb/artifacts/dkb-artifact.json` records the artifact layout, hashes,
  compiler adapter, source/chunk counts, and generated files.
- `dkb artifact inspect <path>` prints the artifact manifest if present.
- `dkb artifact validate <path>` checks that all listed artifact files still
  match their hashes.
- `dkb artifact pack <path> --out <file>` creates a deterministic `.dkbpkg`
  archive from the source and compiled artifact tree.
- The compiler can use Docling for rich filesystem documents while keeping
  LlamaIndex/database routes as the stable fallback and tabular source paths.
- `dkb artifact oci-push <archive> <ref>` and `dkb artifact oci-pull <ref>`
  move `.dkbpkg` archives through an OCI registry using ORAS.
- `dkb artifact cosign-keypair`, `cosign-sign`, and `cosign-verify` provide
  the local signing and verification path for OCI artifact references.

The current local vertical slice supports source, Evidence, and Retrieval
layers. OCI transport remains available for a composed package artifact, while
the Laravel Registry distributes the layers through a signed install plan.

Compiled artifact install is not a source import. After verification and
extraction, the runtime validates `.dkb/artifacts/dkb-artifact.json`, promotes
the package through a temporary install directory, preserves `.dkb/artifacts/`,
and refreshes its aggregate catalog from the installed compiled indexes. It must
not recompile raw source as part of that install path.

Uninstall removes the promoted package and refreshes the active aggregate
catalog. Reinstalling the same verified `.dkbpkg` restores its compiled
artifacts without parsing, chunking, or embedding its source again.

ORAS and Cosign remain adapters against the artifact manifest. They should not
change source discovery, compiled retrieval, provenance, or model-facing
evidence behavior.

## Laravel Registry Control Plane

The private Laravel registry is the package control plane, not a replacement for
the DKB compiler or runtime. Laravel owns users, teams, package/version state,
visibility, source and compiled artifact object paths, registry signing keys,
release receipts, queue orchestration, and download authorization.

The DKB CLI defaults to the configured HTTP registry. The default local
development URL is `http://127.0.0.1:8000`, and `dkb registry use <url>` updates
the user-level CLI registry target after validating the registry's package API
and public signing keys. The older file-root registry remains available only as
an explicit local development path via `--registry`/`--root`. In normal use,
publish/list/pull/verify/install target Laravel's `/api/registry` routes with a
bearer token. The CLI uploads source, waits for the default Evidence and
Retrieval Builds, requests a signed install plan, verifies all parent receipts
and archive hashes, and atomically installs exactly that chain.

Laravel does not run Docling, LlamaIndex, FastEmbed, FAISS, or query serving in
its web process. It calls the private DKB registry compiler service over HTTP:
`GET /health` checks readiness and `POST /compile` receives staged job metadata
plus a base64 source archive. The Node service filters out generated DKB state,
rewrites only registry-owned package metadata, runs the pinned compiler path,
and returns build layers, locks, logs, hashes, timings, and provider metadata.
Laravel owns first-class `EvidenceBuild` and `RetrievalBuild` records, signs
each layer against its parent receipt, and may compile another allowlisted
Retrieval target without changing the PackageVersion or Evidence Build.

Published Collections add no second artifact format. The Registry stores an
immutable Collection revision containing exact DKB identities, versions, and
release digests. Clients install those existing signed DKB artifacts into
`vendor/@namespace/name`, then atomically commit the Collection and dependency
ownership edges in the Library lock and ledger.
