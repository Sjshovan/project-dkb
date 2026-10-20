# Compiler Service Guidance

## Ownership

Own compilation, staging, Evidence IR, and the compiler HTTP service.

Follow the [provider architecture](../../docs/architecture/final-provider-architecture.md)
and [ADR 0006](../../docs/decisions/0006-final-provider-architecture-and-storage-cutover.md).

## Dependency direction

- Depend on Protocol, Library, Pipeline contracts, Registry transport, and injected distribution.
- Local and HTTP compilation must call the same job runner.
- Resolve recipes and execute each job with one provider host; check drift before promotion and dispose on every exit.
- Keep provider-specific work behind `@sjshovan/dkb-pipeline` contracts.

## Invariants

- Compile isolated staged source; never mutate or move caller knowledge.
- Strip uploaded plugins, operator configuration, caches, vendor content, and generated state.
- Finish text mutations before Evidence IR; derive retrieval from that exact Evidence Build.
- Preserve stable source anchors and enforce exact Evidence/Retrieval parent digests.
- Validate all artifacts before atomic promotion; rollback leaves the previous complete build intact.
- Enforce cancellation, timeouts, target compatibility, and trusted context-root containment.
- Hold native compile ownership through worker cleanup; never infer ownership
  from PID or age. Preserve old guards for matching-version recovery
  ([ADR 0013](../../docs/decisions/0013-library-storage-ownership.md)).
- Pending worker records survive aborts, expiry, and restart. Confirm the exact
  worker stopped before cleanup; never mask uncertainty with a disposal error.
- Stage service-visible jobs beneath the absolute `DKB_COMPILER_WORK_ROOT`; every selected provider must see that same root.

## Prohibited coupling

- Do not import CLI presentation, Runtime HTTP/MCP, host inventory, or Laravel internals.
- Do not select providers with model-specific environment branches in the runner.
- Do not mount or invoke the Docker socket from the HTTP service.
- Authenticate capabilities, work, and cancellation. Keep health minimal; never expose credentials.

## Verification

- `npm run check --workspace @sjshovan/dkb-compiler`
- `npm run build --workspace @sjshovan/dkb-compiler`
- `node --test tests/profiles-evidence.test.mjs tests/provider-host.test.mjs`
- `npm run proof:pipeline`
