# 0010 - Retire The Remote Query Gateway And Dormant Write Queue

- **Status:** Accepted; implementation in current hardening milestone
- **Date:** 2026-09-02
- **Scope:** Runtime retrieval entry points, remote endpoint discovery, and inactive local write machinery
- **Supersedes:** the remote-query role assigned to `dkb remote` in 0003

## Decision

A DKB Runtime serves only its own validated activation. It does not attach
temporary sessions to other Runtimes, proxy another endpoint's results, or
translate an obsolete remote MCP tool into DKB retrieval output.

`dkb remote` remains a discovery and attestation catalog for hosted Runtime
endpoints. Querying a hosted Runtime uses that Runtime directly through the
ordinary host Runtime inventory and canonical `query`, `read-targets`, and
`read` operations, or through its read-only MCP `search` and `fetch` tools. The
destination Runtime therefore performs activation verification and persists
the authoritative audit event. Cross-Runtime aggregation remains deferred.

The inactive CLI write queue is removed. It had no registered product command,
was not part of the Runtime activation or audit model, and made health output
claim a lifecycle the product did not expose. Local source editing remains an
operator action outside Runtime retrieval. Remote MCP remains read-only. A
future queued-intent write product requires a new decision and complete trust,
transaction, provenance, and user-confirmation model.

## Consequences

- Runtime HTTP no longer exposes `/api/remote/*` session or proxy routes.
- The Runtime client no longer exposes remote attach, session, detach, or proxy
  retrieval methods.
- The stable remote MCP surface is exactly `search` and `fetch`; the retired
  `dkb.retrieve_knowledge` name is not an advertised protocol capability.
- Endpoint discovery, Registry verification, and signed endpoint attestations
  may remain because they identify where a Runtime is hosted; they do not create
  a second retrieval engine.
- Health reports cover real manifest, source, build, verification, and space
  state only.

## Verification

- Package-boundary checks reject reintroduction of a public remote proxy.
- Runtime and CLI contract tests prove no remote session routes or commands are
  registered.
- Queries to a registered remote Runtime use the destination Runtime's normal
  audited HTTP operation.
- Remote MCP continues to expose only `search` and `fetch`.
