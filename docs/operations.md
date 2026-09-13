# DKB Operations

## Scope

This guide covers the local developer-preview CLI, Libraries, Runtime, compiler
services, and host inventory. The Laravel Registry is a separate service with
its own deployment and administration guidance.

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
command arguments are rejected. Tokens, MCP bearer secrets, Meilisearch keys,
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
needed. Existing Stack state acquires the new read/compiler credentials on the
next successful `dkb stack up <name>`; review the Stack backup before restarting.

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

Changing an existing Stack with `dkb stack up` may restart its services. Until
the Runtime commits a validated activation, failure restores the previous
Stack configuration and Library mount, then restarts the prior services if
they were running. Runtime activation files and immutable Library builds are
never copied back. A lost admin response is checked against the actual
committed activation before rollback is considered.

If restoration fails or another operator has changed the Runtime selection,
DKB retains `startup-recovery.json` in the Stack state directory and reports
the conflicting resource. This file contains the previous configuration,
including secrets: keep it private. Resolve the reported issue, then run
`dkb stack up <name>` to retry recovery. DKB does not overwrite a concurrent
activation or externally edited configuration to force recovery.

For the complete local stack, stop writers and create a checksummed archive:

```powershell
dkb stack down local
dkb stack backup local
dkb stack restore C:\secure\local-2026-08-28.tar.gz --replace
dkb stack up local
```

The archive includes the Registry SQLite database, package storage, selected
Library, separate Runtime state, stack configuration, and stack secrets. It is sensitive. Restore
requires the adjacent `.sha256` file, pre-scans archive paths, stages extraction,
and atomically replaces an existing stopped stack only when `--replace` is
explicit.

Upgrade only from a digest-pinned private release lock:

```powershell
dkb stack down local
dkb stack upgrade local --lock C:\secure\dkb-stack-0.1.1.lock.json
```

Upgrade creates a backup first, pulls all exact image digests before mutation,
runs migrations, starts the stack, and checks health. On failure it stops the
candidate, restores the prior archive, and attempts to restart the previous
version. The backup remains available for manual recovery.

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
- **Interrupted install/upgrade:** rerun with `--force` only when the CLI reports
  an incomplete install. The previous active snapshot remains authoritative.
- **Pipeline activation failure:** fix the exact missing/incompatible build and
  rerun `dkb pipeline use <target>`. DKB does not partially switch a Library.
- **Corrupt derived build:** run `dkb build inspect`, then prune/rebuild or use
  `dkb restore`. Do not edit content-addressed build files in place.
- **Missing Library path in host inventory:** restore/register the path or run
  `dkb library unregister <name>` to remove the stale shortcut.

`dkb stack down` preserves volumes and secrets. Treat volume deletion as a
separate, explicitly destructive operator action; the current CLI does not
delete stack data implicitly.

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
