# Codename DKB

DKB is a TypeScript reference implementation for packaging source knowledge
into local, installable knowledgebases.

The project provides:

- `dkb.json` package manifests
- source compilation into chunk and provenance indexes
- registry-local source discovery for root-level raw knowledge files
- signed `.dkbpkg` package archives
- local registry publish and install flows
- runtime retrieval over a compact CLI and MCP surface

## Install

```bash
npm install
npm run build
```

## Basic Usage

Interactive terminals get concise phase output for long-running commands such as
compile, compiler service management, publish, install, artifact pack/pull, and
package removal. Automation stays JSON-first:

```bash
dkb --json compile ./my-dkb --compiler llamaindex --artifact-profile faiss-package
dkb --no-progress compiler status
```

`--json`, `--no-progress`, and non-TTY/piped output do not emit spinners,
progress bars, or ANSI presentation output.

Serve a folder as a local knowledge registry:

```bash
cd ~/SecondBrain
dkb serve
```

`dkb serve` resolves the current folder first, then walks upward to the nearest
parent registry manifest. If no registry exists and the command is running in an
interactive terminal, it can initialize the current folder as a registry,
compile eligible local source files, and start the runtime against that folder.
Existing files are not moved or deleted during initialization.

For scripts and other noninteractive environments, initialize explicitly first:

```bash
cd ~/SecondBrain
dkb init --here --yes
dkb serve
```

Use `--root` when the registry folder should be selected explicitly:

```bash
dkb serve --root ~/SecondBrain
```

Create a package:

```bash
node dist/src/cli/index.js init "My DKB"
```

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

Move a compiled package through a local OCI registry:

```bash
node dist/src/cli/index.js artifact tools
node dist/src/cli/index.js artifact oci-push ./my-dkb.dkbpkg localhost:5000/dkb/my-dkb:0.1.0
node dist/src/cli/index.js artifact cosign-keypair --out ./cosign --password "$COSIGN_PASSWORD"
node dist/src/cli/index.js artifact cosign-sign localhost:5000/dkb/my-dkb@sha256:<digest> --key ./cosign.key --password "$COSIGN_PASSWORD"
node dist/src/cli/index.js artifact cosign-verify localhost:5000/dkb/my-dkb@sha256:<digest> --key ./cosign.pub
node dist/src/cli/index.js artifact oci-pull localhost:5000/dkb/my-dkb:0.1.0 --out ./pulled
node dist/src/cli/index.js artifact install ./pulled --runtime-root .dkb/runtime
```

Use the configured package registry. By default the CLI targets the local
development registry at `http://127.0.0.1:8000`; later this can be pointed at a
hosted registry or a registry you operate yourself:

```bash
node dist/src/cli/index.js registry status
node dist/src/cli/index.js registry use http://127.0.0.1:8000
node dist/src/cli/index.js registry packages
node dist/src/cli/index.js publish ./my-dkb
node dist/src/cli/index.js install my-dkb
```

For local CLI fixture work, the in-process development registry is still
available explicitly:

```bash
node dist/src/cli/index.js registry serve --root .dkb/mock-registry
node dist/src/cli/index.js publish ./my-dkb --registry .dkb/mock-registry
node dist/src/cli/index.js install my-dkb --registry .dkb/mock-registry
```

Retrieve knowledge:

```bash
node dist/src/cli/index.js retrieve "what does this knowledgebase say?"
```

Registry-local files become queryable after compilation:

```bash
node dist/src/cli/index.js compile .
node dist/src/cli/index.js retrieve "what changed in my local notes?"
```

Run the MCP server:

```bash
node dist/src/cli/index.js mcp serve
```

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
but the folder-first flow is the default way to bind a runtime to a specific
registry root.

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
