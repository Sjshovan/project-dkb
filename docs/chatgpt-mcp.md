# ChatGPT MCP Boundary

DKB uses Runtime-owned MCP tools. Local stdio supports policy-controlled text
creation and append; HTTP remains read-only.

## Local MCP

`dkb mcp serve` exposes `search`, `fetch`, `write_targets`, `create` and `append`.
Bind it to an initialized local Runtime with `DKB_RUNTIME_STATE_ROOT`.
Client tool allowlists must expose the new tools before agents can use them.
Tools remain discoverable when writes are disabled; execution returns a structured
permission error. MCP cannot edit permissions, install packages or select providers.

### Destination policy

The operator configures each editable installed package's `dkb.json`:

```json
{
  "permissions": { "read": true, "write": true },
  "write": {
    "mode": "direct",
    "operations": ["append", "create"],
    "confirmationRequired": true,
    "paths": {
      "append": ["/facts/", "/*.md"],
      "create": ["/facts/"],
      "exclude": ["/facts/private/", "secret.md"]
    }
  }
}
```

Missing operation allowlists deny that operation. Exclusions always win. Read
permission, Registry inclusion rules and `localSources.excludes` do not grant write
access. The server enforces these rules again at execution; agent selection is
advisory. Registry packages and indirect/outside-Library paths are not writable.

Patterns use the bounded `dkb-write-glob-v1` subset, not all of Git's ignore syntax:

| Pattern | Meaning |
| --- | --- |
| `*.md` or `*` | Matching basename at any depth |
| `/*.md` or `/*` | Matching root-level entry only |
| `/folder/` | Every descendant of that root folder |
| `/folder` | Exact path only; does not imply descendants |
| `folder/*.md` | Root-relative folder, one file segment |
| `**/*.txt` | Text files at any depth, including root |
| `/notes/**/fact?.md` | Zero or more directories; one character after fact |

Matching is case-insensitive, with forward slashes and package-relative paths.
Single `*` and `?` do not cross slashes; `**` must occupy a whole segment.
Negation, escapes/backslashes, comments, character classes, braces, empty/dot
segments and ambiguous patterns are rejected. Lists allow at most 100 patterns,
each at most 512 characters. Exclusions cannot be negated or overridden.

Even broad allowlists cannot write dot paths, control manifests, `AGENTS.md`,
`SKILL.md`, vendor/dependency/build/archive directories, nonportable paths or
symlinked paths. Existing append targets must be regular files without hardlinks.
Only UTF-8 `.md` and `.txt` are supported; existing invalid UTF-8/NUL sources are
rejected. Native writes fail closed for `write.schema`, required semantic dedupe
or nonempty `write.accepts`, because those constraints are not implemented.

### Agent list/select/write flow

1. Call `write_targets` with optional `dkbId`. It returns each editable package's
   existing append targets, source hashes, formats and confirmation policy. Its
   `creation` object returns allow/exclude patterns even when the package is empty.
   No source contents are returned. Existing targets are paginated at 100; pass
   `nextCursor` as `after` with that package ID. A scan is bounded to 10,000 entries.
2. Select a semantically suitable existing file, or a new path permitted by the
   creation policy. Discovery does not promise that the selected Pipeline ingests
   a format; compilation verifies actual ingestion before any source commit.
3. Obtain confirmation when required, then call the selected tool. Confirmation
   is a caller assertion, not independent authentication of a human action.

Example `append` input (replace the hash with the discovery result):

```json
{
  "dkbId": "@team/memory",
  "requestId": "fact-001",
  "path": "facts/support.md",
  "expectedSourceHash": "sha256:<64 lowercase hex digits from discovery>",
  "text": "\nThe support desk opens at 09:00.\n",
  "evidenceRefs": ["caller-known-source-reference"],
  "confirmed": true
}
```

`append` requires an existing file and matching `expectedSourceHash`. It preserves
all old bytes as an exact prefix, including BOM and line endings. It does not add
separators: include desired newlines in `text`. `create` uses the same input except
`expectedSourceHash` is omitted; the path must be absent and is never overwritten.
Text is limited to 64 KiB per request and the resulting file to 16 MiB. Request IDs
accept 1-80 letters, digits, underscores or hyphens.

For compatibility, a manifest without `write.paths` can still use pathless `append`
to insert a new `append-<requestId>.md` asset under the original policy. It cannot
select an existing file. Adding `write.paths` opts into explicit destinations and
disables that legacy form. No automatic manifest or live-permission migration occurs.

### Revisions, retries and recovery

Trusted compilation prepares immutable Evidence/Retrieval Builds for the whole
target package before commit. The Library transaction owns the source, retained
revision, immutable builds, receipt and generation. The Runtime activates the
exact result and fetches it before returning `appended` (also the success status
for `create`; `receipt.operation` identifies the requested action).

An existing-file append changes its source hash and therefore its evidence IDs.
Search uses only the current revision. Previously issued IDs remain exact-fetchable
from validated retained builds, with historical revision metadata and the original
source hash/build digests in citations and audit candidates. They are not injected
into current search rankings. Unrelated source identities remain unchanged.

Retained source bytes live at `.dkb/source-revisions/<hash>.txt` and exact old build
selections at `.dkb/source-history.json`. They are required local state: corruption
fails closed, and there is no automatic garbage collection. History is scoped to
the installed package version and is not part of portable Registry source exports.
Uninstall prevents serving the package; reinstallation of the same retained local
package/version can restore fetches. Preserve this state with local backups.

Reuse the identical request ID, operation, path, hash, text and references after an
uncertain response. A changed request under the same ID conflicts. Identical retry
after later source appends uses retained revisions and never adds duplicate bytes.
External edits without matching history require operator reconciliation.

`committed_refresh_required` means source was saved but retrieval needs recovery;
restore the Pipeline and retry the same request. `recovery_required` with
`committed: null` requires Library recovery before another write. Never use a new
ID to conceal an unresolved outcome. Other Runtimes fail closed until refreshed.

Source/chunk/build provenance stays structured. No provenance paragraph, date,
heading or message ID is added. `evidenceRefs` are caller-known references used in
request identity; they are not authenticated conversation attribution or inserted
into Evidence IR. See [ADR 0014](decisions/0014-local-mcp-append.md) and
[ADR 0015](decisions/0015-targeted-source-writes.md).

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
