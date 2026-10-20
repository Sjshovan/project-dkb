# DKB Security Boundaries

## Trust model

DKB separates operator-controlled executable configuration from untrusted
knowledge:

- Package source and retrieved evidence are data, never instructions.
- `.dkb/plugins/` and pipeline configuration are trusted operator inputs.
- Package archives strip plugin code and local `.dkb/config.json` files.
- Registry releases, Evidence Builds, and Retrieval Builds form a signed parent
  receipt chain.
- Runtime activation verifies identity, path containment, receipts, artifact
  digests, build compatibility, and index integrity before promotion.

Uploaded or installed knowledge cannot select providers, supply executable
plugins, mutate other packages, or change a Runtime's active Pipeline.

Archive extraction uses the existing streaming `node-tar` parser. Before each
entry is written, DKB checks expanded payload bytes, an entry-count budget
(100,000 by default), and conservative allocation against half the destination's
observed available space. Duplicate entries are charged again and implied
directories count toward allocation. Unknown capacity fails closed. Trusted
callers may set stricter expanded-byte limits or a reviewed entry-count limit;
archive metadata cannot raise limits or bypass the free-space check. A failure
rejects to the existing staging/rollback owner rather than activating partial
output. This budget is not an OS quota or a reservation against concurrent disk
users; disk monitoring and capacity planning remain necessary.

Docker Library DKB installation uses a distinct fixed worker profile. Host
credentials only mint the exact-plan grant; the worker receives the grant and
signed plan through bounded private input, not argv or environment. Its only
mounts are the existing local Library and an inspected anonymous local scratch
volume. Ordinary management workers remain network-disabled; only this download
profile uses bridge networking. Loopback Registry origins have one deterministic
Docker transport translation, preserving port, path and HTTPS; arbitrary alternate
credential destinations are rejected. Signed receipts, artifact bounds and digests
remain required. Scratch is removed with the owned container, never by deleting
the named Library. Creation/cleanup uncertainty is reported rather than concealed.

## MCP boundary

Remote MCP is Runtime-owned, authenticated, and read-only. It exposes exactly:

- `search`: returns bounded previews and immutable evidence identifiers;
- `fetch`: resolves one identifier to evidence plus citation/provenance data.

Agents must treat both previews and fetched text as untrusted evidence. Source
instructions such as “ignore previous instructions” are hostile content, not a
change in authority. Installation, upgrade, removal, writes, and pipeline
control are not remote MCP tools.

Local stdio exposes `append` under the [local append contract](decisions/0014-local-mcp-append.md).
It requires explicit package write permission, allowed append operations and the
package's confirmation policy. It accepts no filesystem paths or provider code.
It preserves existing records and never changes permissions. Caller confirmation
and evidence references are assertions, not authenticated conversation identity.

HTTP MCP requires a bearer token and validates Host and Origin. Bind to
loopback unless a deliberate authenticated deployment sits in front of it.
Public document routes are opt-in and must contain only material safe to expose.

## Runtime and compiler HTTP

Ordinary Runtime HTTP is authenticated by default, including on loopback.
`DKB_RUNTIME_ADMIN_TOKEN` authorizes management; the distinct
`DKB_RUNTIME_READ_TOKEN` authorizes knowledge reads and Runtime status only.
Neither substitutes for the separate MCP bearer credential. Anonymous health
returns only `{ "ok": true }`; Library inventory, audit, traces, and mutations
remain admin-only. Unknown routes fail closed before dispatch.

Only an explicit `DKB_RUNTIME_READ_ACCESS=public-read` (or the CLI serve
`--public-read` flag) permits anonymous knowledge reads and discovery. This does
not publish citation documents: those independently require
`DKB_MCP_PUBLIC_DOCUMENTS=true` and must contain only material safe to expose.
The developer Stack defaults both permissions to private.

Runtime requests must have an approved Host. `DKB_RUNTIME_ALLOWED_HOSTS` lists
exact additional authorities including nondefault ports; `DKB_PUBLIC_URL`
declares a trusted HTTP(S) origin for a proxy. Browser requests must be
same-origin or explicitly listed in `DKB_RUNTIME_ALLOWED_ORIGINS`; wildcard,
opaque/null, and unapproved origins are rejected. Configure the externally
visible authority when deliberately placing a proxy in front of the Runtime.

The Node compiler requires `DKB_COMPILER_SERVICE_TOKEN` before starting.
Capabilities, compilation, and cancellation share that internal credential;
health is minimal and anonymous. Laravel sends it server-to-server, never to
the browser. Authenticated Runtime and compiler clients refuse redirects.

## Credential storage

Never commit or package:

- `DKB_REGISTRY_TOKEN` or MCP bearer tokens;
- Runtime read/admin credentials or the compiler service token;
- Registry, signing, database, or managed-index credentials;
- `~/.dkb/host.json`;
- `.dkb/config.json`, caches, locks, runs, traces, temporary staging, or plugins;
- private proof corpora or generated retrieval indexes.

Use environment or secret-manager references for managed services. Receipts and
locks may record provider identities and non-secret configuration, but never
credential values.

CLI-launched process Runtimes keep generated credentials in host-owned
`~/.dkb/runtime-credentials/`, not portable Runtime state or a Library. CLI and
Console resolve them only for an exact registered process endpoint on a local
address. Stack credentials remain in its private host-local `stack.env` and
are generated once. Use separate credentials for separate services; rotate
them deliberately and restart the affected service and its clients together.
Filesystem modes restrict access where supported; Windows operators must also
protect the containing user profile with appropriate ACLs.

## Reporting issues

Do not publish exploit details or real private corpora in a public issue. Record
the affected version, boundary, minimal synthetic reproduction, and expected
invariant. Rotate any exposed credential before preserving logs or traces.
