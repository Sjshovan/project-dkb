# ChatGPT MCP Boundary

DKB has two MCP surfaces with intentionally different authority.

## Local MCP

`dkb mcp serve` uses stdio and exposes the full local protocol surface. It is
intended for agents running under the user's local process controls.

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
DKB_LIBRARY_PATH=/knowledge/library
DKB_QUERY_EMBEDDER_URL=http://127.0.0.1:8090/embed
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

`DKB_QUERY_EMBEDDER_URL` is the complete query endpoint, including `/embed`.
The query embedder must use the model and dimensions recorded by the active
Library profile.

`DKB_MCP_PUBLIC_DOCUMENTS=true` makes immutable evidence available at
`/documents/{chunk-id}` so citations can open in a browser. Enable it only for
knowledge that is safe to publish; the document route is intentionally public
when enabled.

## Temporary ChatGPT Proof

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

One HTTP MCP process serves one Library. Collections and their member DKBs are
resolved through that Library's lock and applied-state ledger; MCP does not scan
folders or maintain a second package list.
