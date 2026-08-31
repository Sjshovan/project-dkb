# 0005 - Evidence And Retrieval Build Graph

- **Status:** Build graph retained; active Runtime ownership superseded by 0008
- **Date:** 2026-08-27
- **Scope:** compilation identity, stored build layers, Runtime selection, Registry publication, and Collection portability

## Decision

DKB separates logical knowledge from two derived compilation stages:

```text
PackageVersion -> EvidenceBuild -> RetrievalBuild -> Runtime
```

`PackageVersion` is immutable source knowledge. An `EvidenceProfile` is a
resolved ingestion recipe; applying it produces one embedding-free
`EvidenceBuild`. A `RetrievalProfile` is a resolved embedding/index recipe;
applying it to an exact Evidence Build produces one `RetrievalBuild`.

Profiles are recipes. Builds are content-addressed results. The same package
version may have multiple Evidence Builds, and one Evidence Build may have
multiple Retrieval Builds. Re-running an exact Evidence Profile for an exact
PackageVersion must reproduce the same Evidence digest; disagreement is a
nondeterministic compiler error, not another selectable build.

Collections lock PackageVersions only. `dkb-lock.json` remains logical
dependency state and `.dkb/state.sqlite` remains authoritative applied state.
ADR 0008 moves the exact Evidence/Retrieval activation chain into each
Runtime's independent state root.

## Resolution

A Runtime target resolves an exact Evidence Profile and Retrieval Profile. For
every active PackageVersion the resolver requires:

1. an Evidence Build whose Evidence Profile digest exactly matches;
2. a Retrieval Build whose parent Evidence digest and Retrieval Profile digest
   exactly match; and
3. one Runtime activation compatibility digest.

There is no newest-build, nearest-match, or cross-space fallback. All missing
layers are staged and verified before that Runtime's snapshot changes.

## Storage And Distribution

Source releases, Evidence Builds, and Retrieval Builds are stored and signed as
separate immutable layers. The Registry returns a signed install plan naming
the exact layer digests and download locations. The CLI downloads and promotes
that plan transactionally; the Registry does not reconstruct a monolithic
archive for each request.

Local build paths are content-addressed under `.dkb/builds/evidence/` and
`.dkb/builds/retrieval/`. Inactive builds remain available until explicit
pruning. Uninstall removes the PackageVersion and every local build derived
from it.

This intentional coexistence increases disk use: active artifacts are retained
for Runtime compatibility while immutable Evidence and Retrieval Builds enable
switching and rollback. DKB therefore reports the bytes of each layer and
preflights available space before source ingestion and retrieval compilation.
Capacity decisions use exact Evidence record/text density once chunking has
finished, not document count.

The Registry stores `.dkbpkg`, `.dkbevidence`, and `.dkbbuild` layers
separately. Each derived receipt names its parent receipt hash. An install plan
binds one exact chain and is itself signed. The Runtime verifies every receipt,
archive digest, parent reference, profile digest, and compatibility field
before extraction or activation.

## Default and alternatives

Bundled targets include `fastembed-faiss`, `tei-faiss`, `tei-faiss-768`, and
`tei-meilisearch`. FastEmbed and TEI are always different embedding spaces,
even when they use the same model family. A 2026-08-28 three-run proof met the
accepted speed, throughput, query-latency, memory, retrieval, and security
gates, so `default` aliases the exact `tei-faiss` recipe for new contexts.
Existing explicit FastEmbed contexts do not change.

Multi-build storage is independent of that promotion decision. It remains the
permanent mechanism for using one PackageVersion with different ingestion or
retrieval stacks across Libraries and Runtimes.

## Boundaries

- Ingestion and all text mutation finish before Evidence IR is written.
- Evidence IR contains no embeddings or index-native state.
- The selected embedding provider owns document and query vectors.
- Retrieval artifacts reference existing Evidence identities and cannot mint
  provenance identities.
- Uploaded knowledge cannot provide plugins or pipeline configuration.
- Remote MCP remains read-only `search` and `fetch`.

## Rejected Alternatives

- A single archive containing every retrieval space makes downloads and
  uninstall unnecessarily large.
- Treating Evidence IR as one universal build prevents alternate chunking and
  parsing strategies for the same PackageVersion.
- Selecting by target name or recency weakens reproducibility and rollback.
- Publishing locally produced builds automatically expands authority beyond an
  explicit operator action.
