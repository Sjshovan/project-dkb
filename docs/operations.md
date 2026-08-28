# DKB Operations

## Scope

This guide covers the local developer-preview CLI, Libraries, Runtime, compiler
services, and host inventory. The Laravel Registry is a separate service with
its own deployment and administration guidance.

## Credentials

Registry tokens are process inputs, not DKB state:

```powershell
$env:DKB_REGISTRY_TOKEN = '<token>'
dkb registry packages
```

Use `--token` only when shell-history exposure is acceptable. Tokens, MCP bearer
secrets, Meilisearch keys, and service credentials must not be written to
`dkb.json`, `.dkb/config.json`, `dkb-lock.json`, Runtime locks, build receipts,
host inventory, or Git.

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
