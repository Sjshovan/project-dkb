# Contributing

DKB is currently developed on the private `development` branch. Public
contribution instructions will be finalized only when the repository is made
public intentionally.

Before proposing a change, read the nearest `AGENTS.md` and the
[workspace dependency graph](docs/architecture/workspace-dependency-graph.md).
Keep protocol, Library, pipeline, provider, compiler, Runtime, Registry client,
and CLI ownership boundaries intact. Do not add cross-workspace relative
imports or let knowledge packages supply executable plugins.

Run the release-quality local gate:

```powershell
npm run graph:check
npm run boundaries:check
npm run agents:check
npm run docs:check
npm run check
npm test
npm run package:check
npm run temp:audit
```

Never commit credentials, private corpora, generated indexes, `.dkbpkg` files,
stack state, local MCP configuration, Graphify output, or internal task notes.
Use a Changeset for user-visible package behavior, but do not publish or make a
release public without explicit project-owner approval.
