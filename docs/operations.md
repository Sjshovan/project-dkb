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

## Storage ownership

| Location | Owner | Back up? |
| --- | --- | --- |
| DKB source folders | author | yes |
| `dkb.json` | author/operator | yes |
| `dkb-lock.json` | Library resolver | yes |
| `.dkb/state.sqlite` | Library transaction layer | with the Library |
| `.dkb/builds/` | compiler | optional; reproducible from source/Evidence IR |
| `vendor/` | Registry installer | optional; reinstallable from signed releases |
| `~/.dkb/host.json` | CLI convenience inventory | no; disposable |
| `.dkb/plugins/` | trusted operator | yes, separately from knowledge packages |

Corpus size is driven by source bytes and produced chunks, not file count. Rich
documents, tables, code, and repeated build spaces can expand storage well
beyond the original source. Use `dkb library storage` for a Library-wide view,
review build summaries before retaining multiple inactive spaces, and inspect
one package with `dkb build list <package>`. Explicitly prune inactive package
builds with `dkb build prune <package>`.

## Backup and restore

For the complete local stack, stop writers and create a checksummed archive:

```powershell
dkb stack down local
dkb stack backup local
dkb stack restore C:\secure\local-2026-08-28.tar.gz --replace
dkb stack up local
```

The archive includes the Registry SQLite database, package storage, Runtime
Library, stack configuration, and stack secrets. It is sensitive. Restore
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
5. Run `dkb health <library>`, `dkb library status`, and `dkb pipeline verify`.
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
second lifecycle implementation. Use `dkb console status` to inspect the
process and `dkb console stop` to stop only the interface. Console activity is
redacted and stored locally; authoritative state remains in the Library,
Runtime, Registry, and host inventory.

Runtime installation does not receive the host Registry token. The CLI obtains
a grant bound to one signed source/Evidence/Retrieval plan. The grant must be
redeemed within five minutes; after redemption, only that exact three-layer
transfer may complete within its bounded transfer window. Expired, replayed,
cross-package, or cross-build use is rejected.
