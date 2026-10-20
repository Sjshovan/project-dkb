# DKB system architecture

DKB combines package management with evidence-preserving retrieval. Its source
of truth is the knowledge package; search artifacts are derived, identified
builds rather than replacements for that source.

See [design decisions](../design-decisions.md) for the rationale and
[provider architecture](final-provider-architecture.md) for implementation boundaries.

## Product topology

```text
Operator
  ├── CLI ───────────────────────────────┐
  └── Host Console → typed CLI commands ─┤
                                        ▼
Registry → signed packages → Library → Runtime → HTTP / MCP → Agent
   │                            │          │
   └── trusted compiler         │          └── activation + query audit
         └── provider pipeline ─┘
```

The Console delegates domain operations to the CLI. It does not implement a
second installer, compiler, or Registry client. Browser requests use an allowlist
of typed commands, not raw shell strings.

## Objects and ownership

| Object | Owns | Does not own |
| --- | --- | --- |
| Registry | Teams, namespaces, publication, signatures, download authorization | Runtime selection or local Library state |
| PackageVersion | Immutable source, manifest, release identity | A universal embedding representation |
| Evidence Build | Parsed/chunked records, source anchors, locators, hashes | Final retrieval vectors |
| Retrieval Build | Search artifacts bound to exact evidence and a retrieval recipe | New source or evidence identities |
| Collection | Exact package dependencies | Copies of every dependency or independent search builds |
| Library | Installed intent, applied state, source and immutable builds | One global active Pipeline |
| Runtime | One Library binding, one Pipeline, exact activation, caches and audit | Document ingestion during queries |
| Host inventory | Known resource names, locations and defaults | Credentials or authoritative package state |

Any number of Runtimes can serve the same Library. Each has independent state.
Registries are independent sources; installed releases retain their exact origin.

## Build graph

```text
PackageVersion
  ├── Evidence Build A
  │     ├── Retrieval Build A1
  │     └── Retrieval Build A2
  └── Evidence Build B
        └── Retrieval Build B1
```

A profile is a resolved recipe. A build is its stored output for a package.
Changing the embedder or index can reuse compatible evidence. Changing parsing,
chunking, or text processors creates a separate Evidence Build.

| Identity | Meaning |
| --- | --- |
| Source release digest | Exact published knowledge release |
| Evidence Profile digest | Resolved interpretation recipe and provider identities |
| Evidence digest | Exact package-specific Evidence IR |
| Retrieval Profile digest | Retrieval recipe and required Evidence Profile |
| Compatibility digest | Required evidence/embedding/index/protocol compatibility |
| Retrieval Build digest | Exact search artifacts bound to evidence |

Selection is digest-based. A target name labels a recipe; it cannot substitute
for compatibility or artifact verification.

## Compilation

```text
Source
  → fused Evidence provider OR parser + chunker
  → ordered document/chunk/record processors
  → canonical Evidence IR and Evidence catalog
  → optional embedding provider
  → index provider
  → immutable Retrieval Build
```

All text mutation finishes before embedding. DKB assigns canonical evidence
identities and validates provider output. Embedders own both document and query
transforms. Indexes return evidence IDs and scores; canonical text and provenance
remain in the Evidence catalog.

Local editable DKBs compile through trusted local providers. Registry releases
compile through the Registry's trusted compiler catalog and receive a signed
source → Evidence → Retrieval receipt chain. Uploaded knowledge cannot select
executable plugins or replace trusted compiler configuration.

## Installation and activation

1. Resolve exact package releases and Collection dependencies.
2. Verify the origin, signatures, parent receipts and artifact digests.
3. Stage content under Library mutation ownership.
4. Commit the logical lock and applied state.
5. Prepare each serving Runtime's exact compatible build graph.
6. Promote a validated Runtime activation atomically.

Library changes are authoritative. A Runtime with an outdated Library generation
cannot continue serving removed evidence. Failed refreshes require explicit
recovery rather than undoing a successful Library operation.

Shared Collection dependencies remain installed while a direct installation or
another Collection still requires them. Conflicting versions or signed origins
are rejected rather than silently substituted.

## Retrieval

```text
Request
  → authenticated transport
  → Runtime activation and Library-state validation
  → optional query embedding
  → index candidates
  → retrieval ranking/fusion
  → canonical evidence and citations
  → persisted audit outcome
  → response
```

CLI, HTTP and MCP enter the Runtime's validated retrieval boundary. MCP exposes
only `search` and `fetch`. Query observers receive finalized, redacted events;
they cannot rewrite evidence or citations. Source instructions remain untrusted.

An empty search is not permission to fabricate an answer. Consumers must assess
the fetched evidence before making claims.

## Provider boundary

Plugins are operator-installed modules exporting identity, API version, option
validation and setup. The SDK provides typed input/output contracts and
conformance tests for Evidence, parser, chunker, processor, embedding, index,
retrieval and observer implementations.

Resolution uses Runtime-local, Library-local, user-global, then bundled
definitions. A broken higher-priority override fails closed. Plugins are trusted
operator code, not a sandbox for code supplied by knowledge packages.

`packages/distribution-default` assembles bundled recipes. Generic compiler and
Runtime modules depend on contracts rather than concrete provider imports.

## Storage

```text
Library/
  dkb.json
  dkb-lock.json
  editable-package/
  vendor/@namespace/package/
  .dkb/state.sqlite

Package/.dkb/builds/
  evidence/<profile>/<digest>/
  retrieval/<profile>/<digest>/

Runtime-state/.dkb/
  runtime-binding.json
  runtime-activation.lock.json
  cache/
```

Builds are immutable shared inputs; Runtime activation and caches are separate.
One live database is accessed within one supported OS/storage environment.
Windows-native Libraries use local NTFS. Docker Libraries use Linux-local
volumes; Windows management delegates into that environment.

Recovery journals bind filesystem changes to the applied-state commit decision.
Ambiguous ownership, corrupt state, unsafe paths or incomplete cleanup are
reported without guessing or deleting unrelated data. See
[operations](../operations.md) for recovery procedures and
[supported configurations](../developer-preview.md) for deployment restrictions.

## Code map

| Directory | Responsibility |
| --- | --- |
| `apps/cli` | CLI presentation, context selection and orchestration |
| `apps/console` | Vue management UI, session security, typed command runner |
| `packages/protocol` | Durable contracts, schemas, identities and receipts |
| `packages/library` | Installation, state, archives, builds and evidence catalog |
| `packages/pipeline` | SDK, plugin resolution, validation and lifecycle |
| `packages/registry-client` | Registry HTTP, credentials and signed downloads |
| `packages/distribution-default` | Bundled provider composition and target catalog |
| `providers/*` | Concrete provider implementations |
| `services/compiler` | Shared compilation orchestration and service |
| `services/runtime` | Activation, retrieval, audit, serving and MCP |
| `deploy` | Local Stack configuration |
| `tests` | Contract, lifecycle, security and distribution tests |

The separate Laravel Registry owns publication and account administration.
Dependency direction is checked by the
[workspace graph](workspace-dependency-graph.md) and package-boundary checks.
