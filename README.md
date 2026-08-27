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
- [`docs/provider-pipeline.md`](docs/provider-pipeline.md) — plugin resolution, pipeline targets, and managed-index lifecycle
- [`docs/remote-hosting.md`](docs/remote-hosting.md) — verified hosted-runtime discovery

## Install

```bash
npm install
npm run build
npm link
```

The final command makes `dkb` available on this host. After later source
changes, rebuild in this checkout; the global link continues to use it.

## Basic Usage

The CLI is human-readable by default, including when output is redirected.
Interactive terminals add concise phase output for long-running commands such
as compile, publish, install, artifact transport, verification, and package
removal. Automation opts into one JSON document explicitly:

```bash
dkb --json compile ./my-dkb
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

## Host Inventory

DKB remembers resources used on this machine in `~/.dkb/host.json`. It is a
catalog of names, paths, URLs, selections, and optional local launch metadata;
it never stores credentials, package data, or pipeline configuration. The
catalog is not authoritative and can be rebuilt by registering resources again.

```bash
dkb library list
dkb library register ~/SecondBrain --name personal
dkb library use personal

dkb registry register team https://registry.example.com
dkb registry list --check
dkb registry use team

dkb runtime register home http://127.0.0.1:7331 --library personal --no-verify
dkb runtime list --check
dkb runtime use home
```

Once a Library is selected, `dkb list`, `dkb install`, and other Library-bound
commands work from any directory. They still prefer an explicit `--library`,
then `DKB_LIBRARY_PATH`, then the nearest Library, before the selected Library.
Runtime client commands similarly prefer explicit `--url`, then
`DKB_RUNTIME_URL`, then the selected Runtime, with localhost as the final
default. Lists never scan disks or networks; Registry and Runtime probes happen
only with `--check`.

`dkb init` automatically registers a Library. Using a valid older Library
through the CLI registers it opportunistically. Unregistering only forgets the
shortcut—it never deletes knowledge, stops a Runtime, or removes a Registry.
See [Decision 0003](docs/decisions/0003-host-inventory-and-context-selection.md)
for the authority and recovery boundaries.

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
dkb validate ./my-dkb
dkb compile ./my-dkb
dkb verify ./my-dkb
dkb inspect ./my-dkb
dkb artifact inspect ./my-dkb
dkb artifact validate ./my-dkb
dkb artifact pack ./my-dkb --out ./my-dkb.dkbpkg
```

The bundled LlamaIndex/Docling ingestion provider runs through a local Docker
service by default so repeated compiles reuse initialized parser state. The
same provider pipeline is invoked directly by the local CLI and through HTTP by
the Registry compiler:

```bash
dkb compiler start
dkb compiler status
dkb compiler doctor
dkb compiler stop
```

Set `DKB_LLAMA_COMPILER_SERVICE=0` to force the older one-shot compiler
container path for a single process.

Each Library has one active pipeline target. A target selects ingestion (or a
parser and chunker), ordered processors, embedding, index, retrieval, and
provider-owned options. The generated `dkb-profile.lock.json` records the exact
providers and a separate compatibility digest for the embedding and retrieval
space used by every installed package.

```bash
dkb pipeline show .
dkb pipeline verify .
dkb plugin list .
```

The bundled default target selects Docling/LlamaIndex, FastEmbed with
`BAAI/bge-small-en-v1.5` at 384 dimensions, packaged FAISS, and DKB hybrid
retrieval. A target can instead select the 768-dimensional base model or the
managed `@dkb/meilisearch` index provider. An incompatible target or package is
rejected before activation; use `pipeline set ... --no-activate` to stage a
future target without changing the working Library. See
[`docs/provider-pipeline.md`](docs/provider-pipeline.md).

Move a compiled package through a local OCI registry:

```bash
dkb artifact tools
dkb artifact oci-push ./my-dkb.dkbpkg localhost:5000/dkb/my-dkb:0.1.0
dkb artifact cosign-keypair --out ./cosign --password "$COSIGN_PASSWORD"
dkb artifact cosign-sign localhost:5000/dkb/my-dkb@sha256:<digest> --key ./cosign.key --password "$COSIGN_PASSWORD"
dkb artifact cosign-verify localhost:5000/dkb/my-dkb@sha256:<digest> --key ./cosign.pub
dkb artifact oci-pull localhost:5000/dkb/my-dkb:0.1.0 --out ./pulled
dkb artifact install ./pulled --library ~/SecondBrain
```

Use the configured remote Registry. By default the CLI targets the development
Registry at `http://127.0.0.1:8000`; it can instead point at a hosted Registry
or one you operate yourself:

```bash
dkb registry status
dkb registry use http://127.0.0.1:8000
dkb registry packages
dkb publish ./my-dkb
dkb install @my-team/my-dkb --version 0.1.0
dkb list
dkb uninstall @my-team/my-dkb
```

Start the complete developer-preview stack when you need a local Registry,
compiler, Runtime, and MCP endpoint:

```bash
dkb stack up
dkb stack status --check
dkb publish ./my-dkb
dkb install @my-team/my-dkb --version 0.1.0
```

Retrieve knowledge:

```bash
dkb retrieve "what does this knowledgebase say?"
```

Library knowledge becomes queryable after compilation or verified install:

```bash
dkb compile .
dkb retrieve "what changed in my local notes?"
```

Run the MCP server:

```bash
dkb mcp serve
```

Both the local stdio transport and remote HTTP transport are Runtime-owned and
expose only the read-only `search` and `fetch` tools:

```bash
DKB_LIBRARY_PATH=/knowledge/library \
DKB_QUERY_EMBEDDER_URL=http://127.0.0.1:8090/embed \
DKB_MCP_BEARER_TOKEN=replace-with-a-secret \
dkb mcp serve-http --host 127.0.0.1 --port 7332
```

HTTP MCP requires a bearer token and validates Host and Origin headers. Set
`DKB_MCP_PUBLIC_BASE_URL` when fetched evidence should include public citation
URLs, and opt into `DKB_MCP_PUBLIC_DOCUMENTS=true` only when those immutable
evidence documents are safe to expose. See
[`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md) for the ChatGPT boundary and the
temporary proof workflow.

Discover and query registry-verified hosted runtimes:

    dkb remote search docs
    dkb remote add publisher/docs --version 1.4.0
    dkb remote list
    dkb remote query <remote-id> "How are retries configured?"

The runtime exposes /.well-known/dkb.json for package discovery. A registry
must verify the endpoint and sign its package/version/tree-hash relationship
before MCP treats it as trusted. A remote package is never installed
automatically; dkb.install_package requires an explicit user-approved call
and downloads the verified .dkbpkg from the registry.

Run the lower-level runtime server directly:

```bash
dkb runtime serve --state-root ~/SecondBrain
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
.dkb/plugins/
.dkb/runs/
.dkb/trace.sqlite
```

`.dkb/plugins/` contains operator-installed Library-local code and is preserved
locally, but it and `.dkb/config.json` are always excluded from `.dkbpkg`
artifacts. Knowledge packages cannot install or select executable plugins.

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
index-provider import, HTTP retrieval, and MCP retrieval do not need
source-specific runtime behavior.

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

Semantic search uses the active index provider. Packaged FAISS opens immutable
package segments as one shard view; managed Meilisearch fans out across one
immutable index per active package release and fuses the results. Exact search
uses provider-supplied lexical search when available and otherwise the compiled
source catalog. Both return stable package/source/chunk references first;
`dkb.read` is the explicit evidence step. The existing
`dkb.retrieve_knowledge` tool remains available for compatibility with
answer-oriented integrations.
