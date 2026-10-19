# Architecture decision records

These records preserve the decisions behind DKB: context, constraints, trade-offs
and consequences. **Accepted** identifies a design decision, not a release or
test certification. Superseding records identify changed boundaries.

For the current model, start with the [system map](../architecture/system-map.md).
For product direction and authorship, see [design decisions](../design-decisions.md).
Deployment limits belong in [supported configurations](../developer-preview.md).

## Index

- [0001 — CLI control plane and release criteria](0001-cli-control-plane-and-release-gate.md)
- [0002 — Libraries and Collections](0002-library-and-collections-hard-cutover.md)
- [0003 — Host inventory and context selection](0003-host-inventory-and-context-selection.md)
- [0004 — Monorepo release units and local Stack](0004-monorepo-release-units-and-local-stack.md) — Provider packaging superseded by 0006.
- [0005 — Evidence and Retrieval Build graph](0005-evidence-and-retrieval-build-graph.md) — Runtime ownership superseded by 0008.
- [0006 — Provider boundaries and immutable storage](0006-final-provider-architecture-and-storage-cutover.md)
- [0007 — Host Console, CLI control and authentication](0007-host-console-cli-control-and-authentication.md)
- [0008 — Registry catalog and signed source inventory](0008-registry-catalog-and-signed-source-inventory.md)
- [0008 — Runtime-bound Pipelines and shared Libraries](0008-runtime-bound-pipelines-and-shared-libraries.md)
- [0009 — Trusted Plugin SDK and Registry recipes](0009-trusted-plugin-sdk-and-registry-recipes.md)
- [0010 — Retire the remote query gateway and dormant write queue](0010-retire-remote-query-gateway-and-write-queue.md)
- [0011 — Worker-confirmed compilation cancellation](0011-worker-confirmed-compilation-cancellation.md)
- [0012 — Crash-safe Library mutations](0012-crash-safe-library-mutations.md) — Cross-OS ownership superseded by 0013.
- [0013 — One storage environment per Library](0013-library-storage-ownership.md)
