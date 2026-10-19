# Design direction and architectural decisions

## Project authorship

**Sid Shovan created DKB and leads its product and architectural direction.**
The starting problem was personal: choose what knowledge an agent can access,
install and remove it cleanly, and understand where its answers came from.

The decisions below document Sid's product requirements, architectural choices,
and evaluation of implementation alternatives. Each connects a user need to an
engineering trade-off and a concrete system boundary.

## Decisions that shape DKB

| Decision led or selected by Sid | Reason | Architectural consequence |
| --- | --- | --- |
| Treat knowledge as installable packages | Agents need an explicit, manageable knowledge set rather than an ever-growing document folder | Namespaced DKB releases, install/uninstall operations, provenance and dependency state |
| Make Collections first-class dependency bundles | Related knowledge should publish and install together without duplicating package identity | Immutable Collection revisions pin exact releases; dependency ownership controls removal |
| Separate a local Library from a remote Registry | Local storage and remote distribution are different responsibilities | Libraries own installed state; Registries authenticate, sign and distribute releases |
| Keep source, evidence and retrieval builds separate | The same knowledge should support different processing and search choices | PackageVersion → Evidence Build → Retrieval Build, with independently identified outputs |
| Make multiple builds permanent infrastructure | Reuse knowledge across Pipelines without tying the product to one embedding service | Compatible evidence is reused; distinct retrieval spaces coexist |
| Bind the active Pipeline to the Runtime | Two agents should be able to search the same Library through different Pipelines | Runtime-owned activation, shared immutable builds, independent endpoints |
| Use replaceable provider contracts | Operators should choose implementations without rewriting DKB core | Typed SDK, filesystem-controlled plugins and explicit composition boundaries |
| Keep Registry compilation authoritative for published builds | A signed build needs a trusted, reproducible chain back to its source | Trusted Registry recipes and source/Evidence/Retrieval receipt verification |
| Use the CLI as the Console control plane | UI and automation should execute the same domain behavior | Typed allowlisted CLI operations, shared progress and error semantics |
| Keep agent retrieval read-only | Retrieved knowledge must not silently alter installed packages | MCP search/fetch; package mutation stays operator-controlled |
| Use one storage environment per live Library database | Windows and Linux must not make incompatible locking assumptions about one shared file | Native storage ownership and delegated Docker management |

These choices were made to solve knowledge lifecycle and agent-integration
problems, not to replace mature parsers, embedding engines or search databases.

## Engineering trade-offs

- **Portability versus compiled performance:** source and evidence remain portable;
  vectors and indexes require an exact compatible retrieval implementation.
- **Reuse versus isolation:** Runtimes share immutable bytes but not mutable
  activation, credentials or caches.
- **Extensibility versus trust:** plugins are trusted operator code; uploaded
  knowledge cannot install executable extensions.
- **Convenience versus authority:** host defaults assist selection, but package
  receipts, Library state and Runtime activation remain authoritative.
- **Safety versus silent recovery:** ambiguous state produces a specific error
  instead of a guessed fallback.

## Implementation approach

DKB combines TypeScript, a Vue Console, a Laravel Registry, and existing
document-processing and retrieval components. AI-assisted implementation is used
under human direction; generated changes follow the same review, contract,
testing and security requirements as other contributions.

Detailed rationale and superseding decisions are retained in the
[architecture decision records](decisions/README.md). The
[system map](architecture/system-map.md) describes the resulting component model.
