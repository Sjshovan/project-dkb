# @sjshovan/dkb-compiler

The shared DKB compilation job runner and Registry-facing HTTP compiler service.

Local CLI compilation and remote Registry compilation call the same exported runner with different trusted context roots. Concrete ingestion, embedding, and index behavior is resolved through `@sjshovan/dkb-pipeline` and registered by `@sjshovan/dkb-providers-bundled`.

See [ADR 0004](../../docs/decisions/0004-monorepo-release-units-and-local-stack.md).
