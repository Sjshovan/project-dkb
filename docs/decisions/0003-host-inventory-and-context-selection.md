# Decision 0003: Host Inventory And Context Selection

Status: implemented

## Decision

DKB keeps a disposable, machine-local catalog at `~/.dkb/host.json`. The
versioned `dkb.host.v2` document remembers known Libraries, Registry endpoints,
Runtime endpoints, Stacks, and one default item of each kind. `DKB_HOST_INVENTORY`
overrides the file location for tests and automation.

This catalog is convenience state, not a control plane. A Library's manifest,
locks, and applied-state ledger remain authoritative for knowledge. A Runtime
remains authoritative for its live state, and a Registry service remains
authoritative for published releases. The host inventory contains no tokens,
passwords, package content, pipeline configuration, or service state.

DKB never discovers resources by scanning disks or networks. `dkb init` and
Library-bound commands register valid Libraries they actually use. Registry
configuration records the corresponding endpoint. Successful local Runtime
launches record their endpoint and launch metadata. Missing and offline entries
remain visible until an operator explicitly unregisters them.

The CLI exposes separate inventories because the resources have different
lifecycles:

```text
dkb library list|register|unregister|use
dkb registry list|register|unregister|use
dkb runtime list|register|unregister|use
```

There is deliberately no combined `dkb host` command. `dkb remote` records
Registry-verified endpoint discovery and attestation metadata; it does not
describe host Runtime instances or proxy queries. A hosted Runtime that should
be queried by the CLI is also registered in the host Runtime inventory. This
clarification is superseded and enforced by Decision 0010.

## Resolution

Library-bound commands resolve:

1. explicit `--library` name or path;
2. `DKB_LIBRARY_PATH`;
3. the nearest parent Library;
4. the selected host Library;
5. an actionable error.

Runtime clients resolve:

1. explicit `--url`;
2. `DKB_RUNTIME_URL`;
3. the selected host Runtime;
4. `http://127.0.0.1:7331`.

Registry selection remains Library-specific. An explicit URL and environment
override win first, followed by the target Library configuration, its registered
host association, the default host Registry, user fallback, and localhost
default. Reads never rewrite any of those sources. `dkb stack up` writes the
Stack Registry into both the generated Library configuration and its host
association after the Stack has passed health checks.

## Reliability And Safety

Inventory mutation uses a host-local lock, a sibling temporary file, and atomic
replacement. Readers validate the complete schema and reject unknown fields.
A malformed file is never silently reset or overwritten; the operator must
repair it or move it aside. Registry URLs are normalized and deduplicated.
Library paths are canonicalized, including case-insensitive comparison on
Windows.

`library list` checks local manifests because that has no network side effect.
Registry and Runtime lists probe only with `--check`; failed probes become
statuses and never make an otherwise valid inventory listing fail.

Unregister only forgets convenience state. It never deletes a Library, stops a
Runtime, or changes a Registry. A Registry cannot be unregistered while a known
Library still references it.

## Consequences

Ordinary Library commands work from unrelated directories after a default is
selected, while explicit and environment overrides remain deterministic for
automation. Multiple local or remote resources can be named without pretending
the host catalog can prove they are currently online. Deleting `host.json`
loses shortcuts and selections only; it does not lose knowledge or services.
