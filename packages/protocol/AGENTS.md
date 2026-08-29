# Protocol Guidance

This package owns DKB's stable manifests, identities, schemas, canonical JSON,
Evidence IR, validation, source-safety rules, and read-protocol constants. The
[canonical architecture](../../docs/architecture/final-provider-architecture.md)
and [ADR 0006](../../docs/decisions/0006-final-provider-architecture-and-storage-cutover.md)
govern its public surface.

- Keep this package independent of the CLI, Library, pipeline, providers,
  compiler, Runtime, and Registry client.
- Define portable structural inputs at this boundary. Never import a concrete
  parser, embedding, index, compiler-result, or service type.
- Preserve stable evidence IDs, source locators, canonical JSON, manifest
  validation, and existing wire formats unless an accepted decision explicitly
  versions them.
- Treat source and Evidence IR as canonical portable data. Vectors, indexes,
  runtime catalogs, and service health are outside this package.
- Keep untrusted source content inert; validation and rendering contracts must
  never interpret retrieved text as an instruction.
- Export public modules through `package.json`; consumers must use
  `@sjshovan/dkb-protocol` imports instead of reaching into this package by relative path.

Run `npm.cmd run check --workspace @sjshovan/dkb-protocol` and the protocol, profile, and
MCP security tests after contract changes.
