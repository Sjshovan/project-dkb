# Runtime Guidance

This directory owns installed-state activation, retrieval, evidence resolution,
tracing, Runtime HTTP, and MCP. The architecture decision in
[`docs/decisions/0004-monorepo-release-units-and-local-stack.md`](../../docs/decisions/0004-monorepo-release-units-and-local-stack.md)
and [`docs/decisions/0005-evidence-and-retrieval-build-graph.md`](../../docs/decisions/0005-evidence-and-retrieval-build-graph.md)
are authoritative.

- Depend only on protocol, Library, pipeline contracts, Registry client, and
  provider implementations supplied at the composition boundary.
- One Runtime serves one Library. It must not keep a second package selection.
- Accept only verified compiled artifacts. Never parse, chunk, embed, or import
  compiler internals here.
- Promote packages and retrieval snapshots atomically. Queries see either the
  previous ready state or the next complete state.
- Resolve exact signed Evidence/Retrieval chains. Never choose a newest or
  partial match, and never mix compatibility spaces in one snapshot.
- Preserve stable evidence identities, bounded untrusted-source output,
  provenance, citations, and trace metadata.
- Every MCP transport exposes exactly `search` and `fetch`; both are read-only.
- Never expose install, uninstall, compilation, plugin, or write-queue controls
  over remote MCP.
- Keep credentials out of Runtime state, discovery documents, traces, and
  package artifacts.

Verify with `npm run check --workspace @dkb/runtime`, focused Runtime/MCP tests,
and the install-query-uninstall-reinstall lifecycle proof.
