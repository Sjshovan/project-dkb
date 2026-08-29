# Cross-Package Test Guidance

This directory owns contract, security, packaging, CLI, and full-lifecycle
proofs across workspaces. The architecture decision in
[`docs/decisions/0004-monorepo-release-units-and-local-stack.md`](../docs/decisions/0004-monorepo-release-units-and-local-stack.md)
defines the required release gate.

- Test public workspace exports and executable behavior, not private source
  paths.
- Create temporary roots through the shared test helper and register cleanup
  immediately. Never write to the real host inventory.
- Keep synthetic security knowledge non-sensitive and assert that hostile
  instructions never reach model answers.
- Lifecycle tests must prove evidence appearance, disappearance on uninstall,
  and reinstall without recompilation.
- Network and service tests use disposable ports, bounded timeouts, and explicit
  teardown. An offline inventory probe is reportable state, not test failure.
- Fixtures may emulate the removed Node Registry, but product code must not
  import test fixtures.

Run a focused file with
`node --import ./tests/test-environment.mjs --test tests/<name>.test.mjs`, then
`npm test` and `npm run temp:audit` before a milestone commit.
