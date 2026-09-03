# 0009 - Trusted Plugin SDK And Registry Recipes

- **Status:** Accepted
- **Date:** 2026-09-02
- **Scope:** plugin API v3, compiler recipes, Registry build trust, Runtime activation, and query audit
- **Supersedes:** the plugin API v2 statement in 0006 and singleton Registry compiler assumptions

## Decision

`@sjshovan/dkb-pipeline` is DKB's only plugin SDK. Filesystem-controlled plugin
modules use API v3, Standard Schema options, typed definition helpers, strict
runtime output validation, build-generated integrity receipts, and the public
conformance runner. Plugins are trusted operator code, not sandboxed knowledge.
Knowledge archives cannot contain plugins or configuration.

A Registry's trusted compiler advertises an allowlisted catalog of named
Pipeline recipes and one default. Publication selects the default or one
explicit advertised recipe. Additional recipes may compile another signed
Evidence/Retrieval chain from the same immutable PackageVersion. Exact matching
Evidence Builds are reused; a changed Evidence Profile creates a sibling
Evidence Build. Target names are labels; persisted selection is digest-based.

Registry-origin packages may activate only Registry-compiled build chains with
valid source, Evidence, and Retrieval parent receipts. Namespace-team admins
with `registry:build` may request another trusted recipe. Outsiders fork under
their own namespace. Hosts never attach locally compiled artifacts to an
existing Registry release. Editable local DKBs may compile through trusted local
plugins and retain an explicit local trust label.

Every CLI, HTTP, and MCP query uses one Runtime activation and audited retrieval
operation. It revalidates Library generation/state and exact build compatibility
before opening or reusing a context. The v2 audit chain records Runtime,
Library, activation, Pipeline/profile/build digests, package versions, evidence,
scores, channels, citations, outcome, and timing. Optional observers run only
after the canonical event is persisted and cannot mutate retrieval output.
Raw query-context and retrieval helpers are internal Runtime modules rather
than public package entry points. The exported CLI, HTTP, and MCP query surfaces
therefore cannot bypass activation verification or canonical audit persistence.

## Consequences

- API v1/v2 plugins fail with migration guidance; no legacy adapter ships.
- Provider results cannot claim identities or smuggle provenance through an
  untyped metadata bag.
- Registry operators add recipes once, then may build any stored source version
  against them without accepting locally produced build artifacts.
- Compiler drift, missing signatures, compatibility mismatch, stale Library
  state, broken overrides, malformed hits, and observer failures fail at their
  owning boundary.
- Source versions and Collections remain independent of any one retrieval
  implementation while Runtime activation remains exact and reproducible.
