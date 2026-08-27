# CLI Guidance

This directory owns the global `dkb` command, human and JSON presentation,
host inventory, context selection, and service orchestration. The architecture
decision in
[`docs/decisions/0004-monorepo-release-units-and-local-stack.md`](../../docs/decisions/0004-monorepo-release-units-and-local-stack.md)
is authoritative.

- Keep domain behavior in its owning workspace; CLI handlers validate input,
  resolve context, invoke public APIs, and present results.
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

Verify with `npm run check --workspace @dkb/cli`, focused CLI tests, a dry-run
package inspection, and a global tarball smoke test from an unrelated folder.
