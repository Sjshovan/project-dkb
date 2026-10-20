# Deployment Guidance

This directory owns the versioned single-host developer-preview distribution.
The canonical [provider architecture](../docs/architecture/final-provider-architecture.md)
and [ADR 0006](../docs/decisions/0006-final-provider-architecture-and-storage-cutover.md)
are authoritative.

- Compose consumes versioned service images and never requires a sibling source
  checkout at runtime.
- Keep Registry, compiler API, Python worker, embedding service, Runtime, and
  optional Meilisearch as explicit service boundaries.
- Never mount the Docker socket into compilation services.
- Generate secrets into ignored host-local state. Do not commit defaults that
  can operate as credentials or copy secrets into locks, inventory, or images.
- SQLite and local volumes are developer-preview defaults only.
- Live Library, Runtime, compiler and Registry storage stays in Linux-local
  external volumes. Never restore host bind mounts or let Compose create an
  empty replacement for a missing recorded volume. See
  [ADR 0013](../docs/decisions/0013-library-storage-ownership.md).
- `down` preserves volumes, secrets, Libraries, and host inventory unless an
  explicit destructive command is added later.

Verify rendered Compose configuration, image labels, health checks, clean-start
migrations, service failure messages, provider-image isolation with
`npm run images:check`, and both default and Meilisearch targets.
