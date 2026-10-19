# DKB Decision Records

Decision records preserve accepted architectural and product directions that
may not be fully implemented yet. They complement behavior documentation; they
do not override current source or test evidence.

Statuses:

- **Proposed**: under discussion.
- **Accepted direction; implementation pending**: agreed target with unfinished work.
- **Implemented**: acceptance gate passed in the current release.
- **Superseded**: replaced by a later numbered decision.

## Index

- [0001 - CLI control plane and public-release gate](0001-cli-control-plane-and-release-gate.md) — Command/control surface implemented; public-release verification pending.
- [0002 - Library and Collections hard cutover](0002-library-and-collections-hard-cutover.md) — Implemented.
- [0003 - Host inventory and context selection](0003-host-inventory-and-context-selection.md) — Implemented.
- [0004 - Monorepo release units and local stack](0004-monorepo-release-units-and-local-stack.md) — Provider/composition details superseded by 0006; release-unit decisions retained.
- [0005 - Evidence and Retrieval Build graph](0005-evidence-and-retrieval-build-graph.md) — Build graph retained; active-artifact details superseded by 0006.
- [0006 - Final provider architecture and storage cutover](0006-final-provider-architecture-and-storage-cutover.md) — Implemented.
- [0007 - Host Console, CLI control, and authentication](0007-host-console-cli-control-and-authentication.md) — Implemented for the developer preview.
- [0008 - Registry catalog and signed source inventory](0008-registry-catalog-and-signed-source-inventory.md) — Implemented for the developer preview.
- [0008 - Runtime-bound Pipelines and shared Libraries](0008-runtime-bound-pipelines-and-shared-libraries.md) — Implemented for the developer preview.
- [0009 - Trusted Plugin SDK and Registry recipes](0009-trusted-plugin-sdk-and-registry-recipes.md) — Accepted; current hardening milestone.
- [0010 - Retire the remote query gateway and dormant write queue](0010-retire-remote-query-gateway-and-write-queue.md) — Accepted; implementation in the current hardening milestone.
- [0011 - Worker-confirmed compilation cancellation](0011-worker-confirmed-compilation-cancellation.md) — Accepted; real worker and recovery verification required.
- [0012 - Crash-safe Library mutations](0012-crash-safe-library-mutations.md) — Accepted; durable Library recovery checkpoint.
- [0013 - One storage environment per Library](0013-library-storage-ownership.md) — Accepted; Docker-owned Linux storage and delegated management gate.
