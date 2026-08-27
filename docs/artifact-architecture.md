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
  format, or evidence protocol are rejected before they can enter the live
  query snapshot. Parser, chunker, processor, and provider-code identities
  remain exact build provenance.

## Portable And Runtime-Specific Layers

DKB deliberately separates knowledge identity from retrieval acceleration:

- Original source assets and `evidence.ir.json` are portable. Evidence IR is
  embedding-free and preserves stable evidence IDs, source IDs, hashes,
  locators, text, and chunk boundaries.
- `dkb-profile.lock.json` records the exact compiler, extraction, embedding,
  and index profile used to produce a compiled release.
- FAISS segments, vectors, and profile-specific runtime catalogs are derived
  artifacts. They are reusable only by compatible runtimes and may be deleted
  and regenerated from canonical knowledge.

This lets another retrieval system import DKB evidence and provenance without
pretending DKB's vectors are universally portable. DKB's own runtime provides
the out-of-the-box path for users who want install/uninstall without building a
second ingestion stack.

## Thin Architecture Direction

The production-facing core should become a small artifact pipeline:

1. Source adapters discover and read public source assets.
2. Compiler adapters convert assets into provenance-bearing chunks.
3. DKB writes versioned compiled artifacts under `.dkb/artifacts/`.
4. Artifact transport moves compiled packages without redefining retrieval.
5. Signature verification proves who published an artifact and whether bytes
   match the manifest.

This keeps commodity infrastructure replaceable:

- Docling is the rich filesystem document compiler lane, not the DKB protocol.
- LlamaIndex remains the fallback filesystem lane and the database/source
  adapter lane.
- OCI/ORAS is an artifact transport adapter, not the package identity model.
- Cosign is a signing adapter, not the trust contract itself.

## Compiler Source Routing

Compile-time routing is source-aware, but the output contract is not. All
routes emit the same DKB compiled chunk records: deterministic chunk identity,
package/version, store/source identity, source hash, locator/provenance, text,
and FastEmbed vector.

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

The tokenizer used by Docling `HybridChunker` is aligned to the configured
embedding model, defaulting to `BAAI/bge-small-en-v1.5` with a 512-token chunk
budget. FastEmbed remains the only embedding implementation for compiled
document and query vectors.

## Local Compiler Service

Local LlamaIndex compiles use a warm Docker compiler service by default. The
service runs the same pinned compiler image as the one-shot path, binds only to
`127.0.0.1`, and receives isolated per-job staged input under a generated local
compiler-service work directory. It is a compiler helper only; it is not part of
runtime query serving.

The TypeScript compiler wrapper remains responsible for cache planning,
checkpoint/resume state, atomic artifact promotion, and final artifact
validation. The service only reuses initialized Docling, LlamaIndex tokenizer,
and FastEmbed state while compiling the staged job request.

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

The current local vertical slice is intentionally narrow: compile source,
package the compiled artifact, push to an OCI Registry, sign and verify the
immutable digest, pull the package, install it into a Library, and
retrieve evidence through MCP.

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
bearer token. The CLI uploads source as a source archive, waits for the Laravel
compile job to publish the immutable version, downloads the compiled `.dkbpkg`,
verifies the embedded receipt against Laravel's public registry keys, and
installs the verified archive into the local Library.

Laravel does not run Docling, LlamaIndex, FastEmbed, FAISS, or query serving in
its web process. It calls the private DKB registry compiler service over HTTP:
`GET /health` checks readiness and `POST /compile` receives staged job metadata
plus a base64 source archive. The Node service filters out generated DKB state,
rewrites only registry-owned package metadata, runs the pinned compiler path,
and returns the compiled archive, lock payload, artifact manifest, logs, hashes,
and compiler metadata. Laravel validates that response, signs the receipt, and
publishes the artifact.

Published Collections add no second artifact format. The Registry stores an
immutable Collection revision containing exact DKB identities, versions, and
release digests. Clients install those existing signed DKB artifacts into
`vendor/@namespace/name`, then atomically commit the Collection and dependency
ownership edges in the Library lock and ledger.
