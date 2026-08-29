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

Registry compilation and provider sidecars exchange staged inputs only through
the shared compiler jobs volume. Compose sets `DKB_COMPILER_WORK_ROOT` to
`/jobs/api`; operators deploying the compiler separately must provide an
absolute work root that is visible at the same path to every selected provider
service. Provider path allowlists remain narrow and must not be widened to a
container-local temporary directory.

Never mount the Docker socket into the compiler or accept provider plugins from
uploaded packages.

After building the Python provider images, run `npm run images:check` to verify
that Evidence, embedding, and FAISS dependencies are physically isolated.
