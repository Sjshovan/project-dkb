# DKB Stack Distribution

`compose.yaml` is the single-host local developer-preview profile used by
`dkb stack`. It keeps the Registry database, package storage, Runtime Library,
pipeline context, secrets, and managed-index data under the named stack state
root so backup and restore have a complete ownership boundary.

Release images are independently versioned. A releasable stack is defined by a
`dkb.stack-lock.v2` file containing an exact digest for every service declared
by the selected DKB distribution. The lock is bound to the distribution ID and
version; floating image tags are not stack locks.

The local profile is intentionally not presented as production. A remote
Registry can use the production environment contract in the separate
`dkb-registry` repository, but needs an operator-supplied HTTPS and production
HTTP layer, PostgreSQL, Redis, private object storage, backup/monitoring, and
secret management. The Runtime and compiler can be deployed independently
behind their existing health and authentication contracts.

The developer-preview Registry port is bound to `127.0.0.1` and trusts no
forwarding proxy by default. A production HTTP layer must set
`DKB_TRUSTED_PROXIES` to its comma-separated IP/CIDR allowlist; never use a
wildcard or expose the preview port directly.

Registry compilation and provider sidecars exchange staged inputs only through
the shared compiler jobs volume. Compose sets `DKB_COMPILER_WORK_ROOT` to
`/jobs/api`; operators deploying the compiler separately must provide an
absolute work root that is visible at the same path to every selected provider
service. Provider path allowlists remain narrow and must not be widened to a
container-local temporary directory.

Never mount the Docker socket into the compiler or accept provider plugins from
uploaded packages.

Before Compose starts, the host CLI resolves every selected provider image to
an immutable OCI digest. A release reference contributes its pinned
`@sha256:...` digest; an unlocked local-development image contributes its local
Docker image ID. The CLI writes those exact digests into the compiler and
Runtime context configurations. Provider receipts bind those values, and the
Registry compiler marks a recipe unresolved if any required identity is absent;
it remains visible but cannot compile or supply an alias for a signed build.
Healthy recipes remain usable. The compiler and Runtime only read injected
digests and do not need Docker-engine access.

## Trusted recipes and startup

The operator owns `compiler-context/.dkb/config.json` and its plugins. Repeated
`dkb stack up` calls preserve additional recipes, processor order, options and
explicit image pins. Runtime recipes live in its separate context and may also
use Library-local definitions. The preview containers do not mount the host's
`~/.dkb` directory: host-global plugins are not automatically installed inside
them.

`--compiler-target` selects the publication default, not an allowlist. Set
`DKB_COMPILER_ALLOWED_TARGETS` explicitly to restrict the catalog; an empty value
allows every recipe in the trusted compiler context and bundled distribution.
The restriction is persisted in `stack.env`. The default must be allowed.
Changing the default does not discard the other recipes.

Startup provisions only services needed by the compiler default and selected
Runtime Pipeline. Other advertised recipes may be unavailable until their
services and exact image identities are configured. Two recipes requiring
different models from one shared service are rejected; use separately
configured services for that deployment. DKB never overwrites an explicit
image pin to make a changed image appear compatible.

After building the Python provider images, run `npm run images:check` to verify
that Evidence, embedding, and FAISS dependencies are physically isolated.
