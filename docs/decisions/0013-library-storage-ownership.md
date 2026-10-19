# 0013 - One storage environment per Library

Date: 2026-10-09

Status: Accepted direction; implementation and release verification in progress.

Supersedes only the cross-Windows/Linux database guard in
[ADR 0012](0012-crash-safe-library-mutations.md). Its durable mutation journal,
recovery decisions, read fences, and provenance requirements remain.

## Decision

A live Library database has one supported operating-system/storage environment.
Native Windows management and native Runtimes may share local Windows storage.
Docker management and Linux Runtimes share Linux-local storage. They never open
the same live SQLite database through Windows/Docker file sharing.

```text
Windows CLI / Console
    -> typed owner-side CLI invocation
       -> Linux-local Library volume
          <- Runtime A / Pipeline A
          <- Runtime B / Pipeline B
```

Docker's existing execution and local-volume facilities provide this boundary;
DKB does not add a database service or implement cross-platform file locking.
One-shot owner-side CLI execution must also work while a Runtime is stopped or
unable to start because recovery is pending. An online Runtime alone is not an
adequate management/recovery endpoint.

A saved Runtime `stateRoot` is not authority to open Docker or remote storage
on the host. Only `kind: process` permits native CLI access. Docker/remote query
and Pipeline inspection use their authenticated endpoint and do not fall back to
host files on failure. Existing inventory metadata is preserved; unsupported
owner-side Pipeline preparation fails explicitly before compilation. This guard
does not replace the remaining offline owner-management integration.

Docker creation acknowledgements are distinct from worker completion. When the
daemon has not acknowledged creation and the operation container is not yet
listed, the host reports `library_owner_cleanup_unconfirmed` with the exact
container identity. An empty listing cannot rule out delayed daemon creation.
The host does not start an unacknowledged worker or delete its Library volume;
recovery data remains available for explicit settlement. This is a conservative
failure report, not automatic orphan recovery or a claim that Docker became
reliable under timeout. An observed late-created worker and its synthetic volumes
were removed only after checking its image, operation label, stopped state and
every mounted proof-volume identity.

The Library remains the sole authority for sources, applied state, logical
locks, and immutable builds. Runtime activation and credentials remain separate.
No source, package, credential, or existing Library is moved automatically.

The same storage rule applies to each Runtime's mutable state and native
activation/query lease. Each Runtime has a separate local state root; a shared
Library does not imply shared Runtime activation or audit state.

## Foundation

- Validate the actual backing filesystem before opening mutable Library SQLite
  state or an ownership lease. Reject remote/shared filesystems and unknown
  storage rather than relying on a saved `platform=linux` marker.
- On Linux use mount information, not `statfs` alone: the tested Docker Desktop
  Windows mount reports a tmpfs magic value but is a `9p` mount.
- Node reports no filesystem type on Windows. A bounded read-only Windows
  Script Host probe checks the OS drive's numeric type, readiness and exact NTFS
  format without localized text parsing or elevation. A negative result rejects
  storage. If scripting is unavailable or its output is unrecognized, the existing
  .NET `DriveInfo` check must independently verify all three properties. Neither
  check changes machine settings or admits unknown storage. Only the verified
  volume identity is cached within one process; path and device checks stay fresh.
- Use native SQLite ownership on supported local storage. The operating system
  releases it on process death; timestamps and foreign PIDs never authorize
  takeover. Keep process-local FIFO/reentrancy and close connections before
  releasing ownership.
- Existing development writers must be stopped before a lock-protocol change.
  Detect unresolved old guards and retain them for explicit recovery rather than
  deleting them or silently mixing two locking protocols.
- A read phase still validates the real Library fence at admission and at
  finalization. Faster ownership is not permission to cache away drift checks.
- Short reads use the ledger's own native SQLite read transaction, not a second
  lease database. Every connection closes before asynchronous filesystem work.
  The durable pending marker is committed before a writer changes any live path;
  a fresh phase-end transaction rejects pending work or a changed fence.
- Path, ancestor, symlink, sidecar, storage and previous-protocol guard checks
  share one fresh inspection immediately before database access. These facts
  are not cached across reads. Ownership, journal and provisional read views
  retain separate lifetime and authority checks.
- Warm identity reads use the canonical root manifest and applied ledger,
  not source-folder discovery. Activation still validates the complete graph;
  each query checks the exact active manifests, receipts, builds, provider
  inputs and fresh Library fences. Ordinary recovery rejection reads journal
  existence, not its potentially large payload.
- Offline CLI mutations queue for the existing writer lease before read-side
  context validation. A temporarily displaced manifest may be located by its
  ledger, but that is not authority: state and manifest are checked again under
  ownership. A live writer queues another writer; an abandoned journal still
  requires explicit recovery. Read commands do not acquire mutation authority.

### Runtime ownership

`services/runtime/src/runtime/mutation.ts` reuses the Library package's native
lease primitive. Runtime queries hold shared leases until completion; activation
and management mutations hold exclusive leases. Queries may overlap, including
from separate processes. The process-local queue admits an already queued writer
before later readers; this is not a claim of cross-process FIFO scheduling.

The lease database remains strongly referenced while an asynchronous callback is
idle. Reentrant authority expires when that callback finishes, and a read scope
cannot upgrade to mutation authority. Only an explicit mutation may initialize a
missing state root, after its existing ancestors and backing storage are checked.
Shared Windows/Docker mounts are rejected before state or database creation.

The old Runtime PID/hostname/age lock is removed. Existing
`.dkb/locks/runtime-mutation.lock` guards are preserved and reject both reads and
writes with `runtime_recovery_required`; stop old processes and recover with the
matching earlier version before this protocol cutover. No running Runtime is
silently migrated. The current persistent `runtime-mutation.lease.sqlite` file
must not be deleted to attempt to unlock another process.

## Management and deployment boundary

### Runtime-owned Pipeline preparation

An online Runtime's authenticated Pipeline catalog is the authority for its
resolved recipes and installed-package coverage. The CLI must not read a saved
Docker Runtime path or recompute that Runtime's provider identity on Windows.
The catalog carries a bounded preparation receipt binding the Runtime selection,
Library state and exact resolved recipe. Activation rechecks it under the existing
Runtime and Library leases before downloads or index imports; drift rejects the
request without replacing the previous activation.

The host obtains exact signed-build grants using each installed package's pinned
Registry origin. Registry login credentials stay on the host. Only exact-plan
grants cross the existing Runtime administration boundary. Per-package transport
translation may preserve an origin or translate loopback to Docker's host address;
one Stack Registry endpoint cannot redirect another Registry's downloads. Missing
and invalid builds are distinct: missing Registry builds may be requested, but
corrupt retained builds fail closed. Editable source compilation remains owned by
the compiler in the Library's storage environment, never by Runtime core.

This uses the existing catalog, grant client, signed-chain attachment and activation
service, not a new management service or database. Execution and current proof
status are recorded in the system map; this decision alone is not proof.

Host inventory must distinguish a local Library path from a Docker-owned
Library handle. Host inspection must not pretend a volume is a local directory.
Delegation validates command arguments and invokes the exact bundled CLI without
a shell. Authentication material travels through private input/environment, not
command arguments, logs, or host inventory. Runtime HTTP/MCP contracts do not
become arbitrary command execution endpoints.

Stack initialization, install, Collection changes, inspection, builds, recovery,
and backups must execute in the owning environment. Backups include the actual
volume; archiving only the host's Stack configuration is insufficient. Multiple
Runtimes reference the same Library volume with independent Runtime state.

Offline migration is copy-and-verify with stopped writers, preserved original
data, and explicit activation of the destination. A release must not silently
move an existing host Library or drop backup coverage.

### Public Stack storage

New public `stack up` operations use a durable `stack-storage.json` descriptor
before creating Linux-local volumes. Each managed volume is tied to the exact
intent and role by labels. An existing ready descriptor may not create a missing
volume, adopt unrelated storage, or remount a different Library. Additional
service storage comes from the injected distribution catalog, not hard-coded
provider knowledge in CLI orchestration. Compose treats these volumes as external.

The owner initializes only missing Library/Runtime state, then the existing
owner startup journal coordinates recipe preparation, service startup, Runtime
activation, completion acknowledgement and host registration. Windows never opens
the live databases. Host inventory records the Library's volume handle and omits
a fake native Runtime state root. Shared Libraries retain their identity and
upstream; `init --if-absent` does not reset existing Registry configuration.

Native host-folder preparation is not a fallback for an owned Stack. Its older
recovery helpers remain isolated pending explicit migration/backup replacement.
Host-folder backup rejects volume-backed state rather than claiming partial
coverage. The complete deployment release gate remains open until volume-aware
backup/restore and authenticated package delegation pass with real knowledge.

### Owner transport implementation

The internal CLI owner transport in `apps/cli/src/host/libraryOwner*.ts` invokes
the exact CLI in `apps/cli/Dockerfile`, not a running Runtime. Its versioned
request selects an allowlisted operation and typed input; both the host and
image validate it. The image accepts no browser/host-provided executable,
shell, environment, Library path or extra mount. JSON, JSON-stream and human
output use the existing CLI presenters.

Preflight requires an installed immutable Linux CLI image, matching CLI version
and transport protocol, a local Docker socket context and an existing local
volume with no custom driver options. The worker has no network, capabilities,
Docker socket or host mounts; scratch state is bounded ephemeral storage.
Cancellation checks and removes only its uniquely labelled worker container,
never the volume. Failed cleanup is an explicit error, not assumed success.

This is not a second management API: public CLI commands resolve the Library
once, select local or owner-side execution, and retain their existing domain
implementation and presenter. Host inventory v2 accepts either a local `path`
or a `storage` descriptor with `kind: docker`, named local Docker context, volume,
and installed immutable CLI image ID. It never invents a host path for a volume.
Local records remain unchanged. Registration verifies the Library in its owner
environment; selection is convenience state and does not require an online owner.

The connected operations are status, package listing and inert inspection,
storage accounting, recovery, sync, local root add/remove, Library Registry-default
configuration, DKB/Collection uninstall, and editable Collection create/show/member changes. Delegated mutations refresh associated local
Runtimes by host Library identity; offline refreshes remain actionable warnings.
Owner CLI events feed the existing host presenter; only the host emits the final
result after refresh. Console cancellation uses a private Node IPC channel so
Windows does not force-kill the host before its owned worker cleanup settles.
The existing Console command catalog remains the only browser control plane.

Uninstall uses the same Library mutation and dependency checks inside the fixed
CLI. Registry Collections prune only unneeded vendor members; direct roots and
other Collection dependencies remain. Editable sources are deactivated, not
deleted. Explicit Runtime reload endpoints stay on the host, are deduplicated
against associated Runtimes, and receive no mutation request for Docker Libraries.
Failed reloads report stale Runtime recovery instructions after a successful
Library commit. Failed owner operations never trigger reload or fall back to a
host directory. This offline boundary grants no network or Registry credential.

`library list` shows Docker entries as `known` without executing a worker;
`library list --check` performs bounded one-shot checks. Unknown/offline resources
remain listed. Unsupported filesystem-only operations return
`unsupported_capability`; they never fall back to a host-mounted database.

DKB upgrades, network signature verification, build acquisition, compilation,
arbitrary Runtime rebinding, volume-aware backups, and explicit offline migration
remain required integration work. New Stack initialization/startup uses the
owner coordinator described above. These connected operations are not yet a
supported complete end-user Docker deployment.

The Runtime package exposes `installDkbFromLibraryGrant` for a Library-only
destination alongside its existing Runtime grant installer. Both use one
exact-plan acquisition path and existing signed materialization/transaction gates.
Canonical Registry origin stays separate from the reachable transport endpoint;
grant-only requests never inherit host bearer credentials. Retained-build reuse
compares the requested exact Evidence and Retrieval digests as well as the
recipe; an older valid signed chain cannot satisfy a different requested build.
Public `dkb install` now connects this for individual DKBs through a distinct
fixed grant-only worker, also used by the Console's existing typed install command.
The host resolves explicit/environment/Library/host/user Registry precedence and
uses its login only to obtain an exact-plan grant. Broken owner inspection never
falls back to another Registry. Canonical receipt origin is unchanged; loopback
transport maps only to Docker's host endpoint, retaining port, path and HTTPS.

The install worker accepts at most 2 MiB of validated private input, no host paths,
arbitrary environment, credentials, command or mount selection. It alone uses
bridge networking; ordinary Library and Stack workers remain offline. Docker
allocates an anonymous local scratch volume, whose driver/options are checked
before the worker starts. Download and archive capacity checks operate there.
The host confirms owned-container removal (including its anonymous scratch) on
cancellation, never deleting the named Library volume. Unknown creation or
cleanup remains an actionable error. This adds no Runtime management API,
database service, compiler call or alternate transaction implementation.

Only the host emits the final result after associated Runtime refresh attempts.
The Console shares saved host credentials, including an operator-selected
credential-file location, without forwarding a Registry bearer environment
variable. Failed worker operations do not trigger refresh. DKB upgrade,
verification and volume backup/restore integration remains unfinished.

For Collection delegation, the shared installer verifies the
exact Registry snapshot and all signed member plans before downloads. Existing
members are reused only after source, artifact, build-chain and origin-pinned
trust checks; receipt-file presence is not sufficient. Retained corruption fails
closed instead of replacing shared knowledge. One outer Library mutation still
owns the complete Collection update and rollback. The same fixed Linux worker
accepts a separately versioned Collection request, checked against its own image
protocol label. The handoff carries one validated immutable Collection revision
plus one exact-plan grant per
member, never a Registry login or host path. A transport-only adapter supplies
these plans and downloads to the existing Collection transaction, never
independent top-level member installs. Explicit Collection
updates use the same boundary and preserve direct/shared ownership protections.
Cancellation confirms container and scratch removal, preserves the Library and
names its explicit recovery command. The live synthetic Registry proof exercises
public CLI install/update, the actual Console runner, grant expiry, direct-member
reuse, uninstall, cancellation recovery and exact reinstall without compilation.
It does not certify Laravel authentication or browser interaction. Missing-member
build acquisition remains a separate integration gate. See the current
[system map](../architecture/system-map.md) for candidate-specific evidence.

Registry-default changes journal `.dkb/config.json` and `dkb.json` under one
Library mutation. Only the dedicated configuration-file write may target that
exact control file; generic path operations still reject all `.dkb` state.
Readers reject pending recovery and validate fresh fences. Host Registry
association follows the committed Library write, and identical settings do not
mutate the Library or refresh Runtimes. The host verifies an endpoint; the
offline owner receives only its validated URL, never Registry credentials.

Stack recipe planning, Library identity checks and activation confirmation now
execute in the owning environment; the public startup proof covers empty
synthetic Libraries. Complete authenticated package lifecycle and volume backup/restore
must follow that boundary. Do not add a host-mounted SQLite exception or infer
success from saved host configuration.

### Owner-side Stack observation

`apps/cli/src/stack/recipes.ts` is the single recipe planner used by existing
Stack preparation and the private owner-side inspection. The latter mounts
three distinct local volumes at `/library`, `/state`, and read-only `/context`.
It reuses the same pinned CLI transport, local-socket and volume checks, bounded
input/output, network-disabled worker, cancellation and owned-container cleanup.
Requests accept target names and an optional compiler allowlist only, never paths,
credentials, arbitrary environment, executables, or configuration documents.

Observation also returns only distribution-declared non-secret service settings
(such as the selected model and revision), never the full provider options. Both
ends validate bounded literal values; the host checks selected service membership
and the distribution allowlist. Compose interpolation, credentials, extra
environment assignments and unselected services are rejected. A planning digest
binds the resolved recipe configuration and service definitions, including
distribution defaults. Preparation rejects drift even when service names and
model labels are unchanged. This is a configuration-planning identity, not a
substitute for provider integrity, health or build compatibility verification.

Observation holds a native Runtime read lease and validates the Library fence
before returning. Runtime's `inspectRuntimeSelection` rejects pending transaction
journals and displaced journal backups without repairing them. A Library remount
cannot be mistaken for a committed binding change. Responses contain state and
configuration digests plus selected service IDs and allowlisted public service
settings, not arbitrary operator options or secrets.
`current` means the activation's Library identity/generation matches; it is not
provider-health, signature, full-build-validation, or service-readiness certification.

The October 13 four-part Docker proof runs all eight owner-inspection tests in
the packaged Linux CLI and exercises two Runtime volumes against one Library,
broken configuration, paused-writer exclusion, cancellation and confirmed process
death. The same image passes the eleven-part CLI/Console owner proof; the Windows
suite passes 752 tests with no failures or skips. CI includes both owner proofs.
These results cover the observation/delegation boundary, not full Stack startup
or volume-backed backup/restore. The earlier intermittent Windows loopback
failure remains unexplained despite passing in this run.

This is an internal prerequisite, not a second administration API. Public startup
now connects owner-side preparation and compare-and-set rollback to volume-backed
Compose and host registration, as described above. Volume backup/restore and the
authenticated package lifecycle remain unproven. Automatic legacy Registry-volume
copying and automatic legacy Library rebinding are not startup operations. Existing
state is retained for an explicit, stopped-writer copy-and-verify decision.

### Owner-side configuration and acknowledgements

`apps/cli/src/stack/ownerConfiguration.ts` prepares only the compiler and Runtime
recipe configuration. It shares the existing image-identity planner rather than
introducing alternate recipe semantics. The fixed offline worker holds compiler
context ownership before Runtime mutation ownership, checks the complete planned
observation and Library fence, and writes a bounded recovery journal before
changing either file. No Library content, binding, activation or service is changed.

Settlement is bound to an operation UUID and the exact Docker context and three
volume names. An image upgrade does not change storage identity. Recovery checks
both configuration files before restoring either, preserves concurrent operator
edits and unrelated activations, and acknowledges a requested activation only
when its Library generation and target match the preparation. A successful
activation is retained even if the host requests rollback after losing its reply.

Before journal removal, a small completion receipt records the outcome, operation,
storage scope, Library identity digest, configuration digests and Runtime selection digest. It contains no
configuration bytes or credentials. Repeated settlement checks that receipt and
the current state; missing recovery data is never treated as success. Another
pending operation, changed Library, changed files, changed selection, wrong scope or malformed
receipt fails closed. Only the latest completion is retained, and it does not
authorize an old operation after a later operation has replaced it.

The focused proof kills real worker processes before and after configuration
promotion, before and after receipt promotion, and after journal deletion. It
then checks exact restoration, retained activation and repeat acknowledgement.
These are process-death guarantees, not a power-loss durability certification.

A host may persist its startup plan and die before dispatching preparation. The
private `configuration.cancel` operation therefore carries that original owner
observation as well as operation and storage identity. With no pending journal,
it must re-observe the same Library, Runtime and recipe state before durably
acknowledging a no-op rollback. Journal absence alone remains an error for ordinary
settlement. The acknowledgement binds the original observation and prevents a
delayed preparation using the cancelled ID. If preparation did arrive, cancellation
uses the same rollback/retained-activation gate; it never reverses an activation
that already committed. Changed state, another pending operation or mismatched
expectations fail closed. Repeated cancellation validates the persisted receipt
and current state, including recovery after death during receipt promotion.

Public Stack startup preserves its host-side operation identity and coordinates
Compose rollback with this owner-side result. Backup/restore and authenticated
Registry delegation remain required before calling the Docker deployment
supported end to end.

The required coordinator order is:

1. Establish the Library in its owner environment. Set a new Library's initial
   Registry default before capturing the activation expectation; do not change
   an existing shared Library's default merely because another Stack serves it.
2. Persist the operation identity, exact owner descriptor/observation, and previous
   and proposed host topology before sending configuration preparation.
3. Prepare in Linux, then start the selected Compose services. Never hold a
   Runtime mutation lease while waiting for the Runtime to start or activate.
4. Request activation through Runtime and settle against its owner-side receipt.
   A lost HTTP reply is not proof that activation failed.
5. Remove host recovery state only after acknowledged owner settlement and the
   corresponding topology/inventory outcome. On interrupted preparation use the
   checked cancellation path, not missing-journal inference. Retain both recovery
   records when either environment cannot confirm its state.

The current public startup path implements this order; its empty-Library service
proof does not establish the signed-package lifecycle. Host files contain
topology/secrets only; none of these steps authorizes Windows to read Linux
Library or Runtime databases directly.

### Durable host coordinator

First-start Runtime binding is a separate typed owner operation,
`binding.initialize`, before recipe preparation. It calls Runtime's existing
atomic initializer inside Linux and returns the same bounded observation used
for planning. It cannot change an existing binding, activate a Pipeline, create
a Library, change a Registry default, repair pending selection journals, or
accept paths/configuration/credentials. Runtime and compiler-context leases use
the same acquisition order as preparation. A retry after owner death or a lost
reply returns the existing matching binding; a foreign Runtime or Library mount
fails closed. The public Stack manager must use this prerequisite before saving
its expected observation. It does not replace the activation service.

`apps/cli/src/stack/ownerStartup.ts` implements the host half of this protocol,
under the existing Stack control lease. Before owner dispatch it saves the
operation, exact owner descriptor/observation, image identities, previous/proposed
environment, Compose-file digest, previous running state and intended registration
names. The recovery record lives outside replaceable Stack data, is bounded and
written with private permissions. It contains Stack environment secrets and must
not be logged or included in diagnostic exports.

Topology callbacks are internal application functions, not serialized commands.
They must be idempotent; recovery never repeats activation. The coordinator saves
intent before environment/service changes, asks Linux to confirm activation even
after a lost HTTP reply, and registers resources only after owner acknowledgement.
If registration or service restoration fails, the host record remains. Recovery
revalidates Linux's receipt rather than assuming an absent journal means success.
Changed host configuration, Compose content, owner state or malformed records
fail closed without overwriting operator changes. No host operation copies Library
or Runtime state. Only the exact transaction-owned environment file and staged
sibling can be removed during rollback.

The host reuses the existing fresh storage/ancestor validator before dispatch,
recovery, file replacement and final journal removal. A redirected Stack folder,
including a Windows junction, cannot authorize an environment write or settlement
against external files. Topology is checked again after service startup and after
registration; changed paths preserve the recovery record. These checks do not
claim protection against a hostile process continuously racing filesystem calls.

The public Stack manager now supplies volume provisioning, actual Compose
start/stop and idempotent host registration to this coordinator. Synthetic topology
tests establish orchestration and process-death recovery; the separate live
Stack proof verifies empty-Library startup and restart. Neither establishes
power-loss durability, signed-package lifecycle or volume backup/restore. Native
host-directory startup is not a fallback or a second supported Docker mode.

### Host Stack control prerequisite

The host coordinates Stack topology through one native `stack-control` lease
at `<stack-state-root>/.control/<name>/.dkb/locks/stack-control.lease.sqlite`.
It is not Runtime or Library state, is never mounted into containers, and stays
in place while backup restoration replaces the Stack directory. Preparation,
startup, stop, backup, restore, and upgrade share this reentrant owner; other
Stacks remain independent. An existing `startup.lock` is preserved and requires
matching-version recovery, never PID/age-based deletion.

This control lease does not authorize Library reads, Runtime activation, or a
consistent live database backup. Those still require their own owner-side gates.
Current host-directory backups reject an external, missing, or linked Library
or Runtime and explicit Docker-owned state. Docker status failure is not proof
that services stopped. Backup and restore do not require a healthy Pipeline to
inspect stopped topology. The existing archive format is not a volume backup.
Archive creation and restoration reject links and special files throughout the
tree, not only at the Library/Runtime roots. Callback validation failures settle
through the archive operation's error path so cleanup completes and a partial
backup is never promoted.
Stopped-state preflight also inspects every exact recorded volume for consumers
outside the Stack's Compose project. It includes paused and created containers,
checks topology against the storage descriptor, and rejects unknown metadata.
It never stops other Runtimes. This observation is not an exclusive storage lease:
volume export/restore still requires owner-side exclusion for the entire operation.
Legacy host archives cannot restore volume descriptors or replace a volume-backed
Stack, even when the surrounding host archive passes its checksum.
The private `volumeSnapshotWorker.ts` now handles owner-local snapshot streaming
and restore-to-empty-staging. Native compiler/Runtime/Library leases and nested
build leases remain held through copying and final source-drift validation.
The inventory records exact file hashes, ownership, permissions, timestamps and
contained relative links; verification bounds metadata, compressed and expanded
bytes. Restore uses the same open archive descriptor, validates both passes, and
compares staged files before returning. Original volumes and host bindings are
not overwritten. Public backup dispatch now streams through the same bounded
Docker transport with a snapshot-specific image protocol and read-only host
configuration mount; no caller-selected command or bind path is admitted. Existing
archive/checksum paths are never overwritten. Recoverable restore topology
replacement, including explicit shared-Library semantics, remains a prerequisite
before calling this complete recovery. Volume-backed upgrades are refused until
their rollback can use that verified path. Exact Linux file modes are restored
after tar's umask-filtered extraction through no-follow file descriptors; no
Windows ACLs or original-volume permissions are changed. See the dated system map
for the current executable proof rather than treating this contract as completion.
Implicit relocation of old co-located Runtime/Library trees is removed; only
an explicit stopped-writer copy-and-verify migration may replace that layout.

Compiler ownership now uses the same native primitive through `compileLock.ts`.
Its persistent `compile.lease.sqlite` excludes competing compilers without
PID/age-based takeover. Old `compile.lock` directories remain intact and require
matching-version recovery after confirming earlier workers have stopped.
Admission is cancellable in both the local queue and native wait; after admission,
ownership lasts through the callback's worker-confirmed cleanup. Abort never
releases a lease out from under a running callback, and a secondary lease-cleanup
error cannot mask worker-stop uncertainty used by enclosing staging cleanup.

The current offline owner allowlist still does not expose compilation. Native
ownership is a prerequisite, not completed compiler delegation or proof of the
Registry build lifecycle. Its dedicated Docker proof is
`node tests/compiler-native-ownership-proof.mjs --run`: packaged Linux tests,
paused selected-provider exclusion, cancellation, owner death, independent
packages and real Windows-shared mount rejection. Preserve pending worker
journals separately; ending a Node owner does not prove an external worker ended.
The October 13 native-ownership checkpoint's four-part proof and full 723-test Windows suite pass, alongside
the existing real worker-confirmed cancellation checks. This is not permission
to bypass pending-execution recovery when a compiler process dies.

Compiler admission must not be made faster by skipping storage or identity checks.
One job-scoped provider host now both resolves the recipe and performs full or
retrieval-only compilation, avoiding a second identical setup. Its validated
input snapshot is checked again before build promotion or cache reuse, and it
is disposed on every exit. Registry/service identity and artifact verification
remain independent gates.

The bounded six-pair Windows comparison against committed Library/Runtime/Compiler
code at `46e1888` passes the unchanged 10% limit: candidate/baseline medians are
942/1178 ms compile, 95/107 ms search, 96/104 ms fetch, and 95/103 ms insufficiency.
The prior native-admission runs failed (40.7% compile, then 33.6% compile and
12.9% search regression); the final comparison follows the single-host change,
not a relaxed threshold. Instrumented runs are diagnostic only. This synthetic
184-record MiniSearch proof does not certify bundled embedding-service performance.
The rebuilt `dec05556` CLI image passes compiler (four parts, ten Linux tests),
Runtime (six parts), and CLI/Console owner (eleven parts) proofs. The latest
Windows full suite first passed 729/730; a subsequent full rerun passed 730/730
with both real Docker worker checks enabled. The intermittent loopback-refresh
timeout remains unexplained, and these checks are not the complete release gate;
see the [system map](../architecture/system-map.md) for dated evidence and remaining work.

## Evidence and acceptance

Docker DKB upgrade planning uses the owner CLI's existing package listing,
including authoritative applied version, origin and generation. The host asks
that origin for the latest release and mints an exact-plan grant only when
applying an upgrade. The v2 fixed install worker validates the expected Library
generation under the existing native writer lease and retains ownership through
the shared installer. It does not create a second upgrade transaction. Stale
plans fail before remote acquisition. Native CLI upgrades use the same guard,
including when a Runtime refresh URL is supplied. Dry runs never request grants or layers.
The worker protocol change requires a matching image; there is no v1 fallback.
This closes package-upgrade delegation, not volume backup/restore or every
remote Runtime administration path. Dated executable evidence lives in the
system map.

Native and Docker package operations share the same destination contract:
the resolved Library owns install, upgrade and removal. An explicit Runtime URL
requests a refresh after commit, not an alternate installation or removal path.
The native Runtime-routing branches are removed; no new installer is introduced.
The existing writer lease is released before the HTTP refresh, and failed
refreshes preserve the authoritative committed Library with an actionable warning.

An isolated Node 22 / Docker 28.3.2 local ext4-volume proof rejected a concurrent
SQLite owner, released ownership after process death, and rolled back an
uncommitted ledger write. It removed its own containers and volume. This proves
the storage primitive, not completed DKB management or performance.

The actual built Library modules now pass 72 Linux-volume storage, ownership,
mutation-recovery, authority, and read-snapshot tests with no skips. Two distinct containers
serialize 20 real mutations, reject reads during ownership/pending recovery,
and recover the exact prior state after killing the writer. The real Windows
bind mount is rejected by the actual Library read path before opening a database;
its host ledger bytes remain unchanged. The focused native Windows runs also
cover Runtime HTTP/MCP rejection during pending recovery. Reproduce the opt-in Linux
proof after building with `node tests/library-storage-owner-proof.mjs --run`;
it uses an installed image ID, synthetic state, and labeled cleanup.

The October 13 owner CLI proof passes three consecutive runs of product-file
inspection, initialization/inspection without a Runtime, two independent
containers mutating one Library, cancellation cleanup, fail-closed reads after
killing a writer, exact manifest recovery with both Collections retained, and
rejection of a missing volume without creating it. The repeated proof caught
premature read preflight on competing CLI writes; admission now queues for the
writer lease first, while actual recovery remains explicit. The file allowlist
check is not a complete image vulnerability or secret-content audit.
The expanded October 13 proof also passes public CLI registration/selection,
checked/unchecked listings, name-based reads and offline writes, single-result
event output, cooperative public cancellation, and name-based recovery. Its
eleven-part form also exercises the real Console runner and Activity storage for
volume-backed inspection and Registry-default changes, including unchanged
settings and host associations, while rejecting unsupported verification explicitly.
Recovery guidance names the registered Library rather than the container mount.
Both remote TCP/SSH and non-local Windows named-pipe contexts fail preflight. The
isolated host catalog and proof volume are removed; no existing Library is moved.
Run `node tests/library-owner-cli-proof.mjs --run` after building the candidate
CLI image and host CLI. This synthetic local-only proof does not certify
Registry authentication, full Console lifecycle, backups or migration.

The paired query-cost proof compares committed Library/Runtime code and compiler
ownership against the
candidate without resetting the checkout. It checks byte-identical responses
and retained source/build/lock bytes. Its `--system` mode reuses the existing
dense corpus and real MiniSearch compiler/query harness, including mandatory
audit for search, fetch and insufficient results. Six paired runs balance which
implementation executes first; all valid samples participate in the unchanged
10% median comparison. Neither mode is a TEI/FAISS
or real-user-corpus certification. Run it with no competing DKB proofs:

```text
node tests/runtime-library-query-cost-proof.mjs --run
node tests/runtime-library-query-cost-proof.mjs --run --system
```

The Runtime ownership proof uses the packaged CLI image and separate containers
on a synthetic Linux-local volume. Paused readers admit other readers but exclude
writers; paused writers exclude both. Confirmed process death releases the lease,
and another Runtime root remains independent. The actual Windows bind mount is
rejected before state creation. It also runs the native Runtime ownership suite
inside the Linux image and exercises two real activations of one synthetic
lexical Library: identical Evidence IDs, immediate stale rejection after
deactivation, and independent refresh without serving removed knowledge.
Run `node tests/runtime-native-ownership-proof.mjs --run`; its six-part October 13
run passed and removed only its labelled resources. This does not certify
two different model providers or completed Stack lifecycle wiring.

The boundary remains open until native Windows and Linux crash/lifecycle tests,
unsupported-mount rejection, queued/concurrent ownership, complete delegated
CLI/Console operations, stopped-Runtime recovery, backup/restore, two independent
Runtimes, and the existing performance/release gates pass on the final candidate.
The earlier mixed-filesystem performance results are not a new baseline.

References: [Docker volumes](https://docs.docker.com/engine/storage/volumes/),
[Docker WSL guidance](https://docs.docker.com/desktop/features/wsl/),
[SQLite remote-storage caveats](https://www.sqlite.org/useovernet.html).
Windows probe contracts: [DriveType](https://learn.microsoft.com/en-us/office/vba/language/reference/user-interface-help/drivetype-property),
[FileSystem](https://learn.microsoft.com/en-us/office/vba/language/reference/user-interface-help/filesystem-property),
[Windows Script Host](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cscript).
