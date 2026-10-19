# Final Provider Architecture

For the complete product topology and current implementation status, start with
the [DKB system map](system-map.md).

The provider cut is defined by [ADR 0006](../decisions/0006-final-provider-architecture-and-storage-cutover.md),
with Runtime ownership superseded by [ADR 0008](../decisions/0008-runtime-bound-pipelines-and-shared-libraries.md).
This document is the canonical navigation map for the provider architecture.

## Ownership

| Area | Owns |
| --- | --- |
| `packages/protocol` | Durable formats, identities, receipts, Evidence and wire contracts |
| `packages/pipeline` | Provider contracts, plugin host, lifecycle, configuration, compatibility |
| `packages/library` | Library state, immutable build graph, Evidence catalog, archives, transactions |
| `packages/registry-client` | Registry HTTP, authentication, signatures, downloads, publication |
| `packages/distribution-default` | Default target recipes, bundled plugin catalog, service metadata |
| `providers/*` | One concrete provider implementation per workspace |
| `services/compiler` | Generic Evidence/Retrieval build orchestration and compiler HTTP service |
| `services/runtime` | Build activation, search/fetch, tracing, HTTP, read-only MCP |
| `apps/cli` | Bootstrap, commands, presentation, progress, host context selection |

Dependencies point inward toward Protocol and Pipeline contracts. Providers do
not import each other. Only approved composition roots import the default
distribution; domain modules receive it or a provider host explicitly.

## Compile flow

```text
source -> Evidence provider/processors -> Evidence IR + Evidence catalog
       -> embedding provider -> index provider -> Retrieval Build
```

All text mutation finishes before Evidence IR. Evidence Builds contain no
retrieval vectors. The compiler represents this boundary as a vector-free
`DkbEvidencePipeline`; the selected embedding provider produces a separate
`DkbRetrievalPipeline.vectors` collection keyed one-to-one by Evidence ID.
Index providers receive the unchanged Evidence records and that separately
validated vector collection, then bind their generic artifact manifests to one
Evidence digest. An Evidence provider cannot precompute or override vectors.
The generated retrieval profile receipt records provider-neutral Evidence and
retrieval provider groups, exact code digests, embedding-space compatibility,
and index/retrieval protocols. Provider-native parser or chunker diagnostics
remain inside the owning provider receipt; Protocol has no Docling- or
LlamaIndex-shaped extraction schema.

## Query flow

```text
Runtime activation -> Library immutable build roots -> query embedding -> index candidates
             -> retrieval ranking/fusion -> Evidence catalog -> search/fetch
```

Index providers return Evidence IDs and scores. Library resolves canonical
text, source anchors, locators, and provenance from the Evidence catalog.
The Runtime package does not export its raw query-context, navigation, or
retrieval modules. Public local queries use `runtime/queryAccess`, HTTP uses the
Runtime server, and MCP uses the read-only MCP surface; each enters the same
activation-verifying, audit-persisting operation gate. The only separately
exported query-context control is cache invalidation/closure for lifecycle
orchestration, which cannot open or execute a query.

Cold query contexts validate the exact build graph and compare the derived
Evidence catalog with canonical Evidence IR. Cached contexts retain observations
of their selected plugin/dependency files, configuration, manifests, and exact
build trees; changed inputs fail closed instead of reusing loaded state under a
new identity. These observations supplement initial cryptographic validation;
they do not replace it. They rely on the host filesystem and operator trust,
not a sandbox against an administrator who can replace DKB itself.

Queries read binding/activation only after queued Runtime mutations complete.
They do not initialize or recover Runtime state. Recovery takes the same
mutation gate as promotion, so status checks cannot roll back a live promotion.
Library generation and selected inputs are checked again before releasing a
response, including after awaited observer delivery. A late invalidation adds
a failed audit event for the same request and withholds the result.

## Storage

```text
<package>/.dkb/builds/evidence/<profile>/<digest>/
<package>/.dkb/builds/retrieval/<profile>/<digest>/
<runtime-state>/.dkb/runtime-binding.json
<runtime-state>/.dkb/runtime-activation.lock.json
<runtime-state>/.dkb/runtime-selection.transaction.json
<runtime-state>/.dkb/locks/runtime-mutation.lease.sqlite
<runtime-state>/.dkb/managed-index-retention/<receipt-digest>.json
<runtime-state>/.dkb/cache/runtime/<snapshot-digest>/
```

There is no durable active `.dkb/artifacts` mirror. Libraries contain immutable
builds but no active Pipeline. Each Runtime owns its binding, activation, and
disposable cache, so multiple Runtimes may reuse one Library without copying it.
Binding and activation promotion is journaled and protected by an in-process
reader/writer gate plus a cross-process native mutation lease. Startup recovers an
interrupted promotion to one consistent previous or promoted pair.

Managed-index retention receipts record import scope and resolved backing-store
identity before external side effects. Post-activation reconciliation removes
only versions absent from authoritative Library state while holding that
Library's writer lease. Cleanup failures retain retry authority and report a
maintenance warning; they do not undo activation or change another Runtime.

## Composition roots

`packages/distribution-default/src/index.ts` is the sole bundled provider and
target catalog. `services/compiler/src/server.ts`, Runtime bootstrap, and
`apps/cli/src/cli/index.ts` may import that distribution to assemble an
executable application. Their domain modules receive a distribution or
context-local `DkbProviderHost`; they do not select concrete providers.

Filesystem plugins are discovered by `packages/pipeline` from Runtime-local,
Library-local, user-global, then the supplied distribution. Compiler contexts
use their trusted local context in place of the Runtime-local scope.
A broken higher-precedence implementation fails closed. Knowledge packages are
data and cannot provide plugin code or configuration.

## Where to find behavior

| Behavior | Authoritative source |
| --- | --- |
| Formats and validators | `packages/protocol/src` and `packages/protocol/schemas` |
| Plugin resolution and contracts | `packages/pipeline/src` |
| Build graph, archive, and catalog operations | `packages/library/src` |
| Default targets and service requirements | `packages/distribution-default/src/index.ts` |
| Docling/LlamaIndex orchestration | `providers/evidence-docling-llamaindex/src/compiler.ts` |
| Evidence source planning and incremental cache | `providers/evidence-docling-llamaindex/src/compilerSource.ts` and `compilerCache.ts` |
| Evidence worker transport and lifecycle | `providers/evidence-docling-llamaindex/src/compilerTransport.ts` and `compilerService.ts` |
| FAISS artifacts and helper transport | `providers/index-faiss/src/faissStore.ts` and `faissHelperClient.ts` |
| Meilisearch artifacts and transport | `providers/index-meilisearch/src/meilisearchProvider.ts` and `meilisearchClient.ts` |
| Evidence compilation and processors | `services/compiler/src/compilationState.ts` |
| Retrieval orchestration | `services/compiler/src/compilerCore.ts` |
| Build promotion and validation | `services/compiler/src/buildStorage.ts` and `packages/library/src/builds.ts` |
| Compilation caching and capacity | `services/compiler/src/compileCache.ts`, `embeddingCache.ts`, and `diskCapacity.ts` |
| Registry compilation delivery | `services/compiler/src/registryCompilation.ts` |
| Runtime activation and snapshots | `services/runtime/src/runtime` |
| Runtime provider coordination | `services/runtime/src/providers` |
| Search/target discovery and direct Evidence fetch | `services/runtime/src/read/retrieval.ts` and `services/runtime/src/read/read.ts` |
| HTTP and read-only MCP | `services/runtime/src/runtime/server.ts` and `services/runtime/src/mcp` |
| CLI command composition and family-specific summaries | `apps/cli/src/cli` and `apps/cli/src/cli/summaries` |
| Stack orchestration | `apps/cli/src/stack/manager.ts`, with Docker, release, backup, and context ownership in adjacent focused modules |
| Cross-package enforcement | `scripts/check-package-boundaries.mjs` and `scripts/workspace-graph.mjs` |

The generated dependency graph is
[`workspace-dependency-graph.md`](workspace-dependency-graph.md). Operational
details live in [`../operations.md`](../operations.md); artifact and receipt
details live in [`../artifact-architecture.md`](../artifact-architecture.md).
