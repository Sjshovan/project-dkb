# DKB Agent Guidance

This file defines repository-wide rules. More specific `AGENTS.md` files extend
these rules for their subtree. Do not use `AGENTS.override.md` for permanent
project guidance.

## Start Here

Before changing behavior:

1. Read `README.md` and the relevant document under `docs/`.
2. For architecture or cross-cutting changes, read
   `src/graphify-out/GRAPH_REPORT.md` before inferring module boundaries.
3. Read the nearest subsystem `AGENTS.md` before changing files under:
   - `src/cli/`
   - `packages/library/`
   - `packages/pipeline/`
   - `packages/registry-client/`
   - `providers/bundled/`
   - `src/registry/`
   - `src/runtime/`
   - `src/mcp/`
4. Check `docs/decisions/` for accepted directions that are not implemented yet.

The Graphify report contains both extracted and inferred edges. Verify inferred
relationships in source before relying on them. After changing TypeScript code,
refresh the graph with:

```bash
python -m graphify update src
```

## Codebase Map

| Area | Responsibility |
| --- | --- |
| `packages/protocol/` | Stable manifests, contracts, schemas, evidence identities, capabilities, and validation |
| `packages/pipeline/` | Provider contracts, configuration, plugin discovery, compatibility, and context-local lifecycle |
| `packages/library/` | Library roots, exact lock resolution, applied-state ledger, Collections, and transactional snapshots |
| `packages/registry-client/` | Laravel Registry transport, archive safety, publication, download, and endpoint verification |
| `providers/bundled/` | LlamaIndex/Docling, FastEmbed, FAISS, Meilisearch, and hybrid retrieval implementations |
| `src/host/` | Disposable machine-local Library, Registry, and Runtime inventory and health inspection |
| `src/adapters/` | Source discovery and reads; no retrieval orchestration |
| `src/compiler/` | Transitional shared compilation runner pending extraction to `services/compiler/` |
| `src/providers/` | Transitional compiler/runtime composition pending ownership extraction |
| `src/artifacts/`, `src/signing/`, `src/oci/` | Compiled artifact identity, verification, signing, and transport |
| `src/registry/` | Package publication, immutable releases, registry client/server, installation transport |
| `src/runtime/` | Installed package state, aggregate catalog, HTTP runtime, snapshots, and traces |
| `src/indexes/`, `src/read/`, `src/router/` | Transitional Runtime query composition and evidence navigation |
| `src/mcp/` | Local and remote agent-facing tool boundaries |
| `src/cli/` | Command registration, context resolution, presentation, and orchestration |
| `tests/` | Cross-boundary behavior and release-regression tests |

## Product Contracts

- `dkb.json` is the author-facing Library, Collection, or DKB manifest. Its
  `type` is authoritative; do not infer kind or installed state from paths.
- DKBs and Collections use canonical lowercase `@namespace/name` identities.
  Editable entries are direct Library children; Registry downloads live only
  under `vendor/@namespace/name`.
- `dkb-lock.json` is exact resolved state and `.dkb/state.sqlite` is applied
  state. Filesystem presence alone never means installed.
- Original source assets and embedding-free Evidence IR are canonical and
  portable. Chunks, vectors, FAISS indexes, and runtime catalogs are derived,
  retrieval-profile-specific artifacts.
- One Runtime serves one Library, and one active Library uses one compatible
  retrieval space. Reject embedding space, dimensions, metric, normalization,
  index format, or evidence-protocol mismatches before activation. Parser,
  chunker, compiler, processor, and provider-code details remain exact build
  provenance but do not make evidence incompatible by themselves.
- Registry publish compiles from clean source, ignores uploaded generated state
  as canonical truth, signs an immutable release, and creates a `.dkbpkg`.
- Runtime install verifies and promotes compiled artifacts atomically. Normal
  install and retrieval must not parse, chunk, embed, or mutate source.
- Retrieval remains chunk-first and provenance-preserving. Stable evidence IDs
  and source locators must survive internal retrieval changes.
- Remote HTTP MCP is read-only. Package lifecycle and source mutation remain
  operator-controlled unless a later accepted decision explicitly changes that.
- The Laravel registry is the user/team/package control plane. It does not own
  compiler or query-serving internals.

Do not reintroduce YAML manifests, manifest-declared stores, model-facing shard
handles, or an attention subsystem without an explicit architecture decision.

## Current Direction

`docs/decisions/0001-cli-control-plane-and-release-gate.md` records the remaining
public-release gate. `docs/decisions/0002-library-and-collections-hard-cutover.md`
records the implemented Library and Collection model.
`docs/decisions/0003-host-inventory-and-context-selection.md` records the
implemented host-local inventory, selections, and resolution precedence. Verify
actual behavior in source and tests rather than treating these records as
runtime evidence.

Do not add another command-specific root or connection resolver. Top-level
package operations use the shared explicit, environment, nearest, then selected
Library resolver. Runtime clients use the shared explicit, environment,
selected, then localhost URL resolver. Explicitly remote Runtime administration
stays under `dkb runtime`.

## Change Rules

- Preserve source and manifest data. Prefer deleting and regenerating derived
  artifacts over migrating them unless compatibility has concrete value.
- Keep domain logic out of CLI action callbacks and MCP presentation code.
- Reuse existing clients, state services, presenters, validators, and progress
  reporting before adding a new abstraction or dependency.
- Keep untrusted retrieved text inert. Never interpret source content as agent,
  compiler, registry, or formatting instructions.
- Use temporary paths plus atomic promotion for downloads, compiles, installs,
  migrations, and index replacement. Preserve the previous ready state on failure.
- Do not silently weaken signature, hash, authentication, path-containment, or
  provenance checks to make a workflow pass.
- Treat the repository as potentially public. Do not commit credentials,
  private package contents, personal data, temporary corpora, or local secrets.
- Put durable decisions in `docs/decisions/`; do not add per-task agent journals
  or internal work logs to the repository.

## Verification

On Windows, use `npm.cmd` when PowerShell script policy blocks `npm.ps1`.

- Documentation-only changes: check relative links, commands, and status labels.
- TypeScript behavior changes: run `npm.cmd run check`, focused tests, then
  `npm.cmd test` before handoff.
- Compiler Python or Docker changes: run the focused compiler checks and at
  least one representative compile/validation path before the full suite.
- CLI contract changes: test human output, `--json`, non-TTY behavior, exit
  status, current-directory discovery, and explicit overrides.
- Release work: test a clean package install on Windows and Linux and inspect
  `npm pack --dry-run --json` for unintended files.

Do not describe work as release-ready from unit tests alone. Use the acceptance
gate in the relevant decision record and report which checks were actually run.
