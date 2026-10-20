# TEI Provider Guidance

This package owns the `@dkb/embedding-tei` document/query embedding plugin and its pinned TEI service lifecycle. It implements Pipeline contracts and may depend only on Protocol, Pipeline, and Node APIs.

Keep TEI transport, transforms, batching, model revision and dimension checks, image pinning, health, cancellation, and service lifecycle here. Never import another provider or DKB domain/service package. Secrets remain environment references and never enter receipts.

Verify with `npm run check --workspace @sjshovan/dkb-embedding-tei` and the TEI provider tests. See [the canonical architecture](../../docs/architecture/final-provider-architecture.md).
