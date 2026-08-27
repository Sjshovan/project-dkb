# CLI Guidance

These rules extend the repository-level `AGENTS.md` for `src/cli/`.

## Sources Of Truth

- `docs/cli-ux.md` describes the implemented presentation contract.
- `docs/decisions/0001-cli-control-plane-and-release-gate.md` describes the
  accepted next command model and unresolved release blockers.
- `docs/decisions/0003-host-inventory-and-context-selection.md` describes the
  implemented host catalog and selection precedence.
- Actual command behavior remains authoritative until that decision is fully
  implemented and its acceptance gate passes.

## Command Design

- Keep the root help focused on ordinary package and knowledge workflows.
  Specialized compiler, runtime, registry, MCP, OCI, and diagnostic operations
  belong in named command groups.
- Resolve the current Library, upstream Registry URL, credentials,
  and explicit overrides through shared context helpers. Do not duplicate
  precedence logic inside action callbacks.
- Library-bound commands use `resolveCliLibraryRoot`; Runtime clients use
  `resolveCliRuntimeUrl`. Inventory list commands are the only exception because
  they must work without resolving a selected resource first.
- Top-level package commands should form one coherent lifecycle from the current
  Library. Explicit HTTP Runtime administration should remain visibly
  distinct under `dkb runtime` or an equally clear boundary.
- Keep command actions thin: parse and validate input, call a domain service,
  and present its result. Filesystem, registry, compiler, and retrieval logic
  belong in their owning modules.
- Reuse option builders and resolvers for repeated `--url`, `--root`,
  `--library`, credential, confirmation, and output options.

## Output Contract

- Human-readable output is the default. `--json` emits one structured document
  on stdout for ordinary commands, including structured errors.
- Progress, warnings, and human errors go to stderr. Do not contaminate JSON
  stdout with banners, warnings, or experimental runtime notices.
- `--no-progress` disables animation but remains human-readable; it is not an
  automation format.
- Use determinate progress only when a real total exists. Never invent a
  percentage or ETA for compiler, Docker, verification, or activation phases.
- Respect TTY detection and `NO_COLOR`. Keep tables compact and useful when
  empty, redirected, or displayed in narrow terminals.
- Mutations should identify real phases and end clearly. Read-only commands
  should print their result without ceremonial success output.
- Preserve conventional `--help`, `--version`, cancellation, authentication,
  and failure exit behavior once implemented.

## Safety And Tests

- Perform lightweight preflight before downloads or destructive replacement.
- Failed staging cleanup after a successful operation is a warning with an
  actionable path, not a false operation failure.
- Test Library discovery and explicit overrides independently; a test that
  passes only with `--library` does not prove the nearest-Library workflow.
- Every CLI test that can initialize, register, or opportunistically discover a
  Library must set an isolated `DKB_HOST_INVENTORY`. Tests must never write the
  developer's real `~/.dkb/host.json`.
- Any common-command change needs coverage for human output, `--json`, exit
  status, and the complete `init -> install -> list -> retrieve -> uninstall`
  lifecycle where applicable.
- Refactor command registration by coherent command group. Do not introduce a
  general-purpose CLI framework or dependency-injection container for this split.
