# Provider subsystem guidance

These rules extend the repository-level `AGENTS.md` for `src/providers/`.

- Keep `types.ts` as the implementation-neutral contract. Do not import a
  concrete compiler, embedding model, FAISS, or Meilisearch type into it.
- Keep plugin resolution local to each `DkbProviderHost`: context-local,
  current-user global, then bundled. Never cache a provider module or instance
  across hosts. A broken higher-precedence plugin must fail closed.
- A plugin is only `plugin.mjs` exporting `id`, `version`, and
  `setup(context)`. Do not add package manifests or network plugin discovery.
- Load only IDs selected by the resolved target. Provider options belong to the
  provider; reject inline secrets and record configuration/code digests without
  recording environment values.
- Compilation must flow through `compileDkbWithProviderHost`. Keep fused
  ingestion and parser/chunker paths behaviorally equivalent and preserve
  ordered processor receipts. `records.ts` is the canonical normalization
  boundary; index and Evidence IR code must consume final pipeline records,
  never a provider's optional native result.
- Runtime index lifecycle belongs behind `DkbIndexProvider`. Managed providers
  prepare before Library activation, verify after activation, roll back newly
  created state on failure, and report cleanup orphans after logical uninstall.
- Packages may contain derived provider artifacts but never plugin code or
  `.dkb/config.json`. Preserve the archive and copy filters when adding paths.
- Compatibility is distinct from build provenance. Change compatibility only
  for embedding space, dimensions, metric, normalization, index format, or
  retrieval protocol changes.
- Add contract tests for precedence, selected-only loading, local failure,
  source/config drift, processor ordering, disposal, and activation rollback.
  Add a real lifecycle proof for every bundled managed index provider.
