# Library Guidance

These rules extend the repository-level `AGENTS.md` for `src/library/`.

## Sources Of Truth

- `docs/library-and-collections.md` defines the user-facing layout and lifecycle.
- `dkb.json` is desired roots, `dkb-lock.json` is exact resolution, and
  `.dkb/state.sqlite` is applied state.
- `src/protocol/manifest.ts` owns manifest loading and direct-child discovery.
  Do not add a second recursive scanner here.

## Invariants

- A Library has `type: library`; DKBs and Collections use canonical
  `@namespace/name` identities.
- Editable entries are direct child folders. Registry-managed entries live only
  at `vendor/@namespace/name`.
- One DKB identity resolves to one exact version and digest per Library.
- The same exact DKB may be shared by many roots or Collections. Preserve every
  `requiredBy` edge and prune only when none remain.
- A Collection contains dependency references, not copied DKB contents.
- Filesystem presence is not installed state. Status comes from manifest, lock,
  ledger, and content validation together.

## Mutation Safety

- Resolve and validate the complete next state before mutating live files.
- Stage Registry downloads outside their final vendor paths.
- Promote manifest, lock, ledger, installed paths, aggregate catalog, and query
  snapshot as one recoverable operation.
- On failure, remove newly promoted targets and restore previous targets,
  retrieval profile, aggregate artifacts, manifest, lock, and ledger byte for
  byte. A leftover `untracked` package is a rollback failure.
- Activating precompiled packages refreshes aggregate integrity metadata from
  their installed artifacts; it must not parse, chunk, embed, or ask the
  Registry compiler to rebuild them.
- Local-source deactivation never deletes author files. Registry uninstall may
  delete only vendor content whose ownership count reached zero.

## Verification

Cover exact-version sharing, conflicting versions, inactive/untracked/broken
status, rollback on profile mismatch, Collection update, selective pruning,
and reinstall from compiled releases without recompilation.
