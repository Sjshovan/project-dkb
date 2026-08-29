# Final Provider Architecture

The authoritative decision is [ADR 0006](../decisions/0006-final-provider-architecture-and-storage-cutover.md).
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
retrieval vectors. Retrieval Builds bind exact vectors and generic artifact
manifests to one Evidence digest.

## Query flow

```text
Runtime lock -> immutable build roots -> query embedding -> index candidates
             -> retrieval ranking/fusion -> Evidence catalog -> search/fetch
```

Index providers return Evidence IDs and scores. Library resolves canonical
text, source anchors, locators, and provenance from the Evidence catalog.

## Storage

```text
.dkb/builds/evidence/<profile>/<digest>/
.dkb/builds/retrieval/<profile>/<digest>/
.dkb/runtime.lock.json
.dkb/cache/runtime/<snapshot-digest>/
```

There is no durable active `.dkb/artifacts` mirror. Cache content is disposable.

## Composition roots

`packages/distribution-default/src/index.ts` is the sole bundled provider and
target catalog. `services/compiler/src/server.ts`, Runtime bootstrap, and
`apps/cli/src/cli/index.ts` may import that distribution to assemble an
executable application. Their domain modules receive a distribution or
context-local `DkbProviderHost`; they do not select concrete providers.

Filesystem plugins are discovered by `packages/pipeline` from the active
Library context, then the user-global context, then the supplied distribution.
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
