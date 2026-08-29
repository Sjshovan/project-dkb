# Deployment Guidance

This directory owns the versioned single-host developer-preview distribution.
The architecture decision in
[`docs/decisions/0004-monorepo-release-units-and-local-stack.md`](../docs/decisions/0004-monorepo-release-units-and-local-stack.md)
is authoritative.

- Compose consumes versioned service images and never requires a sibling source
  checkout at runtime.
- Keep Registry, compiler API, Python worker, embedding service, Runtime, and
  optional Meilisearch as explicit service boundaries.
- Never mount the Docker socket into compilation services.
- Generate secrets into ignored host-local state. Do not commit defaults that
  can operate as credentials or copy secrets into locks, inventory, or images.
- SQLite and local volumes are developer-preview defaults only.
- `down` preserves volumes, secrets, Libraries, and host inventory unless an
  explicit destructive command is added later.

Verify rendered Compose configuration, image labels, health checks, clean-start
migrations, service failure messages, provider-image isolation with
`npm run images:check`, and both default and Meilisearch targets.
