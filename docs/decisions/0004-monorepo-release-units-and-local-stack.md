# 0004 - Monorepo Release Units And Local Stack

- **Status:** Partially superseded by 0006; release-unit decisions retained
- **Date:** 2026-08-27
- **Scope:** TypeScript package boundaries, implementation versions, Docker images,
  local stack orchestration, and repository guidance

## Decision

Keep the Laravel Registry in its existing repository. Convert the TypeScript
project into one npm-workspace monorepo with independently versioned CLI,
Runtime, compiler, protocol, Library, pipeline, Registry-client, and bundled
provider release units.

The split follows literal ownership boundaries:

- the protocol owns stable manifests and evidence/wire contracts;
- the Library owns desired, resolved, and applied local knowledge state;
- the pipeline owns provider contracts and context-local plugin composition;
- bundled providers own concrete ingestion, embedding, index, and retrieval
  implementations;
- the compiler owns compilation orchestration and its HTTP service;
- the Runtime owns installed retrieval, HTTP, tracing, and MCP;
- the CLI owns presentation, context selection, and orchestration;
- Laravel owns remote identities, jobs, signing, storage, and publication.

The implementation packages begin as independent `0.x` developer previews.
Protocol and implementation packages have independent version histories. Package versions, provider build provenance,
and retrieval compatibility remain separate values.

The root project becomes a private workspace orchestrator with no product
version or executable. npm workspaces and TypeScript project references enforce
an acyclic dependency graph. Cross-workspace relative imports are forbidden.

## Local Stack

The distribution Compose file consumes versioned images for the Laravel
Registry, compiler API, Python compiler worker, embedder, Runtime, and optional
Meilisearch. The compiler API and Python worker exchange jobs through a private
shared volume; the Docker socket is never mounted into either service.

`dkb stack` commands operate the Compose distribution, generate ignored
machine-local secrets, and register healthy Registry and Runtime endpoints in
the host inventory. Stopping a stack preserves volumes, secrets, Libraries,
and inventory entries.

## Guidance And Verification

Every release unit receives a concise `AGENTS.md` containing only its ownership,
dependency direction, safety invariants, authoritative documentation, and
focused verification. Repository checks enforce required guidance, package
exports, dependency direction, and a fresh generated workspace graph.

Release verification covers the CLI distribution, Registry integration, default
and alternate provider lifecycles, read-only MCP, Windows/Linux behavior and
package contents. Validate each supported distribution independently.

## Rejected Alternatives

- Separate Git repositories for every TypeScript tool would add release and
  compatibility coordination before the current import cycles are removed.
- A directories-only move would preserve the single implementation version and
  fail to create enforceable boundaries.
- Adopting another plugin framework would duplicate the existing provider host
  without improving the DKB package or evidence contracts.
