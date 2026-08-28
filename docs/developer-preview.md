# Developer-Preview Boundaries

DKB is usable for controlled evaluation, but it is not a stable production
release. The label is a compatibility and operations promise, not a statement
about whether core package retrieval works.

## What is implemented

- Namespaced DKBs and Collections with install, uninstall, upgrade, and locks.
- Portable source releases, embedding-free Evidence Builds, and separate
  Retrieval Builds for multiple runtime spaces.
- Provider discovery and operator-controlled local/global overrides.
- Atomic Runtime activation and read-only MCP `search` and `fetch`.
- Scoped Registry credentials with expiry and revocation.
- Private, independently versioned packages and images with digest-pinned stack
  assembly.
- Checksummed local-stack backup, restore, upgrade, and automatic rollback.

## What is not promised

- No stable 1.0 format or backward-compatibility guarantee. Development state
  may require a documented hard-cut rebuild.
- No public package, image, uptime, hosted service, support, or security-SLA
  commitment.
- `dkb stack` is a single-host local profile using SQLite and local storage. It
  is not a multi-node or high-availability topology.
- The Laravel Registry container's built-in server is for local evaluation. A
  remote deployment still requires HTTPS, a production HTTP serving layer,
  PostgreSQL, Redis, private object storage, backups, monitoring, and operator
  incident procedures.
- The future localhost management Console is researched but not implemented.
- Remote MCP is read-only. Knowledge mutation stays behind operator-controlled
  CLI and Registry workflows.
- Performance depends on corpus bytes, parser complexity, chunk count, selected
  providers, hardware, cache state, and concurrency. File count alone is not a
  useful promise.

## Safe evaluation

Use non-sensitive packages first. Keep the repositories and private release
units private, inspect every release artifact, back up before stack upgrades,
and retain the prior digest-pinned stack lock until the new version passes its
health and retrieval proof.
