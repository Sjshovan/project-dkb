# Runtime Guidance

This directory owns installed-state activation, retrieval, evidence resolution,
tracing, Runtime HTTP, and MCP. The canonical
[provider architecture](../../docs/architecture/final-provider-architecture.md)
and [ADR 0008](../../docs/decisions/0008-runtime-bound-pipelines-and-shared-libraries.md)
are authoritative.

- Depend only on protocol, Library, pipeline contracts, Registry client, and
  provider implementations supplied at the composition boundary.
- One Runtime serves one Library and owns one independent Pipeline activation.
  Multiple Runtimes may share the same Library and immutable build bytes.
- Keep binding, activation, caches, traces, and audit data under
  the Runtime state root. Never write active Pipeline state into the Library.
- Accept only verified compiled artifacts. Never parse, chunk, embed, or import
  compiler internals here.
- Promote Runtime activations atomically. Library mutation is authoritative;
  stale Runtimes fail closed until refreshed and cannot serve removed evidence.
- Resolve exact signed Evidence/Retrieval chains. Never choose a newest or
  partial match, and never mix compatibility spaces in one snapshot.
- Preserve stable evidence identities, bounded untrusted-source output,
  provenance, citations, and trace metadata.
- Every MCP transport exposes exactly `search` and `fetch`; both are read-only.
- Never expose install, uninstall, compilation, plugin, or write-queue controls
  over remote MCP.
- Keep credentials out of Runtime state, discovery documents, traces, and
  package artifacts.
- Ordinary HTTP requires admin/read authentication independently of MCP; public
  reads and citation documents are separate opt-ins. Reject unknown routes and
  unapproved Host/Origin headers before dispatch. See [security](../../docs/security.md).

Verify with `npm run check --workspace @sjshovan/dkb-runtime`, focused Runtime/MCP tests,
and the install-query-uninstall-reinstall lifecycle proof.
