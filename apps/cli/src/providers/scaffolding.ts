import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { isPluginId } from '@sjshovan/dkb-pipeline/config.js';

export const DKB_PLUGIN_KINDS = ['evidence', 'parser', 'chunker', 'embedding', 'packaged-index', 'managed-index', 'retrieval', 'processor', 'observer'] as const;
export type DkbPluginScaffoldKind = typeof DKB_PLUGIN_KINDS[number];

export interface DkbPluginScaffoldResult {
  id: string;
  version: string;
  kind: DkbPluginScaffoldKind;
  path: string;
  files: string[];
}

export async function scaffoldPlugin(input: { id: string; kind: string; directory?: string }): Promise<DkbPluginScaffoldResult> {
  if (!isPluginId(input.id)) throw new DkbError(`Invalid plugin id ${input.id}. Use @namespace/name.`);
  if (!DKB_PLUGIN_KINDS.includes(input.kind as DkbPluginScaffoldKind)) {
    throw new DkbError(`Unknown plugin kind ${input.kind}. Choose one of: ${DKB_PLUGIN_KINDS.join(', ')}.`);
  }
  const kind = input.kind as DkbPluginScaffoldKind;
  const name = input.id.split('/')[1]!;
  const target = path.resolve(input.directory ?? name);
  const existing = await fs.readdir(target).catch(() => null);
  if (existing && existing.length > 0) throw new DkbError(`Plugin destination is not empty: ${target}`);

  const cliPackage = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  const sdkVersion = cliPackage.dependencies['@sjshovan/dkb-pipeline'];
  if (!sdkVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(sdkVersion)) {
    throw new DkbError('The CLI must declare an exact SDK package version before generating a plugin. Reinstall the matching DKB CLI distribution.');
  }

  await fs.mkdir(target, { recursive: true });
  const files = ['plugin.mjs', 'options.mjs', 'plugin.test.mjs', 'tsconfig.json', 'package.json', 'README.md'];
  const contents = {
    'plugin.mjs': pluginSource(input.id, kind),
    'options.mjs': optionsSource(kind),
    'plugin.test.mjs': testSource(),
    'tsconfig.json': `${JSON.stringify(typecheckDocument(), null, 2)}\n`,
    'package.json': `${JSON.stringify(packageDocument(input.id, sdkVersion), null, 2)}\n`,
    'README.md': readmeSource(input.id, kind),
  };
  await Promise.all(files.map((file) => fs.writeFile(path.join(target, file), contents[file as keyof typeof contents], { encoding: 'utf8', flag: 'wx' })));
  return { id: input.id, version: '1.0.0', kind, path: target, files };
}

function pluginSource(id: string, kind: DkbPluginScaffoldKind): string {
  const scopeImport = kind === 'retrieval' ? `import { evidenceMatchesRetrievalScope } from '@sjshovan/dkb-pipeline/validation.js';\n` : '';
  const header = `import fs from 'node:fs/promises';\nimport path from 'node:path';\nimport crypto from 'node:crypto';\nimport { ${definitionHelper(kind)} } from '@sjshovan/dkb-pipeline/sdk.js';\n${scopeImport}import { optionsSchema } from './options.mjs';\n\nexport const apiVersion = 3;\nexport const id = ${JSON.stringify(id)};\nexport const version = '1.0.0';\nexport { optionsSchema };\n\n/** @param {import('@sjshovan/dkb-pipeline').DkbPluginSetupContext} context */\n`;
  return `${header}${implementation(kind)}\n`;
}

function definitionHelper(kind: DkbPluginScaffoldKind): string {
  return ({ evidence: 'defineEvidenceProvider', parser: 'defineParserProvider', chunker: 'defineChunkerProvider', embedding: 'defineEmbeddingProvider', 'packaged-index': 'definePackagedIndexProvider', 'managed-index': 'defineManagedIndexProvider', retrieval: 'defineRetrievalProvider', processor: 'defineProcessor', observer: 'defineQueryObserver' } as const)[kind];
}

function implementation(kind: DkbPluginScaffoldKind): string {
  if (kind === 'evidence') return `export function setup(context) {\n  context.registerProvider(defineEvidenceProvider({\n    kind: 'evidence',\n    async compile({ dkb, signal }) {\n      const files = await textFiles(dkb.root);\n      /** @type {import('@sjshovan/dkb-pipeline').DkbPipelineRecord[]} */\n      const records = [];\n      for (const relativePath of files) {\n        signal?.throwIfAborted();\n        const source = await fs.readFile(path.join(dkb.root, relativePath), { signal });\n        const text = new TextDecoder('utf-8', { fatal: true }).decode(source);\n        if (!text.trim()) continue;\n        const sourceHash = 'sha256:' + crypto.createHash('sha256').update(source).digest('hex');\n        records.push({ id: relativePath, chunkId: relativePath, text, provenance: { assetId: relativePath, storeId: 'filesystem', sourceType: 'filesystem', locator: { path: relativePath, chunk: 0 }, assetLocator: { path: relativePath }, title: relativePath, sourceHash, updatedAt: '1970-01-01T00:00:00.000Z', chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length }, metadata: {} });\n      }\n      return { records, receipt: { build: { records: records.length } } };\n    },\n  }));\n}\n\n/** @param {string} root @returns {Promise<string[]>} */\nasync function textFiles(root) {\n  /** @type {string[]} */\n  const output = [];\n  /** @param {string} directory @param {string} prefix @returns {Promise<void>} */\n  async function visit(directory, prefix = '') {\n    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {\n      if (entry.name === '.dkb' || entry.name === 'node_modules' || entry.name === '.git') continue;\n      const relative = prefix ? prefix + '/' + entry.name : entry.name;\n      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);\n      else if (/\\.(md|mdx|txt|json|ya?ml)$/iu.test(entry.name) && entry.name !== 'dkb.json') output.push(relative);\n    }\n  }\n  await visit(root);\n  return output.sort();\n}`;
  if (kind === 'parser') return parserSource();
  if (kind === 'chunker') return chunkerSource();
  if (kind === 'embedding') return `export function setup(context) {\n  const dimensions = Number(context.options.dimensions ?? 8);\n  /** @param {string} text @returns {number[]} */\n  const embed = (text) => { const vector = Array(dimensions).fill(0); for (let index = 0; index < text.length; index++) { const slot = index % dimensions; vector[slot] = (vector[slot] ?? 0) + text.charCodeAt(index) / 255; } return vector; };\n  context.registerProvider(defineEmbeddingProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(embed); }, async embedQuery({ text }) { return embed(text); }, compatibility() { return { embeddingSpace: id + '@' + version, dimensions, metric: 'cosine', normalized: false }; }, async health() { return { ok: true }; } }));\n}`;
  if (kind === 'packaged-index') return packagedIndexSource();
  if (kind === 'managed-index') return managedIndexSource();
  if (kind === 'retrieval') return `export function setup(context) {\n  context.registerProvider(defineRetrievalProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'none' }, openRuntime({ evidence }) { return { providerId: id, protocol: 'dkb.evidence.v1', async search({ query, limit, scope }) { const tokens = query.toLowerCase().split(/\\W+/u).filter(Boolean); const hits = evidence.records.filter((record) => evidenceMatchesRetrievalScope(record, scope)).map((record) => ({ evidenceId: record.evidenceId, score: tokens.filter((token) => record.text.toLowerCase().includes(token)).length, channels: ['lexical'] })).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, limit); return { hits, trace: { implementation: id } }; }, async close() {} }; } }));\n}`;
  if (kind === 'processor') return `export function setup(context) {\n  context.registerProcessor(defineProcessor({ id, version, stage: 'record', mutate(record) { return { ...record, metadata: { ...record.metadata, processedBy: id } }; } }));\n}`;
  return `export function setup(context) {\n  context.registerQueryObserver(defineQueryObserver({ id, version, async observe(event) { process.stderr.write('[dkb-query] ' + event.eventId + '\\n'); } }));\n}`;
}

function packagedIndexSource(): string {
  return `export function setup(context) {
  let disposed = false;
  const assertOpen = () => { if (disposed) throw new Error('Index provider is disposed'); };
  /** @param {Parameters<import('@sjshovan/dkb-pipeline').DkbPackagedIndexProvider['openRuntime']>[0]} input */
  async function selectedIndexes(input) {
    assertOpen();
    const entries = [];
    for (const build of input.packages) {
      const data = await readIndex({ ...input, dkb: build.dkb, artifactsRoot: build.artifactsRoot });
      entries.push({ indexId: indexKey({ ...input, dkb: build.dkb }), data });
    }
    assertOpen();
    return entries;
  }
  context.registerProvider(definePackagedIndexProvider({ kind: 'index', mode: 'packaged', format: indexFormat, capabilities: { vectors: 'none' },
    async compilePackage(input) { assertOpen(); return writeIndex(input); },
    async validatePackage(input) { assertOpen(); return { documentCount: (await readIndex(input)).records.length }; },
    async verifyRuntime(input) { const entries = await selectedIndexes(input); return { indexId: id, documentCount: entries.reduce((sum, entry) => sum + entry.data.records.length, 0), status: 'ready' }; },
    async openRuntime(input) { return searchRuntime('packaged', await selectedIndexes(input), assertOpen); },
    dispose() { disposed = true; },
  }));
}
${indexSourceHelpers('acme.lexical-index.v1')}`;
}

function managedIndexSource(): string {
  return `export function setup(context) {
  // Educational process-local state: a new setup has no installed indexes.
  // A production managed provider must replace this map with durable storage.
  /** @type {Map<string, {scope:string, data:StoredIndex}>} */
  const installed = new Map();
  const storageId = crypto.randomUUID();
  let disposed = false;
  const assertOpen = () => { if (disposed) throw new Error('Index provider is disposed'); };
  /** @param {Parameters<import('@sjshovan/dkb-pipeline').DkbManagedIndexProvider['openRuntime']>[0]} input */
  async function selectedIndexes(input) {
    assertOpen();
    const entries = [];
    for (const build of input.packages) {
      const prepared = { ...input, dkb: build.dkb, artifactsRoot: build.artifactsRoot };
      const expected = await readIndex(prepared);
      const indexId = indexKey(prepared);
      const current = installed.get(indexId);
      if (!current || current.data.digest !== expected.digest) throw new Error('Managed index is missing or differs from its artifact; install it in this provider setup first');
      entries.push({ indexId, data: current.data });
    }
    assertOpen();
    return entries;
  }
  context.registerProvider(defineManagedIndexProvider({ kind: 'index', mode: 'managed', format: indexFormat, capabilities: { vectors: 'none' },
    storageIdentity() { return 'sha256:' + fingerprint(['educational-process-local', storageId]); },
    async compilePackage(input) { assertOpen(); return writeIndex(input); },
    async validatePackage(input) { assertOpen(); return { documentCount: (await readIndex(input)).records.length }; },
    async installPackage(input) {
      assertOpen();
      const data = await readIndex(input);
      assertOpen();
      const indexId = indexKey(input);
      const previous = installed.get(indexId);
      if (previous && previous.data.digest !== data.digest) throw new Error('An existing managed index has different records for the same Library, package version and compatibility; refusing overwrite');
      if (!previous) installed.set(indexId, { scope: libraryKey(input), data });
      return { indexId, documentCount: data.records.length, status: 'ready', created: !previous };
    },
    async discardPackage(input) {
      assertOpen();
      if (input.indexId !== indexKey(input)) throw new Error('Index does not belong to this exact prepared build');
      const data = await readIndex(input);
      assertOpen();
      const current = installed.get(input.indexId);
      if (current && current.data.digest !== data.digest) throw new Error('Managed index records changed; refusing rollback of a different build');
      installed.delete(input.indexId);
      return { indexId: input.indexId, documentCount: 0, status: 'removed' };
    },
    async uninstallPackage(input) {
      assertOpen(); input.signal?.throwIfAborted();
      const scope = libraryKey(input);
      for (const [key, value] of installed) {
        if (value.scope === scope && value.data.packageId === input.packageId && value.data.packageVersion === input.packageVersion) installed.delete(key);
      }
      return { indexId: fingerprint([scope, input.packageId, input.packageVersion]), documentCount: 0, status: 'removed' };
    },
    async verifyRuntime(input) { const entries = await selectedIndexes(input); return { indexId: id, documentCount: entries.reduce((sum, entry) => sum + entry.data.records.length, 0), status: 'ready' }; },
    async openRuntime(input) { return searchRuntime('managed', await selectedIndexes(input), assertOpen); },
    dispose() { disposed = true; installed.clear(); },
  }));
}
${indexSourceHelpers('acme.managed-index.v1')}`;
}

function indexSourceHelpers(format: string): string {
  return `
const indexFormat = ${JSON.stringify(format)};
const maxRecords = 10_000;
const maxArtifactBytes = 8 * 1024 * 1024;
/** @typedef {{id:string, text:string}} LexicalRecord */
/** @typedef {{packageId:string, packageVersion:string, records:LexicalRecord[], digest:string}} StoredIndex */
/** @typedef {{indexId:string, data:StoredIndex}} RuntimeIndex */

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  const serialized = JSON.stringify(value);
  if (serialized === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Index identity must contain JSON values');
  return serialized;
}
/** @param {unknown} value */
function fingerprint(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
/** @param {{libraryRoot:string, libraryId:string}} input */
function libraryKey(input) { return fingerprint([path.resolve(input.libraryRoot), input.libraryId]); }
/** @param {{libraryRoot:string, libraryId:string, dkb:import('@sjshovan/dkb-pipeline').DkbRuntimePackageBuild['dkb'], compatibility:Record<string,import('@sjshovan/dkb-pipeline').DkbJsonValue>}} input */
function indexKey(input) { return fingerprint([libraryKey(input), input.dkb.manifest.id, input.dkb.manifest.version, input.compatibility]); }
/** @param {string} left @param {string} right */
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

/** @param {unknown} value @returns {LexicalRecord[]} */
function checkedRecords(value) {
  if (!Array.isArray(value) || value.length > maxRecords) throw new Error('The educational index supports at most 10000 Evidence records');
  const seen = new Set();
  let bytes = 0;
  const records = value.map((record) => {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id.trim()
      || typeof record.text !== 'string' || !record.text.trim() || seen.has(record.id)) throw new Error('Invalid or duplicate lexical Evidence record');
    seen.add(record.id);
    bytes += Buffer.byteLength(record.id) + Buffer.byteLength(record.text);
    if (bytes > maxArtifactBytes / 2) throw new Error('The educational index exceeds its bounded text budget');
    return { id: record.id, text: record.text };
  });
  return records.sort((a, b) => compare(a.id, b.id));
}
/** @param {Parameters<import('@sjshovan/dkb-pipeline').DkbPackagedIndexProvider['compilePackage']>[0]} input */
async function writeIndex(input) {
  input.signal?.throwIfAborted();
  if (input.compiled.vectors.length) throw new Error('This lexical index does not use vectors; select a Pipeline without an embedding provider');
  const records = checkedRecords(input.compiled.records);
  const bytes = JSON.stringify({ format: indexFormat, packageId: input.dkb.manifest.id,
    packageVersion: input.dkb.manifest.version, compatibility: fingerprint(input.compatibility), records });
  if (Buffer.byteLength(bytes) > maxArtifactBytes) throw new Error('Lexical artifact exceeds 8 MiB');
  await fs.mkdir(input.artifactsRoot, { recursive: true });
  await fs.writeFile(path.join(input.artifactsRoot, 'lexical.json'), bytes, { flag: 'wx', signal: input.signal });
  return { build: { records: records.length } };
}
/** @param {Parameters<import('@sjshovan/dkb-pipeline').DkbPackagedIndexProvider['validatePackage']>[0]} input @returns {Promise<StoredIndex>} */
async function readIndex(input) {
  input.signal?.throwIfAborted();
  const file = path.join(input.artifactsRoot, 'lexical.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > maxArtifactBytes) throw new Error('Invalid or oversized lexical artifact');
  const bytes = await fs.readFile(file, { signal: input.signal });
  if (bytes.length > maxArtifactBytes) throw new Error('Lexical artifact grew beyond 8 MiB');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || value.format !== indexFormat || value.packageId !== input.dkb.manifest.id
    || value.packageVersion !== input.dkb.manifest.version || value.compatibility !== fingerprint(input.compatibility)) throw new Error('Lexical artifact package or compatibility mismatch');
  const records = checkedRecords(value.records);
  return { packageId: value.packageId, packageVersion: value.packageVersion, records,
    digest: fingerprint([value.packageId, value.packageVersion, value.compatibility, records]) };
}

/** @param {'packaged'|'managed'} mode @param {RuntimeIndex[]} entries @param {()=>void} assertProviderOpen @returns {import('@sjshovan/dkb-pipeline').DkbIndexRuntime} */
function searchRuntime(mode, entries, assertProviderOpen) {
  const records = entries.flatMap((entry) => entry.data.records);
  if (records.length > maxRecords || new Set(records.map((record) => record.id)).size !== records.length) throw new Error('Runtime exceeds the educational index record limit or repeats an Evidence ID');
  let closed = false;
  return {
    providerId: id, mode, format: indexFormat,
    packages: entries.map((entry) => ({ id: entry.data.packageId, version: entry.data.packageVersion,
      indexId: entry.indexId, documentCount: entry.data.records.length })),
    async search(query, limit, signal) {
      assertProviderOpen(); signal?.throwIfAborted();
      if (closed) throw new Error('Index Runtime is closed');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || query.length > 4096) throw new Error('Search requires limit 1-1000 and at most 4096 query characters');
      const tokens = [...new Set(query.toLowerCase().split(/\\W+/u).filter(Boolean))].slice(0, 64);
      const hits = [];
      for (const [ordinal, record] of records.entries()) {
        if (ordinal % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
        assertProviderOpen(); signal?.throwIfAborted();
        if (closed) throw new Error('Index Runtime is closed');
        const text = record.text.toLowerCase();
        const score = tokens.filter((token) => text.includes(token)).length;
        if (score > 0) hits.push({ id: record.id, score });
      }
      return { hits: hits.sort((a, b) => b.score - a.score || compare(a.id, b.id)).slice(0, limit),
        trace: { implementation: id, channel: 'lexical', documents: records.length } };
    },
    close() { closed = true; records.length = 0; entries.length = 0; },
  };
}
`;
}

function parserSource(): string {
  return `export function setup(context) {
  context.registerProvider(defineParserProvider({ kind: 'parser', async parse({ dkb, signal }) {
    const entries = await fs.readdir(dkb.root, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && /\\.(md|txt)$/iu.test(entry.name));
    /** @type {import('@sjshovan/dkb-pipeline').DkbParsedDocument[]} */
    const documents = [];
    for (const entry of files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      signal?.throwIfAborted();
      const source = await fs.readFile(path.join(dkb.root, entry.name), { signal });
      const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
      if (!text.trim()) continue;
      documents.push({ id: entry.name, path: entry.name, mediaType: 'text/plain', text,
        provenance: { assetId: entry.name, storeId: 'filesystem', sourceType: 'filesystem',
          assetLocator: { path: entry.name }, title: entry.name,
          sourceHash: 'sha256:' + crypto.createHash('sha256').update(source).digest('hex'),
          updatedAt: '1970-01-01T00:00:00.000Z' }, metadata: {} });
    }
    return documents;
  } }));
}`;
}

function chunkerSource(): string {
  return `export function setup(context) {
  context.registerProvider(defineChunkerProvider({ kind: 'chunker', async chunk({ documents, options, signal }) {
    const size = Number(options.chunkSize ?? 1000);
    const overlap = Number(options.overlap ?? 100);
    if (!Number.isInteger(size) || size < 1 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size) throw new Error('chunkSize must be positive and overlap must be smaller than chunkSize');
    const chunks = [];
    for (const document of documents) {
      const text = document.text ?? '';
      for (let start = 0, ordinal = 0; start < text.length; start += size - overlap, ordinal++) {
        signal?.throwIfAborted();
        const end = Math.min(text.length, start + size);
        if (!text.slice(start, end).trim()) continue;
        chunks.push({ id: document.id + ':' + ordinal, documentId: document.id, text: text.slice(start, end),
          provenance: { locator: { path: document.path, chunk: ordinal }, chunkOrdinal: ordinal, chunkStart: start, chunkEnd: end }, metadata: {} });
      }
    }
    return chunks;
  } }));
}`;
}

function optionsSource(kind: DkbPluginScaffoldKind): string {
  const keys = kind === 'embedding' ? ['dimensions'] : kind === 'chunker' ? ['chunkSize', 'overlap'] : [];
  const validate = kind === 'embedding' ? `  const dimensions = 'dimensions' in value ? value.dimensions : 8;
  if (typeof dimensions !== 'number' || !Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 4096) {
    return [{ message: 'dimensions must be an integer from 1 through 4096', path: ['dimensions'] }];
  }
  return { dimensions };` : kind === 'chunker' ? `  const chunkSize = 'chunkSize' in value ? value.chunkSize : 1000;
  const overlap = 'overlap' in value ? value.overlap : 100;
  if (typeof chunkSize !== 'number' || !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 1000000) {
    return [{ message: 'chunkSize must be an integer from 1 through 1000000', path: ['chunkSize'] }];
  }
  if (typeof overlap !== 'number' || !Number.isSafeInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    return [{ message: 'overlap must be a nonnegative integer smaller than chunkSize', path: ['overlap'] }];
  }
  return { chunkSize, overlap };` : '  return {};';
  return `import { defineOptionsSchema } from '@sjshovan/dkb-pipeline/sdk.js';

export const optionsSchema = defineOptionsSchema((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return [{ message: 'Options must be a plain object' }];
  }
  /** @type {string[]} */
  const allowed = ${JSON.stringify(keys)};
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) return [{ message: 'Unknown option: ' + unknown.join(', ') }];
${validate}
}, 'generated-dkb-plugin');
`;
}

function testSource(): string {
  return `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport * as plugin from './plugin.mjs';\nimport { runPluginConformance } from '@sjshovan/dkb-pipeline/testing.js';\n\ntest('passes DKB plugin conformance', async () => {\n  const report = await runPluginConformance(plugin);\n  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));\n});\n`;
}

function typecheckDocument() {
  return {
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      strict: true,
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2023'],
      types: ['node'],
      skipLibCheck: true,
    },
    include: ['plugin.mjs', 'options.mjs', 'plugin.test.mjs'],
  };
}

function packageDocument(id: string, sdkVersion: string) {
  return { name: id, version: '1.0.0', private: true, type: 'module', files: ['plugin.mjs', 'options.mjs', 'README.md'], scripts: { check: 'tsc --project tsconfig.json', test: 'npm run check && node --test plugin.test.mjs' }, peerDependencies: { '@sjshovan/dkb-pipeline': `^${sdkVersion}` }, devDependencies: { '@types/node': '^22.15.0', typescript: '^5.9.2' }, engines: { node: '>=22.15.0' } };
}

function readmeSource(id: string, kind: DkbPluginScaffoldKind): string {
  return `# ${id}\n\nDKB plugin API v3 ${kind} provider.\n\n## Install and verify\n\n\`\`\`text\nnpm install\nnpm run check\nnpm test\ndkb plugin verify .\ndkb plugin test .\n\`\`\`\n\nOnly files in the package allowlist are distributable. DKB knowledge archives never include plugin code or configuration.\n`;
}
