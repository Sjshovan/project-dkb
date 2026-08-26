# DKB CLI UX Contract

The DKB CLI follows a small, predictable output contract modeled on mature
operator tools such as Docker.

This document describes the implemented presentation contract. The accepted
next control-plane model, known lifecycle gaps, and public-release gate are
recorded separately in
[`decisions/0001-cli-control-plane-and-release-gate.md`](decisions/0001-cli-control-plane-and-release-gate.md).
That decision is marked implementation pending; do not read its target commands
as claims about current behavior.

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
  healthy: `health` requires `ready`, `search-health` rejects `unavailable`,
  and `compiler doctor` requires `ok: true`.

## Install behavior

`dkb install` resolves lightweight release metadata first and compares it with
the Library lock before downloading the package archive.

- The same version and release digest returns `already installed` without an
  archive request.
- A different installed version is rejected before download unless `--force`
  is present.
- Reuse of a published version with a different digest is rejected as an
  immutable-release violation.
- A package directory without matching runtime lock metadata is reported as an
  incomplete installation; `--force` repairs it.
- New and forced installs stream the archive directly to disk, verify its
  Registry digest, extract it once, verify package contents and signatures,
  validate the retrieval index, and atomically activate it. Activation reports
  its actual subphases (package promotion, catalog refresh, install recording,
  runtime-readiness verification, and finalization) as indeterminate work; it
  never invents a percentage or ETA for those unequal operations.

The runtime performs a second installed-path check immediately before
activation to cover concurrent installs.

`dkb list --library <path>` shows installed DKBs and Collections in a compact
table, including compiled record counts for DKBs. `dkb library status` also
distinguishes installed, inactive, broken, and untracked entries. A folder is
never called installed merely because it exists.

Collection install resolves the immutable revision and all exact member
releases before mutation. Shared members with the same identity, version, and
digest are reused. Conflicting versions fail before download. Uninstall removes
the Collection ownership edge and prunes only Registry DKBs with no remaining
root or Collection owner.

## Registry selection

Each DKB Library can keep its own upstream Registry URL
in `.dkb/config.json`. This is local operator configuration: it is not written
to portable `dkb.json`, package sources, release receipts, or signed lock data.

Registry selection uses this precedence:

1. command `--url`;
2. `DKB_REGISTRY_URL`;
3. the target Library's `.dkb/config.json`;
4. the user fallback at `~/.dkb/config.json` (or `DKB_CLI_CONFIG`);
5. `http://127.0.0.1:8000`.

From inside a DKB Library, `dkb registry use <url>` updates that Library.
`--root <path>` selects another Library and `--global` updates only the user
fallback. `dkb install --library <path>` resolves the URL for that Library
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

`dkb add` removes its host-side staging copy after both successful and failed
runtime imports. If cleanup itself fails after a successful import, the import
remains successful and the retained path is reported as a warning.

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
