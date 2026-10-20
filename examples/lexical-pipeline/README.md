# A complete lexical-only Pipeline

This operator-controlled plugin is a runnable alternative to DKB's bundled
Docling/LlamaIndex → TEI → FAISS → hybrid Pipeline. It demonstrates the same
public SDK with different techniques, not a mock embedder or a keyword-vector
fallback. It does not change DKB's defaults.

```text
UTF-8 .md/.txt source
  → filesystem parser with original-byte hashes
  → Markdown heading / bounded-character chunker
  → DKB canonical Evidence IR and catalog
  → MiniSearch packaged lexical index (no embeddings)
  → rank fusion and scoped Evidence IDs
  → DKB search / fetch / citations / mandatory audit
```

[MiniSearch 7.2.0](https://github.com/lucaong/minisearch) supplies tokenization,
inverted indexing, and lexical ranking. Its immutable JSON export is the only
provider artifact. Each package has independent ranking statistics, so the
adapter combines package result ranks using RRF with a constant of 60, not raw
scores. Source text and canonical provenance are read from DKB's Evidence
catalog, never returned by the index.

## Run from this checkout

The example uses the matching SDK workspace and the exact MiniSearch dependency
installed by the root lockfile. Run these commands from the repository root:

```powershell
npm.cmd ci
npm.cmd run build
node --import ./tests/test-environment.mjs --test tests/lexical-pipeline-example.test.mjs
dkb plugin verify ./examples/lexical-pipeline
dkb plugin test ./examples/lexical-pipeline
```

The executable proof compiles nonempty Markdown and text packages, checks source
hashes, opens two independent Runtimes, retrieves all three synthetic markers,
fetches their evidence, rejects out-of-scope results, and returns no evidence
for an unrelated query. It also verifies corrupt-build rollback, stale Runtime
rejection after Library removal, independent refresh, and reactivation of the
same build bytes without parsing, chunking, or embedding again. Its Libraries,
Runtime state, and host inventory are temporary and isolated. This local
editable-package proof is not a signed Registry-publication or performance
benchmark.

## Select it for a Library

From an existing Library, link the example as trusted operator code (replace
the checkout path). This does not install code from a knowledge package:

```powershell
dkb plugin link C:\path\to\codename-dkb\examples\lexical-pipeline --root .
dkb pipeline set minisearch-lexical --root . --parser @example/minisearch-lexical --chunker @example/minisearch-lexical --index @example/minisearch-lexical --retrieval @example/minisearch-lexical --no-activate
dkb build .\your-editable-dkb --pipeline minisearch-lexical
dkb library add @your-team/your-editable-dkb
```

Then select `minisearch-lexical` for a Runtime serving that Library. For a new
foreground Runtime, the existing command is:

```powershell
dkb runtime serve --name lexical --state-root C:\dkb-runtimes\lexical --library C:\path\to\your-library --pipeline minisearch-lexical
```

The equivalent recipe is in [pipeline.json](pipeline.json). Merge its target
into an existing `.dkb/config.json`; do not overwrite other recipes or Registry
configuration. Registry operators may install this same trusted plugin and
recipe in their compiler context. Registry-origin packages still require a
Registry-compiled signed build; the local example cannot bypass that rule.

## Boundaries and options

- `maxChunkChars`: 1,200 by default, from 64 through 8,192. Heading sections
  longer than this are split without overlap. This is an ATX-heading example,
  not a complete CommonMark or rich-document parser.
- `maxSourceBytes`: 10 MiB per source by default, at most 64 MiB. It is a limit,
  not permission to use arbitrarily large corpora; MiniSearch loads indexes in
  memory. The example also rejects index artifacts larger than 256 MiB.
- Unknown options, invalid UTF-8, and symbolic-link source entries fail closed.
  Hidden directories, `vendor`, `node_modules`, `dist`, and `build` are excluded.
- All options and the actual declared dependency bytes participate in profile
  identity. There are no service credentials, models, remote requests, or dummy
  vectors. There is no automatic fallback to this Pipeline.
- Source modification time is not portable. `updatedAt` uses the documented
  `1970-01-01T00:00:00.000Z` unknown-time sentinel; it does not claim the source
  was created then. Original-byte hashes and portable paths identify source.
- Parser and chunker return explicit protected provenance. Processors cannot
  rewrite source hashes or anchors. DKB creates canonical Evidence IDs.
- Index build/search batches honor cancellation. Library and Runtime own staged
  promotion, activation, corruption rejection, and audit; the plugin does not
  write active-state files.

The example is outside the product workspaces. To distribute it independently,
install the exact matching private SDK release and its declared dependency,
then run its `check` and `test` scripts. Do not expect an unpublished SDK version
to be available on public npm. The package's explicit file allowlist excludes
fixtures and local test data. See the [SDK guide](../../docs/plugin-authoring.md)
for contracts, service-backed provider examples, and trust rules.
