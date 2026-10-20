# Contributing to DKB

Start with the [system architecture](docs/architecture/system-map.md) and
[design decisions](docs/design-decisions.md). For substantial behavior changes,
describe the problem, the affected contract and the trade-offs before implementation.

## Development

Use Node.js 22.15 or later and install dependencies with `npm ci`.
Read the nearest `AGENTS.md` for subsystem ownership and verification rules.
The same rules apply to human-authored and AI-assisted changes.

Keep domain behavior in its owning workspace. Cross-workspace imports use public
package exports. Knowledge packages must not contain executable plugins or
operator configuration.

## Verification

Run focused tests for the changed behavior, then the applicable checks:

```sh
npm run graph:check
npm run boundaries:check
npm run agents:check
npm run docs:check
npm run check
npm test
npm run package:check
npm run temp:audit
```

Service-backed changes also need their relevant Docker integration tests.
Use isolated synthetic fixtures and clean up only resources owned by the test.
Report skipped integration checks in the pull request, not as successful tests.

## Pull requests

Explain what changes, why it is needed, and how it was tested. Add a Changeset
for user-visible package changes. Update authoritative documentation when a
contract changes; avoid duplicate design descriptions.

Do not commit credentials, personal corpora, generated indexes, local MCP/editor
configuration, session transcripts, task journals, or environment-specific output.
Keep task status and investigation logs outside the repository. Documentation
should explain usage, architecture, trade-offs and supported behavior.

## Security and releases

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Never include live tokens, private knowledge or exploit-bearing archives in issues.

Release artifacts and repository visibility are maintainer-controlled.
A normal contribution does not authorize publishing packages or changing access.

## Source hygiene

Run `node scripts/check-public-source.mjs` before submitting a source release.
It rejects local tool settings, generated knowledge, credential files and private
machine/conversation references. Focused `AGENTS.md` files are contributor
guidance and remain part of the source tree.

CI also scans the committed snapshot with checksum-pinned Gitleaks. This is
pattern detection, not proof that arbitrary data is safe to disclose. Before
making an existing repository public, audit all reachable Git history as well:
removing a file from the current tree does not remove earlier revisions.
