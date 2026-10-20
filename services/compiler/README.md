# @sjshovan/dkb-compiler

The shared DKB compilation job runner and Registry-facing HTTP compiler service.

Local CLI compilation and remote Registry compilation call the same exported runner with different trusted context roots. Domain modules depend only on `@sjshovan/dkb-pipeline` contracts. The compiler bootstrap receives the selected `DkbDistribution`, which supplies target recipes and independently packaged provider plugins.

See the [canonical architecture map](../../docs/architecture/final-provider-architecture.md) and [ADR 0006](../../docs/decisions/0006-final-provider-architecture-and-storage-cutover.md).
