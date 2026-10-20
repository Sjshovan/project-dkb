# 0008 - Runtime-Bound Pipelines And Shared Libraries

- **Status:** Accepted
- **Date:** 2026-08-31
- **Scope:** Library ownership, Runtime binding, Pipeline activation, shared builds, and host orchestration
- **Supersedes:** the Library-owned active Runtime portions of 0005 and 0006

## Decision

A Library owns logical knowledge and every immutable Evidence and Retrieval
Build. A Runtime owns one Library binding, one active Pipeline, and one exact
activation snapshot. Any number of Runtimes may serve the same Library without
copying its source or derived builds.

```text
Registry A --\
              Library -- Runtime A / TEI + FAISS
Registry B --/        \- Runtime B / FastEmbed + FAISS
```

The Library remains authoritative for `dkb.json`, `dkb-lock.json`,
`.dkb/state.sqlite`, package source, provenance, and content-addressed builds.
Runtime state is stored outside the Library and contains its binding,
Pipeline selection, activation lock, caches, traces, and audit state. Secrets
remain in the existing environment or host credential stores rather than
portable locks.

An activation lock binds one Runtime to the exact Library state digest,
Evidence Profile, Retrieval Profile, compatibility space, and per-package
build digests. It contains no filesystem paths. Queries fail closed when the
Library state no longer matches the activation. Switching a Runtime's Library
or Pipeline stages and validates a complete replacement before atomically
promoting it; another Runtime serving the same Library is unaffected.

Runtime Pipeline resolution is Runtime-local, then Library-local, then
user-global, then bundled. A broken higher-precedence definition fails closed.
Compiler and Registry trust rules remain unchanged: uploaded knowledge cannot
supply executable plugins or operator configuration.

## Operations

Pipeline selection is Runtime-scoped. Library configuration may define target
recipes and a default suggestion, but it does not activate a retrieval space.
Registry selection is install-scoped; a Library's configured Registry is only
the default. Installed packages retain their exact Registry origin and signed
release/build receipts.

Stack Runtime state and the mounted Library are separate paths. Multiple local
Stacks or standalone Runtimes may bind the same Library. Cross-process Library
mutations and build promotion use filesystem locks. After a Library mutation,
online local Runtimes are refreshed independently; an outdated Runtime remains
unavailable until its exact activation can be rebuilt.

Managed-index retention is Runtime-owned operational state. Import records its
package scope, recipe/options digests and credential-free backing-store identity
before provider side effects. After activation, reconciliation acquires each
recorded Library's mutation lease and deletes only versions absent from applied
state. It preserves installed/inactive spaces, rejects changed storage/provider
identity, and retains failed-cleanup receipts for refresh retries. Cleanup cannot
roll back a committed activation or write another Runtime's selection.

Remote Runtime administration never sends a host-local path. A remote Runtime
may change binding only through an authenticated Runtime-local Library handle.
MCP remains exactly the read-only `search` and `fetch` tools. Cross-Runtime
query fusion and comparison remain outside this decision.

## Hard Cut

Library- and package-local `.dkb/runtime.lock.json` files are retired as active
state. Development Runtime bindings, activation locks, and caches are rebuilt.
Package source, manifests, logical locks, applied state, immutable builds,
Registry data, credentials, and host inventory are preserved.

## Acceptance

Two Runtimes must concurrently serve one Library through different compatible
Pipelines while preserving the same Evidence identities and provenance. Each
must keep independent activation, cache, health, restart, and rollback state.
Library mutations must not expose removed evidence through stale Runtimes, and
concurrent Runtime preparation must not corrupt shared builds.
