# 0006 - Final Provider Architecture And Storage Cutover

- **Status:** Accepted direction; implementation in progress
- **Date:** 2026-08-29
- **Scope:** provider ownership, composition, build storage, Runtime retrieval, and development-format cutover
- **Supersedes:** provider/composition portions of 0004 and the active-artifact portions of 0005

## Decision

DKB has a generic core, independently packaged provider implementations, and
one explicit default distribution. The durable build graph remains:

```text
PackageVersion -> EvidenceBuild -> RetrievalBuild -> Runtime
```

`@dkb/distribution-default` is the only package that knows the complete bundled
provider set and named target recipes. Compiler, Runtime, and CLI composition
roots receive this distribution explicitly. Domain modules depend on Protocol,
Library, and Pipeline contracts rather than concrete provider packages.

Concrete providers are independently versioned workspaces:

- `@dkb/evidence-docling-llamaindex`
- `@dkb/embedding-fastembed`
- `@dkb/embedding-tei`
- `@dkb/index-faiss`
- `@dkb/index-meilisearch`
- `@dkb/retrieval-hybrid`

Filesystem plugin precedence remains Library-local, user-global, then bundled.
A broken higher-precedence plugin fails closed. Packages never distribute
executable plugins or operator configuration.

Pipeline owns provider contracts, lifecycle, validation, and plugin hosting.
Evidence providers produce embedding-free records. Embedding providers own
matching document and query transformations. Their document vectors are kept
in a separate Evidence-ID-keyed collection rather than on Evidence records.
Index providers accept the exact Evidence records plus that collection, reject
missing, duplicate, or unknown vector identities, and return candidate IDs and
scores. Retrieval providers perform lexical/vector ranking and fusion. Library
owns the Evidence catalog and resolves canonical evidence text, provenance, and
locators.

Generated profile locks contain only provider-neutral provider groups,
processors, embedding-space compatibility, index format, and retrieval
protocol. Concrete parser/chunker details belong to the owning provider's
arbitrary build receipt rather than a hard-coded Protocol extraction object.

Immutable Evidence and Retrieval Builds are the only durable derived state.
Runtime locks point directly to exact build directories. DKB does not maintain
an active `.dkb/artifacts` mirror. Regenerable consolidated state belongs under
`.dkb/cache/runtime/<snapshot-digest>`.

This is a development hard cut: Protocol becomes `2.0.0`, implementation
packages become `0.2.0`, and the formats become `dkb.config.v2`, Evidence IR
v4, generic artifact manifest v2, Runtime lock v2, and plugin API v2. Source,
manifests, logical locks, credentials, and host inventory are preserved;
derived state is rebuilt. No legacy readers or compatibility aliases ship.

## Consequences

- Named Docling, FastEmbed, TEI, FAISS, and Meilisearch code exists only inside
  its owning provider or the default distribution recipe.
- Library verification reads Protocol-defined receipts and generic artifact
  manifests without importing providers.
- Runtime never parses, chunks, embeds documents, or imports compiler code.
- `fetch` reads the DKB Evidence catalog; index implementations do not own
  canonical evidence or provenance.
- Compose derives required services from the selected distribution target.
- A fixture can replace every provider seam without editing compiler or Runtime
  domain code.

## Completion gate

This decision is implemented only when package-boundary enforcement, the full
FAISS and Meilisearch lifecycles, local/Registry compilation equivalence,
read-only MCP security, CLI distribution tests, Docker image inspection,
Windows/Linux checks, performance limits, and derived-byte reduction all pass.
Until then, repository documentation must describe this as an active cutover,
not completed architecture.
