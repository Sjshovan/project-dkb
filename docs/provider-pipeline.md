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

## Targets and locks

User-global bindings live in `~/.dkb/config.json`. Context overrides live in
`<context>/.dkb/config.json`. A target selects:

- one fused ingestion provider, or one parser plus one chunker;
- zero or more ordered document, chunk, or record processors;
- one document/query embedding provider;
- one packaged or managed index provider;
- one retrieval provider;
- arbitrary options keyed by provider ID.

Options may name environment variables such as `urlEnv` or `apiKeyEnv`.
Credential-looking inline values are rejected. The generated
`dkb-profile.lock.json` is a build receipt, not hand-authored configuration. It
records provider source/version/code digests and a compatibility digest over
embedding space, dimensions, metric, normalization, index format, and evidence
protocol.

`dkb pipeline set` validates the full candidate before atomically writing the
configuration. Activating a target that is incompatible with installed
packages fails without changing the previous target. Save it with
`--no-activate`, rebuild or remove incompatible packages, and then activate it.

## Contracts

The provider boundary supports both fused and separated ingestion:

```text
folder
  -> ingestion OR parser -> chunker
  -> ordered document/chunk processors
  -> document embedder
  -> ordered record processors
  -> package index compiler
  -> signed .dkbpkg
```

At runtime the selected embedding provider embeds queries. The selected index
provider validates packages, prepares managed state if needed, opens a runtime
view, searches, verifies activation, and cleans up a release. All providers
return DKB source-unit identities; the stable `dkb.evidence.v1` layer resolves
text, provenance, citations, and trace metadata independently of the backend.

The shared runner normalizes fused or separated ingestion output into DKB
pipeline records before Evidence IR or an index provider sees it. Ordered
record processors run before that boundary, and their final text and hashes are
what every index receives. A provider may retain an opaque native result for
diagnostics or caching, but native engine objects are never the canonical input
to packaging, indexing, or provenance.

Processors register one `mutate` function plus a stage. The runner applies them
in configured order, permits a processor to drop a value by returning `null`,
and records stage, order, version, and source-code digest in build receipts.

## Bundled providers

| ID | Role | Behavior |
| --- | --- | --- |
| `@dkb/llamaindex` | ingestion | Docling rich-file parsing plus LlamaIndex fallbacks |
| `@dkb/fastembed` | embedding | matching document/query vectors through the configured service |
| `@dkb/faiss` | packaged index | immutable package-local FAISS and SQLite artifacts |
| `@dkb/meilisearch` | managed index | package vector import into immutable server-side indexes |
| `@dkb/hybrid` | retrieval | stable DKB evidence protocol and fusion behavior |

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
  "index": "@dkb/meilisearch",
  "options": {
    "@dkb/meilisearch": {
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
  --ingestion @dkb/llamaindex \
  --embedding @dkb/fastembed \
  --index @dkb/meilisearch \
  --retrieval @dkb/hybrid \
  --provider-options '{"@dkb/meilisearch":{"urlEnv":"MEILI_URL","apiKeyEnv":"MEILI_MASTER_KEY"}}'
```

Use `--global` with plugin add, link, or remove for current-user storage.
Windows PowerShell users should quote the JSON argument with single quotes.

## Registry compiler

The HTTP compiler runs with a trusted `DKB_CONTEXT_ROOT`. Its capability
response reports the selected target, provider build digest, and compatibility
digest. Compile requests name a target; they cannot inject configuration or
plugin code. The service strips uploaded `.dkb/plugins` and configuration,
resolves providers from its trusted context, invokes the same shared job runner
as local compilation, and returns resolved provider metadata for Registry
storage and signing.
