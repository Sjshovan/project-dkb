# FastEmbed Provider Guidance

This package owns the `@dkb/embedding-fastembed` document/query embedding plugin and its local service lifecycle. It implements Pipeline contracts and may depend only on Protocol, Pipeline, and Node APIs.

Keep document/query transforms, batching, model/dimension validation, health, cancellation, and service process details here. Never import another provider, compiler, Runtime, Library, Registry, or CLI module. Secrets are referenced through environment names and never written to build receipts.

Verify with `npm run check --workspace @sjshovan/dkb-embedding-fastembed` and the embedding provider tests. See [the canonical architecture](../../docs/architecture/final-provider-architecture.md).
