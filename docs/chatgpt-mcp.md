# ChatGPT MCP Boundary

DKB uses Runtime-owned MCP tools. Local stdio additionally supports permission-gated source append; HTTP remains read-only.

## Local MCP

`dkb mcp serve` uses stdio and exposes `search`, `fetch`, and `append`.
Bind it to an existing initialized local Runtime with `DKB_RUNTIME_STATE_ROOT`.
The tool is listed even when a package disallows writes, so callers receive a
structured permission error rather than treating a missing tool as a denial.

`append` accepts:

```json
{
  "dkbId": "@team/memory",
  "requestId": "fact-001",
  "text": "The support desk opens at 09:00.",
  "evidenceRefs": ["caller-known-source-reference"],
  "confirmed": true
}
```

The installed local package must explicitly declare `permissions.write: true`
and `write: { "mode": "direct", "operations": ["append"],
"confirmationRequired": true }` when per-write confirmation is required.
Ask the user before asserting `confirmed: true`. MCP cannot change permissions.
Registry packages, paths, update/delete operations and arbitrary files are not
accepted.

Text is stored exactly in a new `append-<requestId>.md` asset. Request IDs accept
1–80 letters, digits, underscores or hyphens; text is limited to 64 KiB.
The existing trusted Pipeline compiles the target package synchronously, and
the tool commits source/builds transactionally, refreshes the exact activation
and returns native fetched evidence. Existing source records and package version
are preserved. `search` and `fetch` can immediately retrieve a successful append.

Reuse the identical request ID, text and references after an uncertain response.
Different input under the same ID returns `append_request_conflict`.
`committed_refresh_required` means source was saved but retrieval needs recovery;
restore the Pipeline service and retry that same request. `recovery_required`
with `committed: null` requires Library recovery before another write. Never
retry under a new ID to conceal an unresolved outcome.

Source/chunk/build provenance remains structured pipeline metadata. No automatic
provenance paragraph, date, heading or conversation message ID is added to text.
The caller's `evidenceRefs` satisfy the existing write-intent contract and request
identity; they do not authenticate conversation attribution or become Evidence IR
metadata. A conversation-attribution schema is outside this change.
See [the append decision](decisions/0014-local-mcp-append.md).

## Remote MCP

`dkb mcp serve-http` uses Streamable HTTP at `/mcp`. It exposes only:

- `search`: find immutable compiled chunks and return stable result IDs.
- `fetch`: read one selected chunk with evidence and provenance metadata.

It does not expose install, uninstall, source writes, write intents, queues, or
registry mutation. Package lifecycle remains a CLI/operator action.

The HTTP server requires `DKB_MCP_BEARER_TOKEN`, validates allowed Host and
Origin values, and binds to `127.0.0.1` by default. A production deployment
should terminate HTTPS in a trusted reverse proxy, keep the DKB process on a
private interface, and use standard OAuth when the ChatGPT connection requires
it. Bearer authentication is suitable for controlled agent clients and trusted
proxies; it is not a substitute for a public OAuth deployment.

## Configuration

```text
DKB_RUNTIME_STATE_ROOT=/var/lib/dkb/runtime-personal-tei
DKB_TEI_URL=http://127.0.0.1:8080
DKB_MCP_BEARER_TOKEN=<secret>
DKB_MCP_HTTP_HOST=127.0.0.1
DKB_MCP_HTTP_PORT=7332
DKB_MCP_HTTP_PATH=/mcp
DKB_MCP_ALLOWED_HOSTS=knowledge.example
DKB_MCP_ALLOWED_ORIGINS=chatgpt.com
DKB_MCP_PUBLIC_BASE_URL=https://knowledge.example
DKB_MCP_PUBLIC_DOCUMENTS=true
DKB_MCP_ALLOW_INSECURE_NO_AUTH=false
```

The selected pipeline's embedding provider owns query embeddings. Bundled TEI
uses `DKB_TEI_URL`; the FastEmbed sidecar uses `DKB_QUERY_EMBEDDER_URL`, including
its `/embed` path. The active provider, model revision, dimensions, transforms,
and normalization must match the Runtime activation's compatibility digest.

`DKB_MCP_PUBLIC_DOCUMENTS=true` makes immutable evidence available at
`/documents/{chunk-id}` so citations can open in a browser. Enable it only for
knowledge that is safe to publish; the document route is intentionally public
when enabled.

## Development connection testing

For a non-sensitive development proof, expose the local MCP through a
disposable HTTPS tunnel, create a private ChatGPT development app pointed at
`https://<temporary-origin>/mcp`, and confirm that ChatGPT discovers only
`search` and `fetch`. Stop the tunnel after testing.

Enable the no-authentication proof adapter with
`DKB_MCP_ALLOW_INSECURE_NO_AUTH=true` only for short-lived synthetic data; do
not use it for personal or private knowledge. Bearer authentication remains
mandatory by default.

The grounding test should require ChatGPT to search, fetch, cite only fetched
evidence, ignore source instructions, and return an evidence-insufficient
answer for an unsupported question.

One HTTP MCP process is one Runtime endpoint: it serves that Runtime's selected
Library through that Runtime's active Pipeline. Search and fetch results report
the Runtime name, Library identity, Pipeline, and compatibility digest so an
agent can distinguish endpoints. Collections and their member DKBs are resolved
through the Library ledger; MCP does not scan folders or maintain a second
package list. Stale Runtime activations fail closed.

Search relevance belongs to the selected retrieval provider. MCP does not require
optional keyword diagnostics or apply a second ranking/filtering policy to its
validated results. The bundled hybrid provider rejects weak meaningful-token
coverage before results reach any transport; a lexical or other custom provider
may use a different relevance method. `sufficiency.matchedNeed` reports whether
the provider returned usable hits, while `confidence` is `null` because arbitrary
provider scores are not calibrated answer probabilities. Agents must still
fetch and assess the actual evidence before answering.
