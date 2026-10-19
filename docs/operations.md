# DKB Operations

## Scope

This guide covers the local developer-preview CLI, Libraries, Runtime, compiler
services, and host inventory. The Laravel Registry is a separate service with
its own deployment and administration guidance.

## Install disk capacity

Compressed download size is not the installed size. The shared extractor admits
files in one streaming pass and budgets expanded bytes plus conservative
file/directory allocation against half the destination's free space at the start
of each archive. The remainder leaves room for promotion, rollback and other
work; it is not a cross-process disk reservation.

`archive_capacity_exceeded` means free space or choose a larger storage destination
before retrying. `archive_capacity_unavailable` means the storage probe could not
be verified. `archive_entry_limit` rejects archives over 100,000 entries by
default; split unusually large releases or review the trusted integration's
`extractDkbPackageArchive` limits. `archive_size_limit` reports an explicitly
configured expanded-byte limit. Installed state is promoted only after complete
extraction and verification; failed staging is cleaned by the caller. These
guards apply to native and Docker-owned DKB installations. Signed layer downloads
also check the compressed allocation against half the scratch destination's free
space before requesting bytes. `download_capacity_exceeded` requires freeing
space or choosing larger storage; `download_capacity_unavailable` means the
filesystem could not be checked. Concurrent disk users can still exhaust space.

For a registered Docker Library, ordinary `dkb install @team/package --library
team --version 1.0.0` obtains an exact signed install-plan grant on the host and
installs inside Linux-local storage. An explicit `--url` overrides the Library's
default Registry without changing it. The worker needs no running Runtime and
receives no reusable Registry login. Disposable download/extraction scratch is
an anonymous Linux volume, removed with its uniquely owned container. The named
Library survives cancellation; interrupted mutations use `dkb library recover
--library team`.

Collections use the same commands and owner-side transaction:

```text
dkb install @team/handbooks --revision 2 --library team
dkb collection update @team/handbooks --revision 3 --library team
dkb uninstall @team/handbooks --library team
```

The host resolves one exact Collection revision and obtains a grant for each
signed member plan. Linux verifies every member chain before downloading and
commits the whole Collection together. Failed later-member downloads roll back
earlier promotions; retries reuse verified retained files. Directly installed
members remain after Collection removal and cannot be silently changed by a
Collection update. The Console uses the same install path.

For Docker DKB upgrades, use `dkb outdated --library team`, then
`dkb upgrade @team/package --library team --dry-run` and the same command without
`--dry-run`. Planning requests no grant or artifact download. Installation uses
the recorded package origin and the existing signed-layer verifier; Windows
never opens the Library database. The owner's v2 install protocol requires a
matching rebuilt CLI image. A `library_upgrade_conflict` means the applied state
changed after planning: inspect `dkb outdated --library team` and retry. The
worker holds the writer lease from this check through installation. Corrupt
downloads do not replace the previous package. The broader network and Stack
verification gate remains separate from this signed installer.

For an online Runtime, `dkb pipeline use <target> --runtime <name>` reads build
coverage from that endpoint, obtains missing signed builds using each package's
saved Registry login, and submits exact grants to the owner. The owner validates
the captured Library/Runtime/recipe state before downloads and promotion. A
`runtime_pipeline_conflict` requires refreshing `dkb pipeline list --runtime
<name>` and retrying; no previous activation is replaced. `--registry-url` can
confirm an installed origin and scope an environment token, not redirect packages
from a different Registry. Unscoped environment tokens are not sent to origins
reported by a remote Runtime. Offline preparation and Docker editable-source
compilation are not yet supported by this path.

## Library destination and Runtime refresh

For native and Docker-owned Libraries, `--library` (or the shared Library
selection) is the package destination. An `install` / `upgrade --runtime-url`
or `uninstall --url` requests a Runtime refresh after committing to that Library;
it does not install into or remove from the endpoint's independently bound Library.
Serving local Runtimes registered for the changed Library are refreshed as well.
An unavailable Runtime produces a stale warning and recovery command, not a
failed package transaction. Dry-run, failed validation and stale-generation
rejection do not refresh Runtimes.

## Credentials

Registry tokens are host credentials, not DKB state. Interactive users should
authenticate once through browser PKCE and a loopback callback:

```powershell
dkb registry login
dkb registry whoami
```

On a headless host, use `dkb registry login --device`. The default interactive
credential lasts twelve hours and requests `registry:read`; publish or build
work requests explicit additional scopes.

Automation can keep using process input:

```powershell
$token | dkb registry login --token-stdin
dkb registry packages
```

`DKB_REGISTRY_TOKEN` remains available to isolated automation. Secret-bearing
command arguments are rejected. The Console uses the saved host credential,
including an operator-selected `DKB_REGISTRY_CREDENTIALS` file; it does not
forward `DKB_REGISTRY_TOKEN` into its CLI environment. Tokens, MCP bearer secrets, Meilisearch keys,
and service credentials must not be written to
`dkb.json`, `.dkb/config.json`, `dkb-lock.json`, Runtime locks, build receipts,
host inventory, or Git.

Credentials are keyed by normalized Registry URL in `~/.dkb/credentials.json`
(or `DKB_REGISTRY_CREDENTIALS` for isolated automation). DKB writes the file
atomically with owner-only permissions where the operating system supports
them. Run `dkb registry logout --revoke` on a lost or retired host.

## Registry compilation and cancellation

The Registry and its trusted Node compiler must receive the same nonempty
`DKB_COMPILER_SERVICE_TOKEN` through server-side environment/secret injection.
`dkb stack up` generates and wires it automatically. A standalone compiler
refuses startup without it, and a Registry with missing or rejected credentials
cannot submit work. This token is separate from user Registry login tokens.
Do not place it in an uploaded package or Pipeline recipe.

Registry operators choose trusted recipes; uploads cannot supply plugin code or
compiler configuration. Queue requests pin both the resolved recipe digests and
the installed compiler build identity. A different compiler installation must
not finish a request queued against older bytes.

```powershell
dkb registry pipeline list
dkb registry build @team/handbook --version 1.0.0 --pipeline tei-faiss
dkb registry cancel-build @team/handbook --version 1.0.0 --job 42
```

Build requests and cancellation require a namespace-team administrator with
`registry:build`. Canceling never-started queued work prevents it from starting.
Previously started retries also contact the compiler because their last outcome
may be unknown. Running work receives an abort signal; `cancelling` means the compiler has not yet confirmed
that it stopped. Retry the displayed cancellation command if the control
connection was unavailable. Canceled output cannot be published. Previously
published variants and immutable source remain unchanged; cancellation of an
already published job reports `published` without undoing publication.

Each queue execution has a unique ID and a 24-hour deadline. Delayed retries of
a canceled execution are rejected even after a compiler restart. Cancellation
markers live in the trusted compiler context under `.dkb/compiler-cancellations/`
and expire with their request deadline. Pending execution directories there do
**not** expire: they contain private recovery handles and remain until the
original worker acknowledges that it stopped and cleanup succeeds. Never package
or share this directory as knowledge.

`compile_termination_unconfirmed` leaves the Registry job `cancelling`, retains
its execution identity, and suppresses automatic compilation retries. Restore
the original worker connection and exact compiler/provider configuration, then
repeat `dkb registry cancel-build` for that same job. Do not remove working files
or start a duplicate build while termination is uncertain. A worker restart,
timeout, or missing response alone does not confirm cleanup is safe.

The warm Python Evidence supervisor uses service protocol 5 and must run as PID 1
in its Linux Docker container. Do not add an init wrapper or launch it as a bare
native Python service. Upgrade the compiler and Evidence image together; older
service versions are rejected. See the [cancellation decision](decisions/0011-worker-confirmed-compilation-cancellation.md).

After **confirmed** cancellation, request a fresh alternate build. An
initial unpublished source version stays retained and cannot be overwritten.

## Runtime HTTP access

`dkb runtime serve` and `dkb serve` generate separate host-local read/admin
credentials and register the process endpoint. Ordinary CLI and Console
operations resolve these credentials automatically; no token argument is
needed. New Linux-volume Stacks generate separate credentials in private host
Stack configuration. Existing host-mounted Stacks require explicit offline
migration before this version can start them; startup never moves their data.

When directly launching `dkb-runtime`, provide `DKB_RUNTIME_ADMIN_TOKEN` and,
for read-only clients, a distinct `DKB_RUNTIME_READ_TOKEN`. Clients can supply
these through their environment. Credentials are endpoint-specific and must
not be copied into Library configuration or host inventory. Tests isolate
generated credentials with `DKB_RUNTIME_CREDENTIALS_ROOT`.

Anonymous health does not imply authorized access: a reachable Runtime can
still reject a client credential. `runtime show` checks authenticated status.
For deliberate public knowledge serving, select `--public-read` on a serve
command or set `DKB_RUNTIME_READ_ACCESS=public-read`. Management remains private.
Public citation URLs additionally require `DKB_MCP_PUBLIC_DOCUMENTS=true`.
See [HTTP security boundaries](security.md#runtime-and-compiler-http) for
proxy Host/Origin configuration and the separate MCP authority.

## Storage ownership

### Inspect retained historical evidence

The Runtime audit view links only exact retained package versions and builds.
The corresponding CLI inspection is:

```powershell
dkb show @team/handbook --library personal --version 1.0.0 --evidence-build <evidence-digest> --evidence <evidence-id>
```

Both digest arguments are complete `sha256:` identities. This reads one inert
record from the installed package's exact Evidence catalog; it does not query a
Runtime, load a plugin, compile source, or substitute the newest build. Missing,
mismatched, removed, or corrupt objects fail with recovery guidance. Text is
limited to 64 KiB, individual metadata fields to 16 KiB, and the response to
256 KiB; truncation is explicit and UTF-8 safe. Content identity inspection is
not Registry signature certification. Use the Build inspector's verification
action to check its exact trust chain.

### What to retain

| Location | Owner | Back up? |
| --- | --- | --- |
| DKB source folders | author | yes |
| `dkb.json` | author/operator | yes |
| `dkb-lock.json` | Library resolver | yes |
| `.dkb/state.sqlite` | Library transaction layer | with the Library |
| `.dkb/builds/` | compiler | optional; reproducible from source/Evidence IR |
| `vendor/` | Registry installer | optional; reinstallable from signed releases |
| Runtime state root | Runtime operator | yes for bindings; caches are disposable |
| `~/.dkb/host.json` | CLI convenience inventory | no; disposable |
| `.dkb/plugins/` | trusted operator | yes, separately from knowledge packages |

Corpus size is driven by source bytes and produced chunks, not file count. Rich
documents, tables, code, and repeated build spaces can expand storage well
beyond the original source. Use `dkb library storage` for a Library-wide view,
review build summaries before retaining multiple inactive spaces, and inspect
one package with `dkb build list <package>`. Explicitly prune inactive package
builds with `dkb build prune <package>`.

## Backup and restore

New `dkb stack up` deployments keep databases in labelled Linux-local external
volumes. A private `stack-storage.json` records their exact identities before
creation. Restart verifies those volumes; missing authoritative storage is an
error, never permission to initialize an empty replacement. `--library` selects
a registered Docker Library in the same local Docker context. It does not copy
or remount an existing Stack's Library.

Changing a Linux-volume Stack with `dkb stack up` may restart its services.
The Linux owner prepares recipes and the Runtime commits activation through its
normal gate. Failure before activation restores the previous configuration and
services; activation files and immutable Library builds are never copied back.
A lost response is checked against the actual owner completion and activation
before rollback is considered.

If restoration fails or another operator has changed the Runtime selection,
DKB retains `.control/<name>/owner-startup.json` under the Stack state root and
the owner's recovery state, and reports the conflicting resource. The host
journal contains the previous configuration,
including secrets: keep it private. Resolve the reported issue, then run
`dkb stack up <name>` to retry recovery. DKB does not overwrite a concurrent
activation or externally edited configuration to force recovery.

Host Stack operations share a native control lease outside the Stack data
directory. A concurrent start, stop, backup, restore, or upgrade returns
`stack_busy` rather than racing a topology change. Do not delete the persistent
lease file to unlock a process. Old `startup.lock` files are preserved for
matching-version recovery.

For a stopped, host-directory Stack whose Library and Runtime data are fully
inside its state directory, create a checksummed archive:

```powershell
dkb stack down local
dkb stack backup local
dkb stack restore C:\secure\local-2026-08-28.tar.gz --replace
```

The archive includes the contained Registry SQLite database, package storage,
Library, separate Runtime state, stack configuration, and stack secrets. It is sensitive.
An external, linked, or missing native Library/Runtime is rejected
as `stack_backup_incomplete`; a host-folder archive must not imply those bytes
were included. Docker-owned Stacks use the separate volume snapshot path below,
not this host-folder format. Stop every writer, including standalone Runtimes and CLI mutations,
before archiving; the host Stack lease alone is not a database snapshot.
An unavailable Docker status check fails rather than assuming the Stack stopped.
The stopped-state gate checks every recorded volume, not just containers bearing
this Stack's Compose label. A created, running, paused, restarting or removing
consumer—including another Runtime sharing the Library—requires operator action.
Its error provides a volume-filtered inspection command; DKB does not stop the
other service. Storage/environment drift or unknown Docker metadata fails closed.
This is a preflight, not a lease that prevents another service from starting.
The existing host-directory backup and restore reject linked or special files anywhere in the archive.
Host archives cannot restore volume-only configuration or overwrite an existing
volume-backed Stack. Descriptor files and every declared Docker volume are
rejected before topology promotion, even if the archive checksum is correct.
Restore requires the adjacent `.sha256` file, pre-scans archive paths, stages extraction,
and atomically replaces an existing stopped stack only when `--replace` is
explicit.

For a stopped Docker-owned Stack, `dkb stack backup <name> --output <archive>`
streams host configuration and every recorded Linux volume through the matching
immutable CLI image. The image must advertise `dkb.stack-snapshot-worker.v1`;
an older image is refused, never silently substituted or pulled. The worker
holds native owner leases, preserves Linux ownership and contained cache links,
and verifies exact inventory hashes. The host verifies the stream again before
promoting the archive. Existing archives and checksums are never overwritten.
Scratch files live in an exclusively created per-operation directory rather than
predictable sibling filenames; cleanup does not adopt or delete another
operation's files. Linux file permissions are set before archive publication.
Byte limits reserve 512 MiB on the destination and cap expanded data at 256 GiB;
the inventory is bounded to 32 MiB and at most one million entries. These are
backup limits, not compile or corpus-size recommendations. Archives contain
credentials and require private storage; Unix metadata is not a Windows ACL backup.

Volume restoration currently reaches verified empty staging only. Public
`stack restore` topology promotion remains unfinished and does not yet consume
this new format. Do not treat this as complete disaster recovery or discard the
original volumes. Volume-backed upgrades are explicitly blocked until their
rollback path is connected and verified. The bounded public-backup/staged-restore
proof is `node tests/stack-volume-snapshot-proof.mjs --run --public` from the
checkout; consult the dated system map for its current result, not just this contract.

Upgrade only from a digest-pinned private release lock:

```powershell
dkb stack down local
dkb stack upgrade local --lock C:\secure\dkb-stack-0.1.1.lock.json
```

The existing host-directory upgrade path creates a backup first, pulls all exact image digests before mutation,
runs migrations, starts the stack, and checks health. On failure it stops the
candidate, restores the prior archive, and attempts to restart the previous
version. The backup remains available for manual recovery. This is not yet a
supported Linux-volume upgrade path: volume-backed backup/restore remains a
release gate, and an older host-mounted Stack cannot restart without migration.

For an individual Library:

1. Stop writers and pipeline switches for the Library.
2. Back up editable source, `dkb.json`, `dkb-lock.json`, `.dkb/state.sqlite`, and
   trusted local plugin/configuration files.
3. Back up `vendor/` and `.dkb/builds/` only when faster recovery is worth the
   additional storage.
4. Restore the files to one canonical Library path.
5. Run `dkb health <library>`, `dkb library status`, and
   `dkb pipeline verify <pipeline> --runtime <runtime>` for each serving Runtime.
6. Run `dkb restore <library>` when derived artifacts are absent or invalid.

Do not reconstruct installed state by copying folders into `vendor/`. Use
`dkb install`, `dkb library add`, or a complete Library backup so the lock,
ledger, build graph, and filesystem stay consistent.

## Routine checks

```powershell
dkb library list
dkb registry list --check
dkb runtime list --check
dkb health
dkb library storage
dkb pipeline verify
dkb outdated
```

Offline Registry or Runtime inventory entries remain listed until explicitly
unregistered. Unregistering forgets only the host shortcut; it does not delete
knowledge, stop services, or remove remote resources.

## Failure recovery

- **Registry unavailable:** continue local authoring/building; retry with the
  command printed by the CLI.
- **Interrupted Library mutation:** stop its original writer, then run
  `dkb library recover --library "<path>"`. This also works when a displaced
  manifest prevents normal Library discovery. Recovery restores the prior
  state if uncommitted, or retains committed state and finishes verified
  cleanup. It does not compile or download knowledge. Retry the original
  command only after recovery succeeds; `--force` cannot bypass recovery.
- **Recovery cannot verify its files:** preserve `.dkb/state.sqlite`,
  `.dkb/transactions/`, and the affected files for repair. Do not delete lock
  files or guess that an old timestamp means a writer has stopped. A native
  lease file remains after an operation; its existence does not indicate an
  owner. An unresolved guard from an earlier locking protocol requires that
  matching version's recovery. Unsupported shared filesystems fail closed.
- **Pipeline activation failure:** fix the exact missing/incompatible build and
  rerun `dkb pipeline use <target> --runtime <name>`. DKB does not partially
  switch that Runtime or change another Runtime's Pipeline.
- **Runtime busy or earlier ownership guard:** wait for active queries or the
  current activation change. A persistent `runtime-mutation.lease.sqlite` file
  is normal; do not remove it. `runtime_recovery_required` means an older
  `runtime-mutation.lock` guard remains. Stop old processes and recover with the
  matching earlier DKB version; age or a foreign container PID does not prove
  that its writer has stopped.
- **Compiler busy or earlier ownership guard:** wait for the compiler and its
  worker cleanup before retrying. `compile.lease.sqlite` is persistent native
  ownership state, not a stale file to delete. `compile_recovery_required`
  preserves an older `compile.lock`; stop the earlier compiler, confirm its
  workers stopped, and recover with that matching version. Cancelling a queued
  job does not admit it; cancelling active work retains ownership until cleanup
  settles. Unconfirmed workers and their recovery journals remain preserved.
- **Corrupt derived build:** run `dkb build inspect`, then prune/rebuild or use
  `dkb restore`. Do not edit content-addressed build files in place.
- **Missing Library path in host inventory:** restore/register the path or run
  `dkb library unregister <name>` to remove the stale shortcut.

`dkb stack down` preserves volumes and secrets. Treat volume deletion as a
separate, explicitly destructive operator action; the current CLI does not
delete stack data implicitly.

Library recovery is explicit, not a side effect of reads. Pending recovery
blocks installed-state inspection and Runtime evidence responses. A successful
CLI recovery attempts to refresh locally managed Runtimes serving that Library;
an offline Runtime remains stale until refreshed. Read-only recovery status
does not silently select another Library or Pipeline. See
[the Library recovery contract](decisions/0012-crash-safe-library-mutations.md).

Before upgrading from an earlier Library lock implementation, stop
all old CLI writers and Runtime processes that access the same Library. The
native ownership lease cannot coordinate with an old binary that ignores it.
This is a development hard cut; sources, logical package identity, and immutable
build bytes do not need recompilation. Process-death recovery tests do not
certify power-loss durability or arbitrary network filesystem support.
The current recovery candidate refuses partially deleted directory trees.
Preserve these for explicit repair; see the
[documented recovery limits](decisions/0012-crash-safe-library-mutations.md#explicit-recovery-limits).

### Supported Library storage

[ADR 0013](decisions/0013-library-storage-ownership.md) requires one storage
environment per live Library database. Native Windows processes may share a
local fixed NTFS Library. Linux processes/containers may share Linux-local
storage; Docker installations use local named volumes. Several independent
Runtimes and Pipelines can still share that Library.

Windows/Docker bind mounts, network filesystems, symlinked state paths, and
unknown storage are rejected before opening the database. A local tmpfs is
usable for disposable proofs, not durable knowledge. Filesystem validation
does not certify power-loss durability.

Runtime state follows the same rule in its own independent root. Its native
lease allows concurrent queries but excludes activation changes until those
queries finish, across processes as well as within one server. Docker Runtime
state must also live on Linux-local storage, not a Windows bind mount. Never
mix earlier Runtime locking implementations with the new native lease protocol.

Owner-side Windows CLI delegation now covers offline inspection, Library and
Collection edits, uninstall, Registry defaults, and recovery. DKB and Collection
uninstall work without a running Runtime or Registry. They retain dependency
guards, remove only unused Registry files/builds, and preserve editable source.
The host refreshes associated Runtimes afterward; a failed reload is a stale
warning with a recovery command, not a failed uninstall. Registry-default changes
journal configuration and manifest together; pending recovery blocks reads.
Host inventory updates follow the Library commit. Repeating an unchanged
setting repairs convenience inventory without another Library mutation.

**Deployment transition is not complete:** Linux-volume Stack startup and restart
have an isolated real-service proof. Individual signed DKB install also passes
an isolated CLI/Console Docker proof. Collection install/update, dependency reuse,
rollback and cancellation recovery also pass on synthetic signed fixtures.
Docker DKB upgrades use the same signed installer and generation guard; current
proof status is recorded in the system map. Owner-side editable compilation,
offline Pipeline preparation,
volume-aware backups/restore, and explicit offline migration
are still release gates. Existing host-bind Stack configuration must not be treated as
compatible with the new guard. No existing Library is automatically moved,
rewritten, or deleted; preserve its source and stop its writers before choosing
the owning environment.

## Host Console

`dkb console` starts a loopback-only operator interface. It invokes the exact
bundled CLI with typed inputs and `shell: false`; it is not a remote shell or a
second lifecycle implementation. `dkb console enable` installs the operating
system's user-scoped login service and starts it immediately. Windows uses a
least-privilege Task Scheduler entry and Start Menu launcher, Linux uses a
systemd user unit, and macOS uses a LaunchAgent. No administrator or system
account is required.

Use `dkb console restart` to restart the supervised process and issue a fresh
browser session, `dkb console disable` to remove login startup without stopping
the current Console, and `dkb console status` to inspect both process and
registration state. `dkb console stop` stops only the current interface; an
enabled login service returns at the next user login. Console activity is
redacted and stored locally; authoritative state remains in the Library,
Runtime, Registry, and host inventory.

Runtime installation does not receive the host Registry token. The CLI obtains
a grant bound to one signed source/Evidence/Retrieval plan. The grant must be
redeemed within five minutes; after redemption, only that exact three-layer
transfer may complete within its bounded transfer window. Expired, replayed,
cross-package, or cross-build use is rejected.
