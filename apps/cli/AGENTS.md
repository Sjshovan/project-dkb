# CLI Guidance

This directory owns the global `dkb` command, human and JSON presentation,
host inventory, context selection, and service orchestration. The canonical
[provider architecture](../../docs/architecture/final-provider-architecture.md)
and [ADR 0006](../../docs/decisions/0006-final-provider-architecture-and-storage-cutover.md)
are authoritative.

- Keep domain behavior in its owning workspace; CLI handlers validate input,
  resolve context, invoke public APIs, and present results.
- Root help must classify every visible command. An unclassified command belongs
  in `Other Commands` until its deliberate group is added; tests should keep
  that fallback empty for the release surface.
- Treat implemented and explicitly planned command names as product contracts.
  Planned commands use `commandLifecycle.ts` and fail honestly; do not delete or
  silently hide one without an architecture decision and matching tests/docs.
- Package lifecycle orchestration belongs in `packageCommands.ts` under the CLI command layer;
  installed-package inspection belongs to `@sjshovan/dkb-library`.
- Human output is concise, colored in a TTY, and progress-visible by default.
  `--json` emits one ANSI-free document; `--no-progress` changes animation only.
- Resolve Library and Runtime context through host inventory precedence. Never
  scan disks or networks implicitly.
- Errors name the failed service or resource and include a concrete recovery
  command when one is safe.
- Do not import workspace source through relative paths. Use package exports.
- The npm tarball is allowlisted and must never include tests, fixtures,
  credentials, generated indexes, personal knowledge, or internal notes.
- Keep CLI version separate from protocol, Runtime, compiler, provider, and
  retrieval compatibility versions.

Verify with `npm run check --workspace @sjshovan/dkb-cli`, focused CLI tests, a dry-run
package inspection, and a global tarball smoke test from an unrelated folder.
