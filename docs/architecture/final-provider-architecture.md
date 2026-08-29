# Final Provider Architecture

The authoritative decision is [ADR 0006](../decisions/0006-final-provider-architecture-and-storage-cutover.md).
This document is the navigation map for the active cutover and must match the
source before ADR 0006 is marked implemented.

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
