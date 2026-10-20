# Runtime Guidance

Own activation, retrieval, evidence, Runtime HTTP and MCP. The canonical
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
- `runtime/mutation.ts` owns native shared-query/exclusive-mutation leases on
  verified local state storage. Never reclaim ownership by PID or age, delete
  prior-protocol guards, or upgrade a query's read authority. Docker state uses
  Linux-local volumes independently of the Library; see
  [ADR 0013](../../docs/decisions/0013-library-storage-ownership.md).
- Resolve exact signed Evidence/Retrieval chains. Never choose a newest or
  partial match, and never mix compatibility spaces in one snapshot.
- Preserve stable evidence identities, bounded untrusted-source output,
  provenance, citations, and trace metadata.
- HTTP MCP stays read-only. Local discovery/create/append follow
  [ADR 0015](../../docs/decisions/0015-targeted-source-writes.md): Library transactions,
  CLI compiler injection, clean text and revision-aware provenance.
- Never expose install, uninstall, compilation, plugin, or write-queue controls
  over remote MCP.
- Keep credentials out of Runtime state, discovery documents, traces, and
  package artifacts.
- Ordinary HTTP requires admin/read authentication independently of MCP; public
  reads and citation documents are separate opt-ins. Reject unknown routes and
  unapproved Host/Origin headers before dispatch. See [security](../../docs/security.md).

Verify with `npm run check --workspace @sjshovan/dkb-runtime`, focused Runtime/MCP tests,
and the install-query-uninstall-reinstall lifecycle proof.
