# Default Distribution Guidance

This package is DKB's only built-in composition root. It owns the bundled
target catalog, selected plugin modules, and target service requirements.

- Depend on Pipeline contracts and concrete provider packages.
- Keep compilation, retrieval, Library state, CLI presentation, and service
  orchestration out of this package.
- Concrete provider IDs and default model/image choices belong here, not in
  Protocol, Pipeline, Library, compiler core, or Runtime core.
- A target recipe is configuration; it never grants package content authority
  to load plugins or credentials.

Verify with the workspace boundary check and provider-host tests.
The authoritative boundary map is
[`docs/architecture/final-provider-architecture.md`](../../docs/architecture/final-provider-architecture.md).
