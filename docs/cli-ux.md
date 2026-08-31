# DKB CLI UX Contract

The DKB CLI follows a small, predictable output contract modeled on mature
operator tools such as Docker.

This document describes the implemented presentation contract. The accepted
control-plane model and public-release gate are recorded in
[`decisions/0001-cli-control-plane-and-release-gate.md`](decisions/0001-cli-control-plane-and-release-gate.md).
The ordinary package lifecycle from that decision is implemented; remaining
release gates concern distribution, cross-platform proof, and operational
hardening rather than missing public command names.

## Output modes

| Invocation | Result output | Progress | Errors |
| --- | --- | --- | --- |
| `dkb ...` in a terminal | Concise human text and aligned tables | Spinner or real progress bar | Human-readable on stderr |
| `dkb --no-progress ...` | Concise human text and aligned tables | Disabled | Human-readable on stderr |
| Piped or redirected `dkb ...` | Concise human text | Disabled automatically | Human-readable on stderr |
| `dkb --json ...` | One JSON document on stdout | Disabled | One structured JSON error document |

`--no-progress` is not a machine-output switch. Scripts that parse results must
use `--json`. Long-running server and watch commands are the deliberate
exception to the one-document rule: they remain open and emit newline-delimited
event records for their lifetime.

## Command behavior

- Read-only list, status, inspect, query, and health commands print their result
  directly without a ceremonial success message.
- Mutating and long-running commands identify their operation, expose each real
  phase, print a compact result, and finish with `Done.`
- Human tables use stable columns without ornamental separator rows. Empty
  collections print `(none)`.
- Root, command-group, and leaf-command help use the same semantic color system:
  cyan section headings and signatures, white descriptions, and a bold usage
  label. `NO_COLOR` keeps every help level plain.
- Health and verification tables render `STATUS` as `OK` or `FAILED`, Registry
  verification impact as `BLOCKING` or `OPTIONAL`, and transport response codes
  as `HTTP`. Raw booleans remain unchanged in `--json` output.
- Interactive terminals use restrained color for headings, paths, statuses,
  completion, warnings, and failures. `NO_COLOR`, `NODE_DISABLE_COLORS`, and
  `FORCE_COLOR` follow Node's standard terminal-color behavior.
- Progress bars are used only with a known total. Unknown work uses an
  indeterminate spinner and never invents a percentage.
- Byte progress uses human-readable binary units.
- Domain failures begin with `Error:`. Usage failures begin with `dkb:` and
  point to the exact command's `--help` page.
- Successful commands exit `0`; validation failures and command errors exit
  nonzero.
- Diagnostic commands also return nonzero when their printed report is not
  healthy: `health` requires `ready`, `pipeline verify` requires every selected
  provider to be healthy, and `compiler doctor` requires `ok: true`.

## Install behavior

`dkb install` resolves lightweight release metadata first and compares it with
the Library lock before downloading the package archive.

- The same version and release digest returns `already installed` without an
  archive request.
- A different installed version is rejected before download unless `--force`
  is present.
- Reuse of a published version with a different digest is rejected as an
  immutable-release violation.
- A package directory without matching Library applied-state metadata is
  reported as an incomplete installation; `--force` repairs it.
- New and forced installs stream the archive directly to disk, verify its
  Registry digest, extract it once, verify package contents and signatures,
  validate the retrieval build, and atomically install it. Installation reports
  its actual subphases (package promotion, install recording, serving-Runtime
  refresh, and finalization) as indeterminate work; it
  never invents a percentage or ETA for those unequal operations.

The Library transaction performs a second installed-path check immediately
before promotion to cover concurrent installs.

`dkb list --library <path>` shows installed DKBs and Collections in a compact
table, including compiled record counts for DKBs. `dkb library status` also
distinguishes installed, inactive, broken, and untracked entries. A folder is
never called installed merely because it exists.

Collection install resolves the immutable revision and all exact member
releases before mutation. Shared members with the same identity, version, and
digest are reused. Conflicting versions fail before download. Uninstall removes
the Collection ownership edge and prunes only Registry DKBs with no remaining
root or Collection owner.

## Package lifecycle

The top-level lifecycle is intentionally small and consistent:

```text
dkb search [query] [--url <url>] [--type all|dkb|collection] [--page <n>] [--per-page <n>]
dkb install <identity>
dkb list
dkb show <identity>
dkb retrieve <need>
dkb outdated [identity]
dkb upgrade <identity> [--dry-run]
dkb uninstall <identity>
```

`search` queries both DKBs and Collections in the configured Registry. With an
explicit `--url`, it works outside a Library. Results are case-insensitive,
paginated, and ordered by the latest published release. `show` reports bounded operational
metadata for an installed entry, including receipt state and the active
Evidence/Retrieval Build when present. Its explicit inspection modes are:

```text
dkb show <identity> --contents <directory> [--cursor <path>] [--limit <n>]
dkb show <identity> --preview <file>
dkb show <identity> --verify
```

Remote inspection remains under the Registry command group so it cannot be
confused with installed state:

```text
dkb registry show <identity> [--version <version> | --revision <revision>] [--url <url>]
dkb registry show <dkb> --version <version> --contents [path] [--cursor <cursor>] [--limit <n>]
```

Remote Contents expose signed path, size, and hash metadata only. File bodies
are available after installation through `dkb show --preview`.

Contents are restricted to the portable package tree; `.dkb`, receipts,
configuration, traversal, and symlink escapes are excluded. Preview reads at
most 256 KiB and treats the result as inert source data. Binary and image files
are metadata-only. `--verify` performs a fresh one-time check of the manifest,
portable tree, immutable build graph, and available signed receipt chain, then
returns exact recovery commands. `outdated` checks only Registry-installed DKBs
and fails on an unreachable Registry rather than claiming the Library is
current. `upgrade --dry-run` resolves the exact latest version without mutating
the Library.

Registry authentication uses `dkb registry login`, `whoami`, and `logout`.
Login defaults to authorization code plus PKCE through the system browser and
an ephemeral loopback callback. `--device` supports headless interactive login;
automation can use `--token-stdin` or `DKB_REGISTRY_TOKEN`. The scoped token is
stored in the machine-local credentials file, never in a Library, host
inventory, package, or Git. `logout --revoke` invalidates the remote token
before removing the local credential. Secret-bearing command arguments are not
part of the CLI surface.

## Command lifecycle

An intentional public command name is product surface, including one whose
backing service is planned but unfinished. Cleanup must not silently delete it.

- Implemented commands run their real operation.
- Renamed or reorganized commands retain a working compatibility entry until a
  separate product decision removes it. `dkb add` delegates to the same Runtime
  import operation as `dkb runtime import`; `dkb compile` invokes the same
  compiler used by `dkb build`.
- Planned commands remain visible, include `(not yet implemented)` in help, exit
  nonzero, and name the currently supported workflow. They use the shared
  `notYetImplemented` helper so human and `--json` behavior stay consistent.
- A command may be removed only when an architecture decision explicitly marks
  it superseded or abandoned and its help/documentation regression tests change
  in the same patch.

## Host inventory and selection

`~/.dkb/host.json` is a disposable `dkb.host.v2` catalog of known resources on one machine.
Set `DKB_HOST_INVENTORY` to isolate automation or tests. The catalog stores only
names, canonical Library paths, endpoint URLs, selections, and optional local
Runtime launch metadata. It never stores credentials, knowledge, installed
package state, or pipeline configuration.

```text
dkb library list
dkb library register <path> [--name <name>]
dkb library unregister <name-or-path>
dkb library use <name-or-path>

dkb registry list [--check]
dkb registry register <name> <url> [--no-verify]
dkb registry unregister <name>

dkb runtime list [--check]
dkb runtime register <name> <url> [--library <name-or-path>] [--no-verify]
dkb runtime unregister <name>
dkb runtime use <name>

dkb stack list [--check]
```

Library lists validate local manifests immediately. Registry and Runtime lists
make no network calls unless `--check` is present. Offline results are table
statuses, not command failures. Missing and offline records remain until
explicitly unregistered. Unregistering is non-destructive, and stopping a local
Runtime never unregisters it.

Human inventory tables label the fallback marker `DEFAULT`, not `SELECTED` or
`CURRENT`. The word is intentional: explicit flags, environment variables, and
a nearer Library can override that default for one command. Structured JSON
continues to expose the stable `selected` field from `dkb.host.v1`.

`dkb init` registers its Library and configured Registry. Commands that use a
valid older Library register it opportunistically. DKB never scans disks or
networks looking for resources.

Library resolution is explicit `--library`, `DKB_LIBRARY_PATH`, nearest parent
Library, then selected host Library. Runtime URL resolution is explicit
`--url`, `DKB_RUNTIME_URL`, selected host Runtime, then localhost. Lists work
from every directory. If a selected Library is missing, the error points to
`dkb library list`; DKB does not silently select another one.

## Registry selection

Each DKB Library can keep its own upstream Registry URL
in `.dkb/config.json`. This is local operator configuration: it is not written
to portable `dkb.json`, package sources, release receipts, or signed lock data.

Registry selection uses this precedence:

1. command `--url`;
2. `DKB_REGISTRY_URL`;
3. the target Library's `.dkb/config.json`;
4. the selected Registry in the host inventory;
5. the user fallback at `~/.dkb/config.json` (or `DKB_CLI_CONFIG`);
6. `http://127.0.0.1:8000`.

From inside a DKB Library, `dkb registry use <name-or-url>` updates that Library
and selects the known Registry. `--root <name-or-path>` selects another Library
and `--global` updates only the user
fallback. `dkb install --library <name-or-path>` resolves the URL for that Library
automatically. `dkb list` displays the
resolved URL and its source.

`dkb registry use` always saves a syntactically valid URL. If the endpoint is
offline or incompatible, the command succeeds with a warning and prints the
exact `dkb registry status --url <url>` verification retry. `dkb serve` uses
the same initialization and URL-selection path as `dkb init`; `--yes` permits
explicit noninteractive creation, while `--registry-url` and `--no-verify`
control the upstream selection.

Bare `dkb init` checks the current directory and initializes it as a Library
only when needed. It prompts for the upstream URL in an interactive terminal,
attempts verification, and stores it in `.dkb/config.json`. An unavailable
upstream does not block local creation; the result includes a warning and the
exact `dkb registry use <url>` retry command. Noninteractive use automatically
accepts the resolved default, while `--registry-url <url> --yes` selects one
explicitly. `--no-verify` is available for an intentionally offline Library.

## Registry transport safety

## Compilation scale and capacity

Human `dkb build` summaries report the actual scale that
drives RAG cost: source bytes/files, Evidence text/records, chunks per source,
derived bytes, and expansion ratio. File count is never presented as a proxy
for chunk count. `--json` includes full distributions, the largest compiled
artifacts, stage timings, and disk preflight results.

Before parsing and again before embedding/index creation, DKB verifies that the
target filesystem can hold the estimated working set plus its safety reserve.
An insufficient-space error leaves the prior active build unchanged and tells
the operator to free space and retry.

`dkb registry pull` refuses to overwrite an existing archive unless `--force`
is present. Downloads and local-registry copies are completed in a sibling
temporary file before activation, so a failed transfer preserves the previous
output. Forced replacement keeps the old archive until the new one is fully
received.

Publishing a package and registering its hosted runtime are separate outcomes.
If the package is published but remote registration fails, `dkb registry
publish` reports the package as published, emits a warning, and prints the
exact `dkb registry remote claim <package>@<version> --url <url>` retry command.
An HTTP 422 during package reservation is accepted only after the client
confirms that the requested package actually exists.

`dkb runtime import` compiles a disposable copy locally, stages only the verified compiled
artifact, and removes both temporary copies after successful and failed Runtime
activation. If staging cleanup fails after activation, activation remains
successful and the retained path is reported as a warning.

`dkb add` is the retained top-level convenience form of this same operation.
`dkb compile` is the retained compiler-oriented form of `dkb build`; it accepts
both `--pipeline` and the earlier `--target` option name.

## Examples

```powershell
# Human output with interactive progress
dkb install @sjshovan/assembly-toolbox-jd --version 0.1.10 --url http://127.0.0.1:8017

# Human output without animation
dkb --no-progress registry packages

# Stable automation output
dkb --json install @sjshovan/assembly-toolbox-jd --version 0.1.10

# Set this Library's upstream Registry
dkb registry use https://registry.example.com --root C:\knowledge\library

# Set the user-wide fallback
dkb registry use https://registry.example.com --global

# Replace a previously downloaded archive intentionally
dkb registry pull @sjshovan/assembly-toolbox-jd --version 0.1.10 --force
```
