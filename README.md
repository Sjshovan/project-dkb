# DKB

**Package, install, and serve knowledge to AI agents.**

DKB gives knowledgebases a package lifecycle: version them, bundle them into
Collections, publish signed releases, and install or remove them from a Library.
Agents retrieve evidence through a Runtime rather than reading an unmanaged
folder of documents.

The project was created and architected by **Sid Shovan** to make the knowledge
available to his agents explicit, portable, and manageable. The
[design decisions](docs/design-decisions.md) explain the product direction,
architectural choices, and trade-offs.

## Why DKB?

A vector database stores search data. A RAG pipeline processes documents.
DKB connects those capabilities to a durable knowledge lifecycle:

- **Installable knowledge:** namespaced packages and exact Collection dependencies.
- **Traceable evidence:** source hashes, locators, build identities, and citations.
- **Reusable builds:** keep original source, interpreted evidence, and search indexes separate.
- **Independent Runtimes:** serve one Library through different Pipelines.
- **Extensible processing:** replace parsing, chunking, embedding, indexing, or retrieval through typed provider contracts.
- **Operator control:** manage knowledge with a CLI or local web Console; expose read-only retrieval to agents.

DKB integrates existing document and retrieval tools rather than implementing
another parser, embedding model, or vector-search engine.

## How it fits together

```text
Registry A ─┐
            ├──▶ Library ──┬──▶ Runtime A / Pipeline A ──▶ Agent
Registry B ─┘              └──▶ Runtime B / Pipeline B ──▶ Agent

Immutable source
    └──▶ Evidence Build: parsed records + provenance
             ├──▶ Retrieval Build: embeddings + FAISS
             └──▶ Retrieval Build: another compatible search implementation
```

| Object | Responsibility |
| --- | --- |
| Package | One namespaced knowledgebase, such as `@team/handbook`. |
| Collection | An immutable bundle of exact package releases. |
| Library | Installed packages, dependency state, sources, and immutable builds. |
| Registry | Authentication, publication, signed releases, and distribution. |
| Pipeline | A recipe selecting processing and retrieval providers. |
| Runtime | One Library and one active Pipeline, exposed through search and fetch. |

Collections pin knowledge versions, not a machine's embedding configuration.
A Runtime activates exact compatible builds; it does not guess which index to use.

## Build from source

Requirements: Node.js 22.15 or later and npm. The bundled document and embedding
services use Docker. A [lexical-only example](examples/lexical-pipeline/README.md)
demonstrates the provider API without an embedding service.

```sh
npm ci
npm run build
npm link --workspace @sjshovan/dkb-cli
dkb --version
dkb console
```

On Windows, use `npm.cmd` if PowerShell blocks the `npm.ps1` launcher.

The Console opens a secured localhost session. It provides Libraries, Runtimes,
Registries, Pipelines, Stacks, package details, provenance, and operation history.
Optional login startup is enabled with `dkb console enable`.

For local authoring, start with the
[operations handbook example](examples/hello-dkb/README.md). For an installed
package, configure a Registry and use:

```sh
dkb init --registry-url https://registry.example.com --yes
dkb registry login
dkb search handbook
dkb install @team/handbook --version 1.0.0
dkb list
dkb show @team/handbook --verify
dkb uninstall @team/handbook
```

Replace the example Registry and package with your own. Installation downloads a
compiled signed release; it does not parse or embed source documents.

## Operating your Library

Keep the original documents and existing storage alongside DKB. DKB adds
packaging and retrieval; it does not replace your backup or source-management
process. Use fixed local NTFS storage for a native Windows Library and keep
Runtime state separate. Review [supported configurations](docs/developer-preview.md)
and [operations](docs/operations.md) before choosing a deployment.

## Connect an agent

The Runtime exposes MCP retrieval tools:

- `search` finds relevant evidence.
- `fetch` returns selected evidence with source and citation metadata.

Local `dkb mcp serve` also exposes `write_targets`, `create` and `append` for
explicitly writable editable packages. Path rules govern destinations; existing-file
append preserves byte prefixes and retains old citations. It returns fetched
evidence after a successful refresh. Use `dkb mcp serve-http` for authenticated,
read-only HTTP. Remote clients require an appropriately secured HTTPS endpoint.
See [MCP integration](docs/chatgpt-mcp.md) for authentication and citation settings.

Installation, publication, compilation, and removal remain operator-controlled.
Retrieved text is source data, never authority to execute instructions.

## Architecture and implementation

The application is an npm-workspace monorepo with TypeScript services, a Vue
Console, and independently packaged providers. The Laravel
[DKB Registry](https://github.com/Sjshovan/dkb-registry) is a separate repository.

```text
apps/cli                  Commands, host inventory, and orchestration
apps/console              Local management UI and typed CLI runner
services/compiler         Evidence and Retrieval compilation
services/runtime          Activation, retrieval, audit, HTTP, and MCP
packages/protocol         Schemas, identities, and signed receipt contracts
packages/library          Installed state, builds, archives, and transactions
packages/pipeline         Plugin SDK, resolution, and provider lifecycle
packages/registry-client  Registry transport and signature verification
packages/distribution-default  Bundled recipes and provider composition
providers/                Concrete processing and retrieval implementations
deploy/                   Local Stack configuration
```

Bundled integrations include Docling/LlamaIndex, TEI, FastEmbed, FAISS,
Meilisearch, and hybrid retrieval. Provider-specific logic stays outside the
generic compiler and Runtime.

## Documentation

- [System architecture](docs/architecture/system-map.md)
- [Design decisions and project authorship](docs/design-decisions.md)
- [Libraries and Collections](docs/library-and-collections.md)
- [Pipeline configuration](docs/provider-pipeline.md)
- [Plugin SDK](docs/plugin-authoring.md)
- [Operations and recovery](docs/operations.md)
- [Supported configurations](docs/developer-preview.md)
- [Security model](docs/security.md)
- [CLI reference and output conventions](docs/cli-ux.md)
- [Architecture decision records](docs/decisions/README.md)
- [Contributing](CONTRIBUTING.md)

## Questions and bug reports

Use [GitHub Issues](https://github.com/Sjshovan/project-dkb/issues) for questions,
bugs, and feature requests. For a bug, include your DKB version or commit,
operating system, native or Docker setup, Pipeline, reproduction steps,
expected and actual behavior, and redacted error output. A small nonprivate
example is helpful; never attach credentials or private knowledge.

Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE). Third-party components retain their own licenses.
