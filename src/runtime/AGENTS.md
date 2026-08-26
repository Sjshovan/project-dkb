# Runtime Guidance

These rules extend the repository-level `AGENTS.md` for `src/runtime/`.

## Installed State

- One Runtime serves one Library. Runtime code must not attach a second Library
  or maintain an independent package selection beside the Library lock.
- Installed package source and compiled artifacts are versioned snapshots. A
  later source edit does not change an installed release until a new compile,
  publication, and install occurs.
- Runtime install consumes verified compiled artifacts. It must not parse,
  chunk, embed, or silently repair source during normal installation.
- Promote packages and aggregate snapshots atomically. Queries must observe the
  previous ready state or the next complete state, never a partial activation.
- Uninstall removes only the selected installed package and derived aggregate
  state. It must not mutate author source, shared Collection dependencies, or
  unrelated packages.
- Invalidate and rebuild the runtime query snapshot after install, uninstall,
  compile, or other active-package changes.

## Retrieval

- Package-local SQLite catalogs own compiled evidence text and provenance;
  FAISS owns vector search acceleration only.
- All active packages must match the Library retrieval profile before entering
  the live snapshot.
- Retrieval reads installed compiled artifacts and returns bounded evidence with
  stable identities. It does not reread source adapters during normal queries.
- Keep local runtime state and HTTP process control separate in the API even
  when the CLI later presents one coherent workspace workflow.

## Verification

Cover atomic promotion and rollback, profile mismatch rejection, concurrent
install preflight, snapshot invalidation, package-local uninstall, no-result
retrieval after uninstall, and reinstall without recompilation.
