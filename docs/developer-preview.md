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
- Browser PKCE and headless device login, optional Registry OIDC, and exact-plan
  Runtime download grants.
- A loopback-only mobile and desktop Host Console driven by typed CLI commands.
- Private, independently versioned packages and images with digest-pinned stack
  assembly.
- Checksummed local-stack backup, restore, upgrade, and automatic rollback.

## Storage transition in this checkout

The current development candidate requires one local OS/storage environment
per live Library database. Native Windows uses local fixed NTFS storage;
Docker must use Linux-local storage. Direct Windows/Linux database access
through a shared host mount is rejected before opening the database.

The owner-side CLI transport supports Docker Library inventory handles and
public offline inspection, Collection changes, DKB/Collection uninstall,
Registry-default configuration, and stopped-Runtime recovery. New Stack startup
initializes and serves Linux-local volumes through the owner coordinator; restart
preserves their identity and missing storage fails closed. Signed DKB installation
now uses a grant-only Linux worker through both CLI and Console, including exact
retry, failure rollback and reinstall. Collection install/update uses the same
grant-only boundary and shared dependency transaction, including cancellation
recovery. Docker outdated checks and DKB upgrades use the same signed grant
worker, with an applied-generation check preventing stale upgrade replacement.
Native package operations retain that same destination and upgrade guard when
a Runtime URL is supplied; the URL requests a post-commit refresh only.
Library generation checks prevent removed knowledge from being served. Runtime
refresh reconciles recorded managed-index imports against applied Library state,
preserving installed versions and inactive spaces. Cleanup failure leaves a
retry receipt and a maintenance warning without undoing successful activation.
Managed providers require a credential-free backing-store identity; changed
recipes, options or environment-resolved stores cannot authorize old cleanup.
Older untracked external indexes require explicit provider-side inspection;
DKB does not discover or delete them by guessing.
Owner-side editable compilation, offline Pipeline preparation, arbitrary
Runtime rebinding, volume-aware backups,
and explicit copy-and-verify migration remain release gates. Existing host-bind
Stack layouts must not be treated as compatible with this candidate.
No user Library is migrated automatically. See the current
[system map](architecture/system-map.md) and
[storage decision](decisions/0013-library-storage-ownership.md) for verified
results and the remaining gate. The existing Stack capabilities above do not
certify the unfinished Linux-volume deployment path.

Only native process Runtimes expose locally accessible state. Docker/remote
queries and Pipeline inspection use the Runtime's authenticated endpoint, even
if an older inventory record has a host path. An offline endpoint does not fall
back to that path. Online Pipeline switching now uses owner-validated coverage
and an optimistic-concurrency receipt. Retained signed builds need no Registry
request; missing Registry builds use host-scoped login and exact download grants.
Changed state fails before activation. Docker/remote editable-source compilation
is still rejected from the native host and remains an owner-integration gate.

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
- The Host Console is single-user and loopback-only. It is not a remote,
  multi-user administration service and does not replace the Registry admin.
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
