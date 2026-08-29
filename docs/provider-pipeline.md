# DKB Provider Pipeline

DKB owns the package, evidence, compatibility, install, and retrieval
contracts. Providers own replaceable implementations behind those contracts.
The local CLI and remote Registry compiler call the same TypeScript job runner;
Laravel submits a named target and does not select parser images, embedding
models, or index internals.

## Resolution and storage

A plugin is a directory containing `plugin.mjs` at:

```text
<context>/.dkb/plugins/@namespace/name/plugin.mjs
~/.dkb/plugins/@namespace/name/plugin.mjs
```

The module exports `id`, `version`, and `setup(context)`. It needs no plugin
manifest and is not downloaded from a plugin registry. DKB resolves each
selected plugin independently in this order:

1. the current Library, Runtime, or Registry compiler context;
2. current-user global storage;
3. bundled providers.

Only selected plugins are loaded. A present but broken local override is an
error; DKB never silently falls back to a global or bundled implementation.
Every provider host is context-local and disposed independently, so two
Runtimes in one process may select different overrides without sharing state.

Plugin code and operator configuration are never package content. Archive,
artifact, and local compiled-install filters exclude `.dkb/plugins/` and
`.dkb/config.json`. A DKB uploaded as knowledge cannot execute code or change a
Library's pipeline.

## Profiles, targets, and stored builds

User-global bindings live in `~/.dkb/config.json`; automation may relocate that
directory with `DKB_GLOBAL_ROOT`. Context overrides live in
`<context>/.dkb/config.json`. Both documents require the exact
`dkb.config.v2` format marker; DKB has no legacy configuration reader. A target
selects:

- one fused Evidence provider, or one parser plus one chunker;
- zero or more ordered document, chunk, or record processors;
- one document/query embedding provider;
- one packaged or managed index provider;
- one retrieval provider;
- arbitrary options keyed by provider ID.

Options may name environment variables such as `urlEnv` or `apiKeyEnv`.
Credential-looking inline values are rejected. The generated
locks are build receipts, not hand-authored configuration. An Evidence Profile
records the exact parser, chunker, processors, Evidence IR schema, options, and
provider code. A target references one Evidence Profile and adds embedding,
index, and retrieval providers. The resolved receipts keep these identities
separate and preserve execution order: fused Evidence or parser then chunker,
followed by embedding, index, and retrieval:

- Evidence Profile digest: the exact evidence-building recipe;
- Evidence digest: the exact package-specific Evidence IR;
- Retrieval Profile digest: the exact search recipe and required Evidence Profile;
- compatibility digest: the Runtime-visible embedding/index space; and
- Retrieval Build digest: the exact derived artifacts attached to one Evidence digest.

Profiles are recipes. Evidence and Retrieval Builds are stored results. DKB
never chooses a build by recency or target name alone.

`dkb pipeline set` validates the full candidate before atomically writing the
configuration. `dkb pipeline use` prepares an exact build chain for every
installed package, then asks the Runtime to switch the complete Library
snapshot. Registry packages download signed missing layers; editable local
packages reuse matching Evidence IR when possible and compile through the same
shared runner. Failure leaves the previous target active.

## Contracts

The provider boundary supports both fused and separated Evidence production:

```text
folder
  -> Evidence provider OR parser -> chunker
  -> ordered document/chunk/record processors
  -> embedding-free Evidence Build
  -> selected document embedder
  -> package index compiler
  -> Retrieval Build
```

At runtime the selected embedding provider embeds queries. The selected index
provider validates packages, prepares managed state if needed, opens a runtime
view, searches, verifies activation, and cleans up a release. All providers
return DKB source-unit identities; the stable `dkb.evidence.v1` layer resolves
text, provenance, citations, and trace metadata independently of the backend.

The shared runner normalizes fused or separated Evidence output into DKB
pipeline records before Evidence IR is materialized. Every text-changing
processor runs before embedding, so Evidence text, IDs, hashes, vectors, and
provenance cannot drift. Provider-native diagnostics may be written only to an
optional provider-namespaced diagnostics directory. Native engine objects are
never canonical package, build, provenance, or Runtime input.

Processors register one `mutate` function plus a stage. The runner applies them
in configured order, permits a processor to drop a value by returning `null`,
and records stage, order, version, and source-code digest in build receipts.

## Bundled providers

| ID | Role | Behavior |
| --- | --- | --- |
| `@dkb/evidence-docling-llamaindex` | Evidence | Docling rich-file parsing plus LlamaIndex fallbacks |
| `@dkb/embedding-fastembed` | embedding | native FastEmbed document/query vectors through the bounded sidecar |
| `@dkb/embedding-tei` | embedding | TEI document/query vectors through its HTTP contract |
| `@dkb/index-faiss` | packaged index | immutable package-local FAISS and SQLite artifacts |
| `@dkb/index-meilisearch` | managed index | package vector import into immutable server-side indexes |
| `@dkb/retrieval-hybrid` | retrieval | stable DKB evidence protocol and fusion behavior |

FAISS artifacts travel inside the release. Meilisearch server state never does.
A Meilisearch release instead carries chunks, compiler vectors, provenance, and
an import manifest. Install imports those vectors without parsing, chunking, or
embedding. Each Library namespace and package release gets one immutable
Meilisearch index; runtime search fans out over active indexes and fuses their
rankings. Logical uninstall happens before index deletion. If deletion fails,
knowledge remains inactive and the CLI returns an actionable orphan warning.

Meilisearch secrets remain in environment variables. A typical target uses:

```json
{
  "index": "@dkb/index-meilisearch",
  "options": {
    "@dkb/index-meilisearch": {
      "urlEnv": "MEILI_URL",
      "apiKeyEnv": "MEILI_MASTER_KEY",
      "timeoutMs": 60000,
      "semanticRatio": 0.7
    }
  }
}
```

## Operator commands

```bash
dkb plugin add ./my-provider --root ./Library
dkb plugin link ./my-provider --root ./Library
dkb plugin list ./Library
dkb plugin remove @team/provider --root ./Library

dkb pipeline show ./Library
dkb pipeline verify ./Library
dkb pipeline set meili --root ./Library \
  --evidence @dkb/evidence-docling-llamaindex \
  --embedding @dkb/embedding-fastembed \
  --index @dkb/index-meilisearch \
  --retrieval @dkb/retrieval-hybrid \
  --provider-options '{"@dkb/index-meilisearch":{"urlEnv":"MEILI_URL","apiKeyEnv":"MEILI_MASTER_KEY"}}'
```

Use `--global` with plugin add, link, or remove for current-user storage.
Windows PowerShell users should quote the JSON argument with single quotes.

Build inspection and retention use:

```bash
dkb build ./my-dkb --pipeline tei-faiss
dkb build list ./my-dkb
dkb build inspect <digest> ./my-dkb
dkb build prune ./my-dkb
```

Inactive Retrieval Builds remain available until pruning, so a Library can
switch back without parsing, chunking, or embedding again.

## Registry compiler

The HTTP compiler runs with a trusted `DKB_CONTEXT_ROOT`. Its capability
response reports the selected target plus Evidence, Retrieval, provider-build,
and compatibility digests. Compile requests name an allowlisted target; they
cannot inject configuration or plugin code. The service strips uploaded
`.dkb/plugins` and configuration, resolves providers from its trusted context,
invokes the same shared job runner as local compilation, and returns resolved
provider metadata for Registry storage and signing.
