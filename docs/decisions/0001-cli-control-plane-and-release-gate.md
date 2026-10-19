# 0001 - CLI Control Plane And Public-Release Gate

- **Status:** Accepted
- **Date:** 2026-08-26
- **Scope:** DKB CLI, local Library/runtime context, package lifecycle,
  authentication, distribution, and public-release readiness

## TL;DR

Keep the current DKB protocol, compiler, registry, runtime, and MCP architecture.
Do not release the CLI as a stable public 1.0 until top-level package commands
operate on one coherent workspace, the ordinary package-management loop is
complete, hosted-registry authentication is truthful, and the distributable
artifact passes clean-install CI.

## Decision

### One workspace context

Introduce one shared context resolver for ordinary CLI commands. From any
directory inside an initialized DKB Library, it must resolve:

- the nearest Library root;
- the active local runtime state root;
- the upstream package registry URL and its source;
- credentials;
- explicit command and environment overrides.

`init`, `install`, `list`, `show`, `retrieve`, `uninstall`, and `serve` must use
that same resolved state by default. A package installed from the current
Library folder must be visible to both local retrieval and the MCP server
started from that folder.

Explicit HTTP runtime administration remains supported, but it should be
visibly namespaced under `dkb runtime` instead of silently changing the control
plane of a top-level package command.

### Complete the ordinary package lifecycle

The supported human workflow should include:

```text
dkb search <query>
dkb install <package> --version <version>
dkb list
dkb show <package>
dkb retrieve <question>
dkb uninstall <package>
dkb outdated
dkb upgrade <package> --dry-run
```

`dkb show` is the high-level knowledge overview. It should report installed
version, publisher/signature state, source registry, install time, source
counts/types, compiled record count, retrieval profile, hashes, and provenance
health without dumping every chunk.

Upgrade and downgrade continue using verified immutable releases. Reinstalling
an already compiled version must not reparse, rechunk, or re-embed its source.

### Make authentication truthful

The built-in TypeScript registry login route remains a development fixture and
is not used by the product CLI. The Laravel Registry issues scoped, expiring,
revocable team tokens server-side and exposes authenticated identity and
self-revocation endpoints. ADR 0007 supersedes the original paste-in login:
`dkb registry login` now uses browser PKCE by default, while automation uses
`DKB_REGISTRY_TOKEN` or `--token-stdin`. Secret-bearing command arguments are
not supported.

More generally, planned command names are retained as honest nonzero stubs, and
renamed commands keep a working compatibility entry, until a separate product
decision explicitly abandons them. Cleanup alone is not grounds to remove
planned CLI surface.

### Separate implementation and protocol versions

The CLI release version and `DKB_PROTOCOL_VERSION` must evolve independently.

- `dkb --version` reports the installed CLI version.
- `dkb version` reports CLI, DKB protocol, runtime, compiler, and compatibility
  information when available.
- A stable `dkb.read.v1` protocol does not require labeling an unfinished CLI as
  package version 1.0.

### Ship a deliberate artifact

The npm package or binary distribution must be built from an allowlist. Include
only runtime build output, required schemas/compiler assets, README, license,
and other intentional user-facing files. Exclude tests, Graphify output,
workspace hooks, agent guidance, internal notes, caches, and unrelated source.

Add Windows and Linux CI for clean checkout, build, tests, package inspection,
installation, `dkb --version`, help, and the lifecycle acceptance test.

### Keep the refactor narrow

Split the CLI entrypoint by coherent command group and extract shared context and
option helpers. Keep domain behavior in existing registry, runtime, compiler,
retrieval, and MCP modules. Do not create a custom CLI framework or general
dependency-injection layer.

## Release Gate

A public developer preview may be prepared only after a clean environment can
complete:

```text
dkb init
dkb install <package> --version <version>
dkb list
dkb show <package>
dkb retrieve "<known question>"
dkb uninstall <package>
dkb retrieve "<same question>"   # evidence insufficient
dkb install <package> --version <version>
dkb serve                         # MCP sees the same installed state
```

The release gate also requires:

- identical current-folder behavior on Windows and Linux;
- explicit override tests for registry and runtime locations;
- no recompilation during verified reinstall;
- upgrade, downgrade, interrupted-install, and rollback coverage;
- real Laravel-registry authentication proof;
- remote MCP exposing only `search` and `fetch` and using the same state;
- a reviewed package file manifest with no credentials, private knowledge,
  personal data, agent work logs, or unintended generated files;
- clean type-check, full tests, package install smoke test, and dependency audit.

Do not publish the stable `latest` tag or call the implementation 1.0 merely
because the protocol contract is version 1.0. A clearly labeled `0.x` developer
preview is acceptable after this gate passes.

## Explicit Non-Goals

This decision does not add:

- agent chat or a retrieval dashboard;
- automatic package decay;
- agent-controlled package writes;
- a new retrieval engine;
- a new registry service;
- a CLI language rewrite;
- cosmetic progress or table redesign beyond demonstrated usability problems.

If the control-plane model changes, supersede this record rather than silently
editing its implemented history.
