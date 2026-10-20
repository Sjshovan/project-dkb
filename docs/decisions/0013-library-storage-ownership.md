# 0013 - One storage environment per Library

Date: 2026-10-09

Status: Accepted.

Supersedes the cross-Windows/Linux database guard in
[ADR 0012](0012-crash-safe-library-mutations.md). Durable journals, exact-path
recovery, fresh read fences and provenance requirements remain.

## Context

Windows and Linux containers can observe incompatible locking semantics when
opening one live SQLite database through Docker Desktop file sharing. A
timestamp, foreign PID or saved platform label cannot establish exclusive
ownership across those environments. A custom cross-platform lock protocol
would add complexity to every read, mutation and recovery path.

## Decision

Each live Library database belongs to one native OS/storage environment.
Windows CLI processes and native Runtimes may share verified local Windows
storage. Linux management and Runtimes use Linux-local storage. They never open
the same live database through Windows/Docker file sharing.

```text
Windows CLI / Console
    -> typed owner-side CLI invocation
       -> Linux-local Library volume
          <- Runtime A / Pipeline A
          <- Runtime B / Pipeline B
```

Multiple Runtimes still share the Library's immutable builds. Each Runtime has
separate native activation, audit, cache and credential state. Host inventory
records a Docker storage handle, not a fictional Windows path.

## Ownership invariants

- Verify the backing filesystem and containment before opening state. Reject
  shared, remote and unknown storage; never silently relax the requirement.
- Use native SQLite leases on supported storage. Close connections before
  releasing ownership. Age and foreign process identity do not grant takeover.
- Keep read phases short and perform fresh pending-operation/fence checks at
  admission and finalization. A cached query context cannot bypass drift checks.
- Queue competing mutations before context validation; revalidate state under
  ownership. A pending journal still requires explicit recovery.
- Preserve old locking records for matching-version recovery. Do not delete
  persistent lease files to attempt to unlock another process.
- Runtime readers hold shared leases; mutations hold exclusive leases. A read
  scope cannot upgrade itself into mutation authority.

## Delegated management

The host invokes the exact bundled CLI in a verified immutable Linux image.
Both ends validate a versioned allowlisted operation and bounded typed input.
No caller-provided shell, executable, environment, host path or extra mount is
accepted. The Console continues using the same CLI command catalog.

Ordinary inspection/recovery workers have no network, Docker socket or host
mount. Registry acquisition uses a distinct fixed worker with only exact-plan
download grants. Registry login credentials remain on the host. Canonical
Registry origin is kept separate from a reachable container transport address.

Owner-side management is independent of a running Runtime so stopped services
do not prevent supported inspection and recovery. Unsupported operations return
`unsupported_capability`; they never fall back to opening Linux state on Windows.
See [supported configurations](../developer-preview.md) for operation limits.

A failed or timed-out Docker call is not proof that its worker stopped.
Cancellation checks the exact labelled container. Unknown creation or cleanup
returns an actionable error, preserving the Library volume. No automatic retry
may dispatch duplicate uncertain work.

## Runtime and Stack coordination

Runtime recipe inspection is owned by the Runtime's storage environment.
Preparation receipts bind the selected Runtime, Library state and resolved
recipe. Activation checks the complete graph again under its existing gates.
Missing signed builds can be acquired; corrupt retained builds fail closed.

Stack startup journals the owner observation, intended topology and operation
identity before dispatch. Linux preparation, service startup, Runtime activation
and host registration use explicit acknowledgements. Lost replies and absent
journals alone are not success or rollback authority.

A host Stack control lease protects host topology only. It does not authorize
Library access or a consistent database snapshot. Secret-bearing host recovery
records stay private and out of logs and exports. Other Stacks and Runtimes must
not be stopped as a side effect of inspecting shared volume consumers.

## Backup and migration boundaries

Volume snapshots require owner-side exclusion across copying and final source
validation. Archive verification covers file identity, containment, bounded
size and metadata. Restoring into staging does not itself authorize replacing
live volumes or host bindings.

Public volume restore and volume-backed Stack upgrade rollback are unavailable;
volume-backed upgrades are refused. Host-folder archives are not substitutes
for Docker volume recovery. Existing Libraries and credentials are not moved
automatically. Any legacy host-bind migration requires an explicit stopped-writer
copy-and-verify operation.

## Consequences

- Native locks replace a custom cross-OS coordination scheme.
- CLI/Console preserve one domain implementation while delegating execution.
- Runtime independence and immutable-build reuse are retained.
- Docker management requires matching image/transport versions and explicit
  recovery when the daemon cannot confirm an operation.
- Operators must plan storage and recovery before adopting a deployment mode.

## Verification

Exercise native Windows and Linux-volume reads, concurrent mutations, process
death, stopped-Runtime recovery, shared Libraries with independent activations,
unsupported mount rejection and stale-evidence refusal. Delegated operations
must match native CLI results, preserve exact Registry origin and signatures,
and remove only their own labelled temporary resources.

Relevant executable checks include `tests/library-storage-owner-proof.mjs`,
`tests/library-owner-cli-proof.mjs`, `tests/runtime-native-ownership-proof.mjs`
and `tests/compiler-native-ownership-proof.mjs`. See their help and required
image setup before running; an ADR is a contract, not a test result.

References: [Docker volumes](https://docs.docker.com/engine/storage/volumes/),
[SQLite remote-storage caveats](https://www.sqlite.org/useovernet.html),
[Docker WSL guidance](https://docs.docker.com/desktop/features/wsl/).
