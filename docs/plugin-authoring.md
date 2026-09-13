# DKB Plugin SDK v3

DKB plugins are trusted operator code that replace one bounded Pipeline stage.
They are not knowledge packages, are never copied into `.dkbpkg` archives, and
are not downloaded from a plugin registry. The public SDK is
`@sjshovan/dkb-pipeline`.

## Start a plugin

### Worker lifetime and cancellation

In-process providers must finish their owned work before `compile()` settles.
An Evidence provider that dispatches child or remote work also implements
`cancelPending({ state, options, signal })`. Its `compile` input may supply an
execution context from `@sjshovan/dkb-pipeline/execution.js`:

1. Persist a private, bounded JSON worker handle with `registerPending(state)`
   **before** dispatch. DKB binds it to the actual selected provider and recipe.
2. On success, failure, or abort, confirm that this exact worker has stopped
   writing. A timeout or closed HTTP connection is not confirmation.
3. Clean only its verified owned scratch, then `settlePending(id)`.
4. If confirmation or cleanup fails, retain the worker handle and scratch and
   throw `DkbError` with code `compile_termination_unconfirmed`.

`cancelPending` must be idempotent across compiler restarts and return
`{ safeToCleanup: true }` only after affirmative exact-worker confirmation and
owned cleanup. A missing local control file is not confirmation. DKB supplies
the original opaque handle only to the same resolved provider/configuration;
it does not let a replacement plugin interpret it. Standalone local providers
retain their own private handle and expose provider-specific recovery without
requiring a Registry. Never put these operational handles in build receipts,
logs, archive contents, or the browser. They may contain private job tokens.

This is an operator-code contract, not a sandbox: a plugin that starts hidden
background work outside the contract cannot claim DKB's termination guarantees.

### Scaffold

```text
dkb plugin init @acme/my-provider --kind embedding ./my-provider
cd ./my-provider
npm install
npm run check
npm test
dkb plugin verify .
dkb plugin test .
```

Supported scaffold kinds are `evidence`, `parser`, `chunker`, `embedding`,
`packaged-index`, `managed-index`, `retrieval`, `processor`, and `observer`.
The generated project is a runnable, package-allowlisted teaching example for
that contract, not a production search engine. Its strict checked-JavaScript configuration validates the ESM
entrypoint, option schema, and conformance test against the public SDK types.
Evidence and parser tests use a generated, temporary editable DKB containing
plain text and Markdown when no fixture is supplied. Use
`--fixture <editable-dkb>` for a provider that supports another source format.
An empty result fails with that recovery command; ingestion is never skipped.

Generated index examples implement bounded lexical search of their compiled
records. Conformance requires the known indexed record to be retrievable;
an empty response or null Runtime for a nonempty fixture cannot pass. The managed
index example demonstrates install, exact rollback, query, and removal using
process-local state owned by one provider setup. It deliberately has no restart
persistence or external index service; use a durable managed implementation for
a deployed Pipeline. The embedding starter is a small deterministic teaching
transform, not a trained semantic model.

Generated option schemas reject unknown keys, wrong types, out-of-range
dimensions, and invalid chunk-size/overlap relationships before provider setup.
Change that provider-owned schema when adding supported options. Evidence and
parser starters hash original bytes, reject malformed UTF-8, and use the
documented unknown-time sentinel rather than a machine's file modification
time, so copying the same source does not invent different provenance.

Every plugin exports one API v3 definition:

```js
import { definePlugin, defineEmbeddingProvider } from '@sjshovan/dkb-pipeline/sdk.js';
import { optionsSchema } from './options.mjs';

export default definePlugin({
  apiVersion: 3,
  id: '@acme/embedding-code',
  version: '1.0.0',
  optionsSchema,
  setup(context) {
    context.registerProvider(defineEmbeddingProvider({
      kind: 'embedding',
      async embedDocuments({ texts, signal }) {
        signal?.throwIfAborted();
        return texts.map(embed);
      },
      async embedQuery({ text, signal }) {
        signal?.throwIfAborted();
        return embed(text);
      },
      compatibility() {
        return { embeddingSpace: 'acme-code-v1', dimensions: 768, metric: 'cosine', normalized: true };
      },
    }));
  },
});
```

Plugins that depend on an external service, image, or model declare the exact
identity through the same definition. The declaration runs against validated,
frozen options before `setup()`:

```js
identity: ({ options }) => ({
  profileOptions: { model: options.model, dimensions: options.dimensions },
  external: [
    { kind: 'service', name: 'embedding-api', digest: options.serviceDigest },
    { kind: 'model', name: 'embedding-model', digest: options.modelDigest },
  ],
}),
```

External values must already be lowercase `sha256:` digests. Raw URLs, image
tags, model names, credentials, tokens, and secret-bearing labels are rejected.
A service-backed distribution maps each required provider identity to one
validated option. The host composition layer supplies the exact digest; a
plugin must not manufacture one by hashing a mutable image tag or endpoint.
A provider may also declare a scoped `identity` when only one provider kind in
a multi-provider plugin uses that external dependency. DKB merges and
canonicalizes the plugin and provider declarations before hashing that
provider's integrity receipt.

Named exports are also accepted when `apiVersion`, `id`, `version`,
`optionsSchema`, and `setup` are exported separately. Do not combine a default
definition with named API fields: the shared loader rejects that ambiguity in
Runtime loading, CLI inspection, and conformance. IDs must use
`@namespace/name`. A plugin may register only one provider of each kind.

## Contract map

| Kind | Receives | Returns | DKB validates |
| --- | --- | --- | --- |
| Evidence | one loaded DKB | documents/chunks and explicit records | provenance, relationships, IDs, spans, hashes, timestamps, metadata, receipt data |
| Parser | one loaded DKB | `DkbParsedDocument` values with explicit source provenance | paths, media types, IDs, text, source hashes, anchors, timestamps, JSON-safe metadata |
| Chunker | validated parsed documents | `DkbLocatedChunk` values with explicit source spans | parent document IDs, unique IDs, text, locators, ordinals, spans, metadata |
| Embedding | texts or one query | vectors and compatibility | count, finite values, dimensions, document/query agreement |
| Packaged index | Evidence IDs plus optional vectors | immutable artifacts and a provider receipt | artifact receipt, queryability, candidates, scores, known Evidence IDs |
| Managed index | same compile input plus install lifecycle | import artifacts and managed state | install ownership, verify, search, exact-index rollback, uninstall/orphan behavior |
| Retrieval | index candidates plus DKB Evidence catalog | ranked Evidence hits and trace | known Evidence IDs, finite scores, channels, scope, limit |
| Processor | one document, chunk, or record | changed value or `null` | output after every step; correlation IDs, source paths, DKB-reserved metadata, and provenance cannot change |
| Query observer | frozen redacted audit event | no response data | event remains immutable; each selected observer settles independently and failures affect observer health only |

Use the matching `define*` helper. The helpers reject already-cancelled
operations at the SDK boundary. Long-running implementations must also check
the supplied `AbortSignal` between batches and pass it to network or process
calls. Providers own cleanup through `dispose`; opened index and retrieval
Runtimes own cleanup through `close`.

Retrieval providers own relevance filtering as well as ranking: return no hits
when the query is unsupported. CLI, HTTP, and MCP expose the same validated hits;
optional `matchedTokens` are diagnostics, not a transport admission requirement.
The bundled hybrid provider retains its conservative meaningful-token coverage
policy inside the provider. Other providers may use their own techniques without
imitating that metadata or changing Runtime code. MCP does not manufacture a
calibrated confidence score from an arbitrary provider's scores.

Managed installation must return an explicit `created` boolean. Rollback calls
`discardPackage` only for an exact index that this attempt created. Implement
that method separately from `uninstallPackage`: it must reject a foreign index
ID and never remove another Pipeline's retained index. An unsupported or failed
cleanup produces an actionable orphan warning, not a broad uninstall fallback.

Runtime observer health is keyed to the exact activation and records each
selected observer's last result plus cumulative success and failure counts in
the existing Runtime audit database. Inspect it with `dkb runtime show` or the
Runtime detail page in the Console. Observer or health-state persistence
failures are logged and never replace an already validated retrieval response.
Observer deliveries run independently with a one-second host budget and a
cooperative abort signal. A timed-out delivery is recorded as degraded; that
observer is not called again until its previous invocation settles. This avoids
unbounded overlapping exports without introducing a durable telemetry queue.
Respect the signal and buffer exports inside the observer when necessary.
Trusted in-process code that blocks the JavaScript event loop cannot be forcibly
interrupted by this deadline; plugins are not sandboxed.

## Options and secrets

`optionsSchema` implements [Standard Schema V1](https://standardschema.dev/).
Zod, Valibot, ArkType, or another conforming validator may be used directly.
The built-in `defineOptionsSchema` helper is sufficient for small plugins.

DKB validates and deeply freezes resolved options before resolving identity or
calling `setup`. Without an identity declaration, every option remains
identity-bearing by default. A declaration may return `profileOptions` as an
unchanged subset of validated options; omitted endpoint, timeout, batching, and
secret-reference settings remain operational and do not force a new build.
Do not put credentials in either object. Store only an environment-variable
name such as `apiKeyEnv`; the secret value is resolved by the provider at
runtime and never enters receipts.

## Code and model identity

DKB hashes shipped plugin files and the actual installed code of declared
runtime dependencies, including their transitive dependency graph. The receipt
is independent of checkout paths and unrelated host lockfile entries. Declare
all external imports in `package.json`; literal relative imports cannot escape
the plugin directory. This is an integrity boundary, not a JavaScript sandbox:
operator plugins are trusted, and hidden dynamic dependencies remain the
operator's responsibility.

Literal imports are inspected with Acorn's syntax tree, not text matching:
comments, ordinary strings, and regular expressions are not imports. Supported
`.ts`, `.mts`, and `.cts` helpers are inspected using Node's native type-stripping
parser; type-only imports do not become runtime dependencies. This does not
enable TypeScript execution. On Node 22.15, executing those helpers requires
`--experimental-strip-types`; unsupported transformation syntax fails closed.
Use an explicitly supported Node loader or ship JavaScript for portable plugins.
See [Node 22.15 TypeScript support](https://nodejs.org/download/release/v22.15.0/docs/api/typescript.html).

Changing a dependency or imported helper requires restarting the Runtime or
compiler process: Node may retain the previously loaded module. Existing hosts
check selected recipe definitions, plugin precedence, code, and dependency
filesystem observations before reuse, without rerunning `setup()`. Those local
observations detect drift; portable profile identities remain content-based.

Bundled FastEmbed and TEI require immutable model commits. FastEmbed downloads
only its pinned model snapshot and loads it locally; service responses must
echo that same repository and revision. A custom model name without an exact
revision is rejected. The Docling tokenizer is pinned independently because it
affects chunk boundaries, not retrieval vectors.

The Evidence worker includes a SHA-256 allowlist for only its layout model,
accurate table model, and selected OCR assets. Its image downloads and verifies
those files at build time; Docling receives their explicit local paths. It does
not run an all-model downloader. CPU images use explicit `ocrBackend: "torch"`
with the existing multilingual model. For the GPU image, select
`ocrBackend: "onnxruntime"` explicitly to retain its previous auto-selected OCR
backend. Each image contains only its selected backend's assets.

Configure `richFiles`, `richFileFallback`, `richFileExtensions`, `ocrBackend`,
and `ocrLanguage` in the Evidence provider options. These output-changing
choices participate in its profile identity; the former `DKB_DOCLING_*`
environment selectors no longer override them. Corrupt or missing pinned
assets fail closed and cannot trigger a parser fallback. These contracts still
require the real-image conformance proof; manifest checks alone are not a
successful document-conversion proof.

## Evidence and provenance rules

Providers return their native `id` and `chunkId` correlation keys plus explicit
provenance. DKB creates canonical Evidence IDs. An embedder, index, retrieval
provider, processor, or observer must never invent a canonical Evidence ID.

Every record has nonempty text and:

```ts
provenance: {
  assetId: string;
  storeId: string;
  sourceType: 'filesystem' | 'sqlite' | 'database';
  locator: Record<string, JsonValue>;
  assetLocator: Record<string, JsonValue>;
  title: string;
  sourceHash: `sha256:${string}`;
  updatedAt: string;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
}
```

Text processors may change text; DKB recomputes the text hash and records the
ordered processor chain. They may not change source identity, source hash,
locators, or spans.

In the separate parser/chunker path, the parser supplies source provenance on
each `DkbParsedDocument`; the chunker supplies locator, ordinal, and span
provenance on each `DkbLocatedChunk`. DKB combines those explicit fields into
the record contract above. It never infers them from arbitrary `metadata` or
recomputes the original source hash from processor-modified text. Document and
chunk processors preserve those protected fields. The
[runnable lexical example](../examples/lexical-pipeline/README.md) demonstrates
this complete path.

A fused Evidence provider has already completed parsing and chunking, so its
target may select record processors only. To insert document or chunk
processors, define the target with separate parser and chunker providers. DKB
rejects an impossible fused ordering instead of running middleware too late.

## Provider integrity and trust

Bundled provider builds produce `dist/provider.integrity.json` in format
`dkb.provider-integrity.v1`. This is generated build output, not a hand-authored
plugin manifest. It records the API version, plugin/package identity, portable
entrypoint, exact shipped-file inventory and hashes, dependency-tree digest,
and declared protocols and artifact formats. Its own file is excluded from
the file digest so generation is not circular.

The distribution contains inert references (`id`, `version`, `sourceUrl`, and
`exportName`), not imported plugin definitions. After resolving overrides, the
selected provider's loader compares the baseline with installed files and the
exact declared dependency closure before importing the module or calling
`setup()`. It checks the imported definition against the receipt and observes
the inputs again before admission. Missing, stale,
or mismatched receipts fail closed. Loading, installing, and inspecting a
package never silently regenerates the baseline. Rebuild the owning provider
workspace after intentional source/dependency changes, or reinstall its
matching release, then restart a process that loaded the previous code.

Literal relative imports must resolve to files in the receipt inventory;
literal external imports must name declared runtime dependencies. A helper
left outside the package allowlist cannot silently participate in a verified
build. These checks do not sandbox trusted JavaScript or certify arbitrary
computed code loading.

The generated receipt is a checksum baseline shipped with a trusted software
distribution, not a Registry signature or a sandbox for executable plugins.
DKB's resolved execution identity adds validated semantic options, ordered
processors, and canonical service/image/model digests. Operational settings
and secret values do not belong in the generated receipt. Registry signing
subsequently binds the resolved provider chain into the knowledge build.

The six deployable provider packages bundle their exact runtime dependencies.
Use the [verified distribution staging](private-releases.md#using-candidates-today)
for release archives: packing a hoisted workspace directly can omit its linked
dependencies. Staging consumes lock-resolved cached archives, disables install
scripts, and rechecks the existing receipt. It fails rather than resolving a
newer dependency or rebuilding a receipt. The SDK and Protocol remain ordinary
libraries; operator plugins still own their dependency choices.

Package inspection uses the invoking tool's trusted SDK verifier, never code
from the candidate's dependency tree. A copied inspection tool must be given
an explicit trusted host SDK; missing verifier dependencies fail closed.

Providers return only provider-owned build, optional compatibility, and
optional diagnostics data; DKB supplies the provider identity. Stable build
and compatibility fields participate in reproducibility. Elapsed times and
other run-specific measurements belong in `diagnostics`.

Operator-owned filesystem plugins still receive host-computed file/dependency
identities. They do not need a generated distribution receipt or DKB plugin
manifest. See the dated [system-map status](architecture/system-map.md) for the
current implementation and end-to-end proof status.

Filesystem resolution is Runtime-local, then Library-local, then user-global,
then bundled. Modules and provider setup are selected-only. The host owns
bundled imports and records the verified identity before reusing a module;
setup and provider state remain separate for each host. A changed loaded
provider or dependency requires a process restart. Arbitrary imports or code
execution outside this loader are not covered by its reproducibility contract.
A broken higher-precedence override fails closed instead of falling through.
Registry compilers use their own
trusted context root and allowlisted recipes. Registry-origin releases accept
only Registry-compiled and Registry-signed build chains; editable local DKBs
may use trusted local plugins but those builds remain visibly local.

## Two materially different Pipelines

Vector semantic retrieval:

```json
{
  "evidence": "@dkb/evidence-docling-llamaindex",
  "embedding": "@dkb/embedding-tei",
  "index": "@dkb/index-faiss",
  "retrieval": "@dkb/retrieval-hybrid"
}
```

This parses rich files, creates embedding-free Evidence IR, embeds documents
and queries with TEI, packages a FAISS index, and fuses candidate channels.

Lexical-only retrieval from the executable `examples/lexical-pipeline` plugin:

```json
{
  "parser": "@example/minisearch-lexical",
  "chunker": "@example/minisearch-lexical",
  "embedding": null,
  "index": "@example/minisearch-lexical",
  "retrieval": "@example/minisearch-lexical"
}
```

The example parses UTF-8 Markdown/text, chunks by headings and bounded source
spans, and packages a MiniSearch inverted index. It uses MiniSearch's tokenizer
and ranking rather than implementing a search engine. Its index and retrieval
providers declare `vectors: "none"`, so no embedding provider or dummy vectors
exist. Both Pipelines expose the same DKB evidence/citation contract; different
Evidence recipes intentionally produce different Evidence identities.

The example's README contains the complete checked code, installation commands,
limits, and conformance tests. Its local proof exercises nonempty retrieval,
scope, two Runtimes, stale-state rejection, rollback, removal, and retained-build
reuse. It is not the bundled default and is not a claim of Registry or real-corpus
performance parity.

## Verification checklist

`dkb plugin verify` loads the module and checks its definition, identity, and
options without selecting it or invoking `setup()`. Module and schema evaluation
still execute trusted operator code; this command is not a sandbox. Provider
registration and behavior are exercised by `dkb plugin test`, which runs the public
conformance runner used by DKB's own providers. It covers options, output
validation, provenance, vectors, index lifecycle, retrieval hits, cancellation,
health when supplied, disposal, and observer immutability. Evidence compilation
runs twice against identical source and options and compares canonicalized
records, documents, chunk relationships, and stable build/compatibility receipt
data. Diagnostics are validated on both runs but timing and run diagnostics are
not compared as semantic output.
Source ingestion, cancellation, and nonempty output checks are mandatory.
Optional health or disposal hooks may be reported as skipped when absent; a
skipped check is never presented as passed.

DKB's bundled providers must pass the same public runner against their real
service dependencies:

```powershell
npm.cmd run proof:providers
```

This proof requires Docker Desktop's Linux engine. It starts only the missing
DKB Evidence, FastEmbed, and TEI services, creates a uniquely named disposable
Meilisearch container, builds the bundled FAISS helper image when absent, and
then runs Evidence, embedding, packaged-index, managed-index, and retrieval
conformance. Services that were already running are left running; services and
the Meilisearch container started by the proof are stopped during cleanup. A
missing Docker engine fails before any provider state is changed and prints the
recovery command.
