# DKB

DKB is a developer-preview toolkit for packaging, installing, compiling, and
serving durable knowledgebases. It gives operators an npm-like knowledge
lifecycle while keeping source, provenance, Evidence IR, and runtime-specific
retrieval builds separate.

```text
PackageVersion -> Evidence Build -> Retrieval Build -> Runtime
```

- A **DKB** is one namespaced, versioned knowledge package.
- A **Collection** pins a set of exact DKB releases.
- A **Library** is one local knowledge environment served by one Runtime.
- A **Registry** publishes and distributes signed releases and builds.
- A **pipeline** is a recipe. Evidence and Retrieval Builds are its stored,
  content-addressed results.

The remote MCP surface is deliberately read-only and exposes exactly `search`
and `fetch`. Installation, upgrade, removal, compilation, and pipeline changes
remain operator-controlled.

> **Status:** developer preview. Formats and commands are being hardened on the
> `development` branch. Do not treat this checkout as a production release.
> Release candidates currently remain private in GitHub Packages and GHCR; see
> [Private developer-preview releases](docs/private-releases.md).
> Current limitations are explicit in
> [Developer-preview boundaries](docs/developer-preview.md).

## Install from this checkout

Requirements: Node.js 22.15 or later. Docker is required for the bundled
Docling/LlamaIndex and TEI services.

```powershell
npm install
npm run build
npm link --workspace @sjshovan/dkb-cli
dkb --version
dkb version
```

`dkb --version` reports the CLI version. `dkb version` reports the independently
versioned protocol, compiler, Runtime, and provider packages selected by the
default distribution.

## First Library

```powershell
mkdir MyKnowledge
cd MyKnowledge
dkb init --registry-url http://127.0.0.1:8000 --yes
dkb init @my-team/handbook
dkb validate .\handbook
dkb build .\handbook
dkb library add @my-team/handbook
dkb serve
```

Initialization succeeds even when the Registry is offline. DKB saves the URL,
prints a warning, and provides the exact verification command. Local knowledge
authoring and compilation do not require a running Registry.

For a first non-sensitive proof, compile and query the
[example operations handbook](examples/hello-dkb/README.md).

## Package lifecycle

```powershell
dkb search handbook
dkb install @my-team/handbook --version 1.0.0
dkb list
dkb show @my-team/handbook
dkb retrieve "How are production incidents escalated?"
dkb outdated
dkb upgrade @my-team/handbook --dry-run
dkb upgrade @my-team/handbook
dkb uninstall @my-team/handbook
```

`install` downloads an already compiled, signed build chain. It does not parse,
chunk, or embed the package. Installing the same immutable release is a clean
no-op. Upgrade and uninstall preserve the previous active Runtime snapshot when
validation or activation fails.

Registry authentication uses scoped, expiring bearer tokens. Run
`dkb registry login` for masked entry, `dkb registry whoami` to inspect the
active identity, and `dkb registry logout --revoke` to revoke and remove it.
Automation may continue to use `DKB_REGISTRY_TOKEN`; command-line `--token`
values are supported but can be exposed through shell history.

## Context and host inventory

DKB records known resources in `~/.dkb/host.json` so commands work outside a
Library. This file stores names, paths, URLs, and defaults only—never tokens,
knowledge, or pipeline configuration.

```powershell
dkb library list
dkb library use personal
dkb registry list --check
dkb registry use team
dkb runtime list --check
dkb runtime use local
dkb library storage
```

Library resolution is explicit `--library`, `DKB_LIBRARY_PATH`, nearest parent
Library, then the host default. Runtime resolution is explicit `--url`,
`DKB_RUNTIME_URL`, host default, then localhost. DKB never scans disks or
networks for resources.

## Build and pipeline model

```powershell
dkb pipeline list
dkb pipeline show
dkb pipeline verify
dkb build .\handbook
dkb compile .\handbook # supported compatibility command for the same compiler
dkb build list .\handbook
dkb pipeline use fastembed-faiss
dkb build prune .\handbook
```

The default target uses Docling/LlamaIndex ingestion, TEI embeddings, packaged
FAISS, and DKB hybrid retrieval. FastEmbed remains a separate selectable
embedding space. Changing an embedder or index reuses compatible Evidence IR;
changing parsing, chunking, or text-mutating processors creates another
Evidence Build.

Builds are staged and promoted atomically. Inactive builds remain until an
operator prunes them. Human build output reports files, source bytes, records,
chunks, derived size, expansion ratio, stage timings, and disk preflight—not
file count as a proxy for corpus size.

## Runtime and MCP

```powershell
dkb runtime serve --state-root C:\knowledge\personal
dkb add C:\knowledge\editable-package
dkb runtime import C:\knowledge\editable-package
dkb mcp serve
```

For authenticated Streamable HTTP MCP:

```powershell
$env:DKB_LIBRARY_PATH = 'C:\knowledge\personal'
$env:DKB_MCP_BEARER_TOKEN = '<secret>'
dkb mcp serve-http --host 127.0.0.1 --port 7332
```

Public citation URLs require an explicit `DKB_MCP_PUBLIC_BASE_URL`; immutable
evidence documents are exposed only when `DKB_MCP_PUBLIC_DOCUMENTS=true`.

## Automation and recovery

- Human output is the default. Use `--json` for one stable JSON document.
- `--no-progress` disables animation without changing to machine output.
- Diagnostic commands return nonzero when their report is unhealthy.
- Generated state lives under `.dkb/` and must not be committed.
- `.dkb/plugins/` is trusted operator code. It is never packaged with knowledge.
- `dkb restore` regenerates derived retrieval artifacts from canonical source.

See [Operations](docs/operations.md) for storage, backups, credentials, and
recovery, and [CLI UX](docs/cli-ux.md) for the output and exit-code contract.

## Architecture and contributor docs

- [Architecture](docs/artifact-architecture.md)
- [Libraries and Collections](docs/library-and-collections.md)
- [Provider pipeline](docs/provider-pipeline.md)
- [CLI UX](docs/cli-ux.md)
- [Operations](docs/operations.md)
- [Security](docs/security.md)
- [ChatGPT and MCP](docs/chatgpt-mcp.md)
- [Architecture decisions](docs/decisions/)
- [Agent navigation](docs/agent-navigation.md)

Repository ownership and verification rules are scoped through the nearest
`AGENTS.md`. Start with the root guidance before changing a subsystem.
