# Codename DKB

DKB is a TypeScript reference implementation for packaging source knowledge
into local, installable knowledgebases.

The project provides:

- `dkb.json` package manifests
- flat local Libraries with ledger-based installed state
- first-class namespaced DKBs and Collections
- source compilation into chunk and provenance indexes
- direct-child authoring discovery and npm-style `vendor/` installs
- signed `.dkbpkg` package archives
- remote Registry publish, install, update, and uninstall flows
- runtime retrieval over a compact CLI and MCP surface

## Documentation

- [`docs/cli-ux.md`](docs/cli-ux.md) — implemented human and automation output contract
- [`docs/library-and-collections.md`](docs/library-and-collections.md) — Library layout, Collection snapshots, locks, and lifecycle
- [`docs/decisions/`](docs/decisions/) — accepted directions and implementation status
- [`docs/artifact-architecture.md`](docs/artifact-architecture.md) — portable evidence and compiled artifact boundaries
- [`docs/agent-navigation.md`](docs/agent-navigation.md) — model-facing search, reference, read, and source primitives
- [`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md) — local and remote MCP authority and security boundary
- [`docs/faiss-runtime.md`](docs/faiss-runtime.md) — installed FAISS/SQLite runtime model
- [`docs/remote-hosting.md`](docs/remote-hosting.md) — verified hosted-runtime discovery

## Install

```bash
npm install
npm run build
```

## Basic Usage

The CLI is human-readable by default, including when output is redirected.
Interactive terminals add concise phase output for long-running commands such
as compile, publish, install, artifact transport, verification, and package
removal. Automation opts into one JSON document explicitly:

```bash
dkb --json compile ./my-dkb --compiler llamaindex --artifact-profile faiss-package
dkb --no-progress compiler status
```

`--no-progress` keeps the human-readable result but disables spinners, progress
bars, and ANSI presentation. `--json` disables presentation and emits only
machine-readable JSON, including structured failures. Non-TTY/piped output is
still human-readable unless `--json` is present.

Install performs release and runtime preflight before downloading. Installing
the same immutable release is a successful no-op; an incomplete install is
reported immediately with `--force` as the repair action. A real install shows
download, archive verification, single-pass extraction, package/signature
verification, retrieval-index validation, and activation phases before its
final result and `Done.`

Every initialized DKB Library remembers its upstream Registry URL in
`.dkb/config.json`. Bare `dkb init` initializes the
current directory, asks for the upstream URL, and attempts to verify it. An
unavailable upstream never blocks local creation: the CLI stores the URL, warns,
and prints the `dkb registry use <url>` command for retrying later. Set it later
from that folder with `dkb registry use <url>`, or target one explicitly with
`--root <path>`.
Command `--url` and `DKB_REGISTRY_URL` remain temporary overrides; the user
config is now a fallback. `dkb list` shows the resolved registry and source.

See [`docs/cli-ux.md`](docs/cli-ux.md) for the complete output and exit-code
contract.

Serve a Library through one local runtime:

```bash
cd ~/SecondBrain
dkb serve
```

`dkb serve` resolves the current folder first, then walks upward to the nearest
parent Library manifest. If no Library exists and the command is running in an
interactive terminal, it can initialize the current folder as a Library,
compile eligible local source files, and start the runtime against that folder.
Existing files are not moved or deleted during initialization.

For scripts and other noninteractive environments, initialize explicitly first:

```bash
cd ~/SecondBrain
dkb init --registry-url http://127.0.0.1:8000 --yes
dkb serve
```

Use `--root` when the Library should be selected explicitly:

```bash
dkb serve --root ~/SecondBrain
```

Create a namespaced DKB inside a Library:

```bash
cd ~/SecondBrain
dkb init @my-team/my-dkb
```

Create a Collection, add exact dependencies, and publish its immutable Registry
snapshot:

```bash
dkb collection create @my-team/starter-knowledge
dkb collection add @my-team/starter-knowledge @my-team/my-dkb --version 0.1.0
dkb collection publish ./starter-knowledge
```

A Library is flat. Editable DKBs and Collections are direct child folders;
Registry downloads live only under `vendor/@namespace/name`. The manifest says
what an entry is, while `dkb.json`, `dkb-lock.json`, and `.dkb/state.sqlite`
say what is active. Filesystem presence alone never means installed. See
[`docs/library-and-collections.md`](docs/library-and-collections.md).

Compile and inspect a package:

```bash
node dist/src/cli/index.js validate ./my-dkb
node dist/src/cli/index.js compile ./my-dkb --compiler llamaindex --artifact-profile faiss-package
node dist/src/cli/index.js verify ./my-dkb
node dist/src/cli/index.js inspect ./my-dkb
node dist/src/cli/index.js artifact inspect ./my-dkb
node dist/src/cli/index.js artifact validate ./my-dkb
node dist/src/cli/index.js artifact pack ./my-dkb --out ./my-dkb.dkbpkg
```

The LlamaIndex/Docling/FastEmbed compiler runs through a local-only Docker
service by default so repeated compiles reuse initialized parser and embedding
state. The service is separate from the query runtime:

```bash
node dist/src/cli/index.js compiler start
node dist/src/cli/index.js compiler status
node dist/src/cli/index.js compiler doctor
node dist/src/cli/index.js compiler stop
```

Set `DKB_LLAMA_COMPILER_SERVICE=0` to force the older one-shot compiler
container path for a single process.

Each Library has one retrieval profile. The profile locks the compiler,
parser, chunker, embedding model, dimensions, distance metric, and relevant
versions used by every installed package. Profile changes are whole-registry,
staged migrations: DKB compiles and validates the complete replacement before
atomically promoting it.

```bash
node dist/src/cli/index.js profile show .
node dist/src/cli/index.js profile plan . --model BAAI/bge-base-en-v1.5
node dist/src/cli/index.js profile migrate . --model BAAI/bge-base-en-v1.5 --yes
```

The built-in FastEmbed profiles currently resolve `BAAI/bge-small-en-v1.5` to
384 dimensions and `BAAI/bge-base-en-v1.5` to 768 dimensions. A package whose
profile differs from the active runtime is rejected before activation.

Move a compiled package through a local OCI registry:

```bash
node dist/src/cli/index.js artifact tools
node dist/src/cli/index.js artifact oci-push ./my-dkb.dkbpkg localhost:5000/dkb/my-dkb:0.1.0
node dist/src/cli/index.js artifact cosign-keypair --out ./cosign --password "$COSIGN_PASSWORD"
node dist/src/cli/index.js artifact cosign-sign localhost:5000/dkb/my-dkb@sha256:<digest> --key ./cosign.key --password "$COSIGN_PASSWORD"
node dist/src/cli/index.js artifact cosign-verify localhost:5000/dkb/my-dkb@sha256:<digest> --key ./cosign.pub
node dist/src/cli/index.js artifact oci-pull localhost:5000/dkb/my-dkb:0.1.0 --out ./pulled
node dist/src/cli/index.js artifact install ./pulled --library ~/SecondBrain
```

Use the configured remote Registry. By default the CLI targets the development
Registry at `http://127.0.0.1:8000`; it can instead point at a hosted Registry
or one you operate yourself:

```bash
node dist/src/cli/index.js registry status
node dist/src/cli/index.js registry use http://127.0.0.1:8000
node dist/src/cli/index.js registry packages
node dist/src/cli/index.js publish ./my-dkb
node dist/src/cli/index.js install @my-team/my-dkb --version 0.1.0
node dist/src/cli/index.js list
node dist/src/cli/index.js uninstall @my-team/my-dkb
```

For local CLI fixture work, the in-process development registry is still
available explicitly:

```bash
node dist/src/cli/index.js registry serve --root .dkb/mock-registry
node dist/src/cli/index.js publish ./my-dkb --registry .dkb/mock-registry
node dist/src/cli/index.js install @my-team/my-dkb --version 0.1.0 --registry .dkb/mock-registry --library ~/SecondBrain
```

Retrieve knowledge:

```bash
node dist/src/cli/index.js retrieve "what does this knowledgebase say?"
```

Library knowledge becomes queryable after compilation or verified install:

```bash
node dist/src/cli/index.js compile .
node dist/src/cli/index.js retrieve "what changed in my local notes?"
```

Run the MCP server:

```bash
node dist/src/cli/index.js mcp serve
```

The local stdio server keeps the full DKB tool surface. Remote agents receive a
separate read-only HTTP surface with only `search` and `fetch`:

```bash
DKB_LIBRARY_PATH=/knowledge/library \
DKB_QUERY_EMBEDDER_URL=http://127.0.0.1:8090/embed \
DKB_MCP_BEARER_TOKEN=replace-with-a-secret \
node dist/src/cli/index.js mcp serve-http --host 127.0.0.1 --port 7332
```

HTTP MCP requires a bearer token and validates Host and Origin headers. Set
`DKB_MCP_PUBLIC_BASE_URL` when fetched evidence should include public citation
URLs, and opt into `DKB_MCP_PUBLIC_DOCUMENTS=true` only when those immutable
evidence documents are safe to expose. See
[`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md) for the ChatGPT boundary and the
temporary proof workflow.

Discover and query registry-verified hosted runtimes:

    node dist/src/cli/index.js remote search docs
    node dist/src/cli/index.js remote add publisher/docs --version 1.4.0
    node dist/src/cli/index.js remote list
    node dist/src/cli/index.js remote query <remote-id> "How are retries configured?"

The runtime exposes /.well-known/dkb.json for package discovery. A registry
must verify the endpoint and sign its package/version/tree-hash relationship
before MCP treats it as trusted. A remote package is never installed
automatically; dkb.install_package requires an explicit user-approved call
and downloads the verified .dkbpkg from the registry.

Run the lower-level runtime server directly:

```bash
node dist/src/cli/index.js runtime serve --state-root ~/SecondBrain
```

Docker-backed runtime commands remain available for local process management,
but the folder-first flow is the default. One runtime serves one Library; the
Library may contain many DKBs and Collections but it has one compatible
retrieval profile and one upstream Registry configuration.

## Runtime Artifacts

Generated artifacts are written under `.dkb/` and are not intended to be
committed:

```text
.dkb/artifacts/
.dkb/cache/
.dkb/locks/
.dkb/runs/
.dkb/trace.sqlite
```

`source.index` is the chunk-first retrieval artifact. It stores compiled source
units with source asset provenance, chunk ordinals, offsets, hashes, and
locators. `dkb-artifact.json` is the versioned artifact manifest for the
compiled layout and file hashes. Verified compiled artifacts can be installed
directly into a runtime without recompiling source; the runtime preserves the
package `.dkb/artifacts/` state and refreshes its aggregate catalog from those
compiled indexes. Runtime retrieval reads compiled artifacts and returns compact
evidence text to the model; metadata remains available through trace APIs.

`evidence.ir.json` is the portable, embedding-free interchange layer. It keeps
stable evidence/source identities, source hashes, locators, text, and chunk
boundaries without carrying vectors. FAISS segments, embedding vectors, and
profile-specific chunk artifacts remain compiled runtime outputs and can be
regenerated from canonical sources plus Evidence IR.

The LlamaIndex compiler image includes a Docling rich-file lane for supported
filesystem documents. By default `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.html`,
and `.htm` are converted with Docling and chunked with Docling
`HybridChunker`; plain text, Markdown, CSV, SQLite, and configured database
sources continue through the existing LlamaIndex/database lanes. Every lane
emits the same DKB compiled chunk and provenance records, so package install,
FAISS import, HTTP retrieval, and MCP retrieval do not need source-specific
runtime behavior.

Docling routing can be controlled in the compiler container with:

```text
DKB_DOCLING_RICH_FILES=1
DKB_DOCLING_FALLBACK=1
DKB_DOCLING_EXTENSIONS=.pdf,.docx,.pptx,.xlsx,.html,.htm
```

When fallback is enabled, a Docling conversion failure is recorded in chunk
metadata and the source is retried through the normal filesystem reader. When
fallback is disabled, the compile fails before a new artifact is promoted.

## Agent Navigation

The MCP runtime exposes composable compiled-knowledge operations:

```text
dkb.semantic_search  -> discover conceptually related chunk references
dkb.find             -> find exact terms and identifiers
dkb.read             -> read selected compiled chunks with provenance
dkb.sources          -> describe active source assets and chunk counts
```

Semantic search uses the active FAISS shard view. Exact search uses the
package-local SQLite lexical tables generated with the compiled chunk catalog.
Both return stable package/source/chunk references first; `dkb.read` is the
explicit evidence step. The existing `dkb.retrieve_knowledge` tool remains
available for compatibility with answer-oriented integrations.
