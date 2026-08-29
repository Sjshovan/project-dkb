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
- [0006 - Final provider architecture and storage cutover](0006-final-provider-architecture-and-storage-cutover.md) — Accepted direction; implementation in progress.
