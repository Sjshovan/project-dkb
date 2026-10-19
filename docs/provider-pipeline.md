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

The module exports API v3 `apiVersion`, `id`, `version`, a Standard Schema
`optionsSchema`, and `setup(context)`. It needs no plugin
manifest and is not downloaded from a plugin registry. DKB resolves each
selected Runtime plugin independently in this order:

1. the Runtime-local context;
2. the bound Library context;
3. current-user global storage;
4. bundled providers.

Compiler and Registry compiler contexts use their own trusted context root,
then current-user global storage, then bundled providers.

Only selected plugins are loaded. A present but broken local override is an
error; DKB never silently falls back to a global or bundled implementation.
Every provider host is context-local and disposed independently, so two
Runtimes in one process may select different overrides without sharing state.

Plugin code and operator configuration are never package content. Archive,
artifact, and local compiled-install filters exclude `.dkb/plugins/` and
`.dkb/config.json`. A DKB uploaded as knowledge cannot execute code or change a
Runtime's active Pipeline.

The bundled Docling/LlamaIndex provider reads package-owned files, including
SQLite snapshots. It rejects the retired `meta.llamaIndex.sources` configuration
and worker `externalSources` requests: uploaded source must not select a live
database, resolve credentials, or obtain mutable data outside its signed source
archive. Export the database into an immutable SQLite or JSON file inside the
DKB and publish a new package version when that snapshot changes. This does not
remove the SDK's generic `database` provenance type or the ability to write a
trusted operator-controlled provider; that provider still owns its explicit
source-snapshot and reproducibility contract.

The Evidence worker returns the original file or SQLite snapshot hash separately
from each chunk's text hash. Rich parsing, plain parsing, and an explicitly
enabled fallback share the same source asset anchor; parser-specific page/table
locations remain record locators. SQLite anchors include the package-relative
database path and row locator. Paths are checked against the compilation root
before opening source. A worker that omits the original source hash is rejected;
rebuild and restart the selected worker before recompiling affected derived
builds. Old or source-mismatched record caches are not reused. Historical signed
Registry artifacts remain immutable.

## Profiles, targets, and stored builds

User-global bindings live in `~/.dkb/config.json`; automation may relocate that
directory with `DKB_GLOBAL_ROOT`. Context overrides live in
`<context>/.dkb/config.json`. Both documents require the exact
`dkb.config.v2` format marker; DKB has no legacy configuration reader. A target
selects:

- one fused Evidence provider, or one parser plus one chunker;
- zero or more ordered processors. Fused Evidence targets may select record
  processors only; document and chunk processors require separate parser and
  chunker providers so DKB can interleave and validate each stage;
- zero or one document/query embedding provider; vector-required index or
  retrieval providers require one, while lexical-only chains omit it;
- one packaged or managed index provider;
- one retrieval provider;
- arbitrary options keyed by provider ID.

Options may name environment variables such as `urlEnv` or `apiKeyEnv`.
Credential-looking inline values are rejected in both raw configuration and
resolved schema output, including defaults and nested arrays, before setup.
Errors identify the field rather than echoing its value. API-v3 identity declarations
separately select an unchanged output-affecting option subset and declare
canonical external service, image, and model sha256 identities. Operational
endpoints, timeouts, batching, and secret references stay out of build
identity. Without that separation all validated options remain identity-bearing
by default. The generated
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

Service-backed providers never derive an identity by hashing an image name or
tag. The distribution declares which exact external identity each provider
requires. A host-side composition step resolves a pinned `image@sha256:...`
reference, or the immutable ID of an available local development image, and
injects that digest into the selected provider options. Compiler and Runtime
containers consume the digest from their trusted context configuration; they
do not inspect Docker and are never given the Docker socket. Registry compiler
capabilities report an unresolved recipe when one of these required identities
is missing. It cannot compile or resolve a build alias; other healthy recipes
remain usable. Operators using a remote provider service must configure
the service's attested digest explicitly in the trusted compiler context.
Managed local workers verify the expected image against Docker's immutable
image identity before execution. For externally configured HTTP workers,
observable model/version checks do not prove the remote container image:
that image digest remains an operator deployment attestation and requires
separate control-plane verification.

The embedding cache is keyed by exact input text, the selected provider's full
integrity receipt, validated semantic options, and embedding compatibility.
Dependency, model/image identity, or text-transform changes cannot reuse an
older recipe's vectors; operational-only timeout changes may reuse them.

`dkb pipeline set` validates a target recipe before atomically writing trusted
configuration. `dkb pipeline use <pipeline> --runtime <runtime>` prepares an
exact build chain for every installed package, then switches only that
Runtime's activation. Registry packages download signed missing layers; editable local
packages reuse matching Evidence IR when possible and compile through the same
shared runner. Failure leaves that Runtime's previous activation intact.

For online Docker and remote Runtimes, the host reads authenticated coverage and
an exact preparation receipt from the owner. The receipt pins Runtime selection,
Library generation/state, and resolved recipe digests without filesystem paths.
Registry credentials remain on the host; only exact signed plans and short-lived
grants are submitted. Each package keeps its installed Registry origin, even when
the Stack or Library has a different default. Changed state or configuration
rejects preparation before downloading or promoting builds. Corrupt retained
builds are reported as invalid, not silently treated as missing.

Native process Runtimes can prepare editable source through the shared compiler.
Docker/remote editable packages with missing builds still require compilation in
their owning environment; the host never opens their database or imports compiler
logic into the Runtime. Offline preparation and owner-side editable compilation
remain release gates. Rebuilt matching CLI/Runtime candidates are required for
the preparation receipt; there is no unchecked fallback to an older server.

## Contracts

The public authoring contract, scaffolds, validation rules, conformance suite,
and complete provider examples are documented in
[Plugin SDK v3](plugin-authoring.md). Existing v2 plugins must follow the
[hard-cut migration guide](plugin-migration-v3.md).

`dkb plugin verify` loads trusted module/schema code to inspect the definition
and resolved defaults but never calls `setup` or provider methods. It reports
Runtime contracts as untested. `dkb plugin test` executes the public conformance
suite and owns cleanup for registered resources. Neither command is a sandbox
for untrusted JavaScript.

The provider boundary supports both fused and separated Evidence production.
Because a fused provider has already parsed and chunked its source, only record
processors can follow it. Document and chunk processors belong to the separated
path:

```text
folder
  -> Evidence provider -> ordered record processors
  OR
  -> parser -> ordered document processors -> chunker -> ordered chunk processors
  -> ordered record processors
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

Provider receipts separate deterministic `build`/`compatibility` data from
optional operational `diagnostics`. The host rejects non-JSON or non-finite
values immediately. DKB binds ordered semantic receipts to its verified
provider identities in the Evidence and Retrieval locks; a Retrieval Build
also binds its exact parent Evidence receipt. Diagnostics remain in the local
compilation report, outside immutable build identity. See
[artifact architecture](artifact-architecture.md#provider-execution-receipts).

Processors register one `mutate` function plus a stage. The runner validates
every middleware result before invoking the next processor, applies them in
configured order, permits a processor to drop a value by returning `null`, and
records stage, order, version, and source-code digest in build receipts. IDs,
source paths, parent relationships, DKB-reserved metadata, provenance, source
hashes, locators, and spans are protected; processors may change text and add
non-reserved metadata.

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

dkb pipeline list --runtime local
dkb pipeline show meili --runtime local
dkb pipeline verify meili --runtime local
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

Inactive Retrieval Builds remain available until pruning, so any Runtime can
switch back without parsing, chunking, or embedding again.

## Registry compiler

The HTTP compiler runs with a trusted `DKB_CONTEXT_ROOT`. Its capability
response reports the selected target plus Evidence, Retrieval, provider-build,
and compatibility digests. Compile requests name an allowlisted target; they
cannot inject configuration or plugin code. The service strips uploaded
`.dkb/plugins` and configuration, resolves providers from its trusted context,
invokes the same shared job runner as local compilation, and returns resolved
provider metadata for Registry storage and signing.

The capability response advertises every allowed recipe, its default status,
provider chain, profile and compatibility digests, integrity receipts, required
services, availability, and health. Publication selects an advertised recipe;
an omitted selection uses the Registry default. Namespace-team administrators
may later request another recipe against the same immutable source version. A
matching Evidence Build is reused, while a changed Evidence Profile creates a
new sibling Evidence Build. The Registry signs the complete source to Evidence
to Retrieval parent chain and never accepts a local build upload as a substitute.

An allowed recipe whose identity cannot be established has `available: false`,
null recipe/profile/compatibility digests, and a safe `resolutionError`. Empty
receipt/service arrays in that state mean **not resolved**, not “no providers”
or “no services.” No partial identity is used for compilation, build matching,
or activation. A fully resolved recipe with offline services retains its exact
digests but is unavailable for compilation. Existing exact signed downloads
remain usable without a running compiler. Malformed context documents and
invalid allowlists/default names still reject the catalog itself.

Compilation resolves and probes only the requested allowed recipe, not every
optional recipe in the catalog. Failed plugin setup text is not copied into
public capability responses because it may contain private options or paths.

`GET /capabilities` uses the versioned `dkb.compiler-capabilities.v1` envelope.
The compiler identity binds its installed shipped files and declared runtime
dependency closure at process bootstrap. Subsequent capability and compilation
requests reject changed code or dependencies until restart. This is an
`observed-installed` identity, not a signed release or proof of a remote image.
Provider and processor entries include their full integrity receipts, while
excluding filesystem paths, resolved options, and credentials. Processor order
and the Evidence, embedding, index, and retrieval chains are explicit.

Service requirements come from the selected provider implementation, not the
Pipeline's name. A filesystem override owns its requirements even when it uses
the same ID as a bundled provider. Providers and processors may declare bounded
`serviceRequirements: [{ id: 'my-worker', kind: 'remote' }]` metadata; URLs and
credentials belong in validated option references, never in this declaration.
Bundled providers may use their distribution's provider-bound service metadata.

The Runtime catalog separates compatible stored artifacts from verified build
coverage. Registry packages count as ready only after the retained receipt chain
verifies against their pinned origin keys; editable packages are labeled local.
No network key bootstrap, build request, download, or index import occurs during
this check. `buildsReady` means the checked build graph, trust, and provider health
are ready for activation preparation; actual index preparation and promotion
still pass through the atomic activation gate.

Managed indexes implement two deliberately different cleanup operations.
`discardPackage` validates and removes only the exact newly-created index from a
failed activation attempt. `uninstallPackage` removes every index for an
explicitly uninstalled package release. Installation returns a boolean `created`
ownership flag; retained indexes are never discarded during rollback. A cleanup
failure reports the exact orphan index and preserves the previous activation.

After a successful activation, Runtime reconciliation removes only recorded
package versions no longer present in their Library's applied state. The Library
writer lease spans that check and external deletion, preventing a reinstall race.
Still-installed releases retain all spaces even if a Runtime switches Pipelines
or Libraries. Receipts in `.dkb/managed-index-retention/` precede external imports
and contain package/Library identity, recipe/options digests and the provider's
credential-free `storageIdentity` digest—not URLs, tokens or option values.
Meilisearch requires a plain HTTP(S) endpoint without URL credentials, query
parameters or fragments; its existing `apiKeyEnv` reference supplies authentication.
Reconciliation rejects changed recipes, options or backing stores. Failed cleanup
retains its receipt, reports a warning and retries on `dkb runtime refresh`;
the newly committed activation remains valid. Older untracked external indexes
are never discovered or deleted by guessing: inspect them through their provider.
