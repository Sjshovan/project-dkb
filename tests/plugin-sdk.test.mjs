import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { loadDkb } from '@sjshovan/dkb-protocol/manifest.js';
import { scaffoldPlugin, DKB_PLUGIN_KINDS } from '../apps/cli/dist/providers/scaffolding.js';
import { defineEmbeddingProvider, defineEvidenceProvider, defineParserProvider } from '../packages/pipeline/dist/sdk.js';
import { runPluginConformance, verifyPluginModule } from '../packages/pipeline/dist/testing.js';

const execFileAsync = promisify(execFile);

const optionsSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (value && typeof value === 'object' && value.reject === true) return { issues: [{ message: 'reject is not allowed', path: ['reject'] }] };
      return { value: { dimensions: 2, ...(value ?? {}) } };
    },
  },
};

test('plugin SDK validates defaults and freezes options before setup', async () => {
  let options;
  const verified = await verifyPluginModule({
    apiVersion: 3,
    id: '@test/options',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      options = context.options;
      context.registerQueryObserver({ id: '@test/options', version: '1.0.0', observe() {} });
    },
  });

  assert.deepEqual(options, { dimensions: 2 });
  assert.equal(Object.isFrozen(options), true);
  assert.equal(verified.observers.length, 1);
  await assert.rejects(() => verifyPluginModule({ apiVersion: 3, id: '@test/options', version: '1.0.0', optionsSchema, setup() {} }, { options: { reject: true } }), /reject is not allowed/u);
});

test('plugin SDK canonicalizes external identities and separates profile options from operational settings', async () => {
  const serviceDigest = `sha256:${'a'.repeat(64)}`;
  const imageDigest = `sha256:${'b'.repeat(64)}`;
  const verified = await verifyPluginModule({
    apiVersion: 3,
    id: '@test/identity',
    version: '1.0.0',
    optionsSchema,
    identity: ({ options }) => ({
      profileOptions: { dimensions: options.dimensions },
      external: [{ kind: 'service', name: 'embedding-api', digest: serviceDigest }],
    }),
    setup(context) {
      context.registerProvider(defineEmbeddingProvider({
        kind: 'embedding',
        identity: { external: [{ kind: 'image', name: 'embedding-worker', digest: imageDigest }] },
        async embedDocuments({ texts }) { return texts.map(() => [1, 0]); },
        async embedQuery() { return [1, 0]; },
        compatibility() { return { embeddingSpace: 'identity', dimensions: 2, metric: 'cosine', normalized: true }; },
      }));
    },
  }, { options: { dimensions: 2, timeoutMs: 10_000 } });

  assert.deepEqual(verified.profileOptions, { dimensions: 2 });
  assert.deepEqual(verified.externalDigests, { 'service:embedding-api': serviceDigest });
});

test('schema defaults cannot introduce credentials, even outside profile options or inside arrays', async () => {
  const secret = 'synthetic-secret-never-log';
  for (const defaults of [{ apiKey: secret }, { services: [{ credentials: { value: secret } }] }, { nested: { clientSecret: secret } }]) {
    let setups = 0;
    const definition = {
      apiVersion: 3, id: '@test/default-secret', version: '1.0.0',
      optionsSchema: { '~standard': { version: 1, vendor: 'test', validate() { return { value: { dimensions: 2, ...defaults } }; } } },
      identity: ({ options }) => ({ profileOptions: { dimensions: options.dimensions } }),
      setup() { setups++; },
    };
    await assert.rejects(() => verifyPluginModule(definition), (error) => {
      assert.equal(error.code, 'invalid_plugin_options');
      assert.match(error.message, /environment or secret reference/u);
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal(setups, 0);
  }
  const verified = await verifyPluginModule({
    apiVersion: 3, id: '@test/default-reference', version: '1.0.0',
    optionsSchema: { '~standard': { version: 1, vendor: 'test', validate() { return { value: { apiKeyEnv: 'TEST_PLUGIN_API_KEY' } }; } } },
    setup(context) { context.registerQueryObserver({ id: '@test/default-reference', version: '1.0.0', observe() {} }); },
  });
  assert.deepEqual(verified.options, { apiKeyEnv: 'TEST_PLUGIN_API_KEY' });
});

test('plugin SDK rejects raw or secret-bearing external identity values', async () => {
  const base = {
    apiVersion: 3,
    id: '@test/identity',
    version: '1.0.0',
    optionsSchema,
    setup(context) { context.registerQueryObserver({ id: '@test/identity', version: '1.0.0', observe() {} }); },
  };
  await assert.rejects(
    () => verifyPluginModule({ ...base, identity: { external: [{ kind: 'service', name: 'embedding-api', digest: 'bearer-secret' }] } }),
    /lowercase sha256 digest.*raw service.*secret values are not accepted/iu,
  );
  await assert.rejects(
    () => verifyPluginModule({ ...base, identity: { external: [{ kind: 'service', name: 'api-token', digest: `sha256:${'c'.repeat(64)}` }] } }),
    /secret-bearing name/iu,
  );
});

test('conformance rejects malformed Evidence provenance', async () => {
  const report = await runPluginConformance({
    apiVersion: 3,
    id: '@test/evidence',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProvider({
        kind: 'evidence',
        async compile() {
          return { records: [{ id: 'record-1', chunkId: 'chunk-1', text: 'alpha', provenance: { assetId: 'asset-1' }, metadata: {} }], receipt: { build: {} } };
        },
      });
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.checks.find((entry) => entry.name === 'Evidence output and provenance')?.detail ?? '', /provenance/u);
});

function fixtureEvidencePlugin(compile) {
  return {
    apiVersion: 3, id: '@test/fixture-evidence', version: '1.0.0', optionsSchema,
    setup(context) { context.registerProvider(defineEvidenceProvider({ kind: 'evidence', compile })); },
  };
}

async function fixtureEvidenceOutput(dkb) {
  const filename = path.join(dkb.root, 'knowledge.txt');
  const [text, stat] = await Promise.all([fs.readFile(filename, 'utf8'), fs.stat(filename)]);
  return {
    documents: [{ id: 'document-1', path: 'knowledge.txt', mediaType: 'text/plain', text, metadata: {} }],
    chunks: [{ id: 'chunk-1', documentId: 'document-1', text, metadata: {} }],
    records: [{ id: 'record-1', chunkId: 'chunk-1', text, metadata: {}, provenance: {
      assetId: 'asset-1', storeId: 'filesystem', sourceType: 'filesystem', locator: { path: 'knowledge.txt', chunk: 0 },
      assetLocator: { path: 'knowledge.txt' }, title: 'knowledge.txt', sourceHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      updatedAt: stat.mtime.toISOString(), chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length,
    } }],
    receipt: { build: { count: 1 } },
  };
}

test('Evidence conformance creates real editable source and repeats semantic output without comparing timing receipts', async () => {
  let calls = 0;
  let fixtureRoot;
  const report = await runPluginConformance(fixtureEvidencePlugin(async ({ dkb }) => {
    fixtureRoot = dkb.root;
    assert.equal(dkb.manifest.id, '@dkb/conformance');
    assert.equal(JSON.parse(await fs.readFile(path.join(dkb.root, 'dkb.json'), 'utf8')).type, 'dkb');
    const output = await fixtureEvidenceOutput(dkb);
    output.receipt.diagnostics = { elapsedMs: ++calls };
    return output;
  }));
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(calls, 2);
  for (const name of ['Evidence output and provenance', 'Evidence deterministic output', 'evidence cancellation']) {
    assert.equal(report.checks.find((entry) => entry.name === name)?.status, 'passed');
  }
  await assert.rejects(fs.stat(fixtureRoot), { code: 'ENOENT' });
});

test('Evidence conformance fails non-deterministic records for identical source', async () => {
  let calls = 0;
  const report = await runPluginConformance(fixtureEvidencePlugin(async ({ dkb }) => {
    const output = await fixtureEvidenceOutput(dkb);
    output.records[0].text += ` run-${++calls}`;
    return output;
  }));
  assert.equal(report.ok, false);
  assert.match(report.checks.find((entry) => entry.name === 'Evidence deterministic output')?.detail ?? '', /different Evidence records, relationships/u);
});

test('Evidence conformance rejects non-deterministic identity-bearing receipt data', async () => {
  let calls = 0;
  const report = await runPluginConformance(fixtureEvidencePlugin(async ({ dkb }) => {
    const output = await fixtureEvidenceOutput(dkb);
    output.receipt.build.recipeRevision = ++calls;
    return output;
  }));
  assert.equal(report.ok, false);
  assert.match(report.checks.find((entry) => entry.name === 'Evidence deterministic output')?.detail ?? '', /semantic receipt data/u);
});

test('Evidence determinism compares canonical content rather than record ordering', async () => {
  let calls = 0;
  const report = await runPluginConformance(fixtureEvidencePlugin(async ({ dkb }) => {
    const output = await fixtureEvidenceOutput(dkb);
    const second = structuredClone(output.records[0]);
    second.id = 'record-2';
    second.chunkId = 'chunk-2';
    second.provenance.chunkOrdinal = 1;
    second.provenance.locator.chunk = 1;
    output.records.push(second);
    output.chunks.push({ ...output.chunks[0], id: 'chunk-2' });
    if (++calls === 2) {
      output.records.reverse();
      output.chunks.reverse();
    }
    return output;
  }));
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(calls, 2);
});

test('Evidence conformance rejects broken document and record parent relationships', async () => {
  for (const missing of ['document', 'chunk', 'empty-chunks']) {
    const report = await runPluginConformance(fixtureEvidencePlugin(async ({ dkb }) => {
      const output = await fixtureEvidenceOutput(dkb);
      if (missing === 'document') output.chunks[0].documentId = 'absent';
      else if (missing === 'chunk') output.records[0].chunkId = 'absent';
      else output.chunks = [];
      return output;
    }));
    assert.equal(report.ok, false, missing);
    assert.match(report.checks.find((entry) => entry.name === 'Evidence output and provenance')?.detail ?? '', /references unknown (document|chunk)/u, missing);
  }
});

test('source conformance cannot pass by returning no Evidence or parser documents', async () => {
  const evidence = await runPluginConformance(fixtureEvidencePlugin(async () => ({ records: [], receipt: { build: {} } })));
  const parser = await runPluginConformance({
    apiVersion: 3, id: '@test/empty-parser', version: '1.0.0', optionsSchema,
    setup(context) { context.registerProvider(defineParserProvider({ kind: 'parser', async parse() { return []; } })); },
  });
  for (const report of [evidence, parser]) {
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((entry) => entry.status === 'failed' && /--fixture <editable-dkb>.*empty output cannot prove conformance/u.test(entry.detail)));
    assert.ok(!report.checks.some((entry) => entry.status === 'skipped' && /fixture/u.test(entry.detail)));
  }
});

test('parser conformance executes real source and cancellation without a caller fixture', async () => {
  let calls = 0;
  const report = await runPluginConformance({
    apiVersion: 3, id: '@test/fixture-parser', version: '1.0.0', optionsSchema,
    setup(context) { context.registerProvider(defineParserProvider({ kind: 'parser', async parse({ dkb }) {
      calls++;
      const source = await fs.readFile(path.join(dkb.root, 'knowledge.txt'));
      return [{ id: 'document-1', path: 'knowledge.txt', text: source.toString('utf8'),
        provenance: { assetId: 'knowledge.txt', storeId: 'filesystem', sourceType: 'filesystem', assetLocator: { path: 'knowledge.txt' }, title: 'Knowledge', sourceHash: `sha256:${createHash('sha256').update(source).digest('hex')}`, updatedAt: '2026-01-01T00:00:00.000Z' }, metadata: {} }];
    } })); },
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(calls, 1);
  assert.equal(report.checks.find((entry) => entry.name === 'parser cancellation')?.status, 'passed');
  assert.equal(report.checks.find((entry) => entry.name === 'Parser output')?.status, 'passed');
});

test('conformance rejects malformed document and query vectors', async () => {
  const report = await runPluginConformance({
    apiVersion: 3,
    id: '@test/embedding',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProvider({
        kind: 'embedding',
        async embedDocuments({ texts }) { return texts.map(() => [1, Number.NaN]); },
        async embedQuery() { return [1]; },
        compatibility() { return { embeddingSpace: 'test-space', dimensions: 2, metric: 'cosine', normalized: true }; },
      });
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.checks.find((entry) => entry.name === 'Document and query vector compatibility')?.detail ?? '', /finite dimensions/u);
});

test('conformance rejects retrieval hits outside the Evidence catalog', async () => {
  const report = await runPluginConformance({
    apiVersion: 3,
    id: '@test/retrieval',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProvider({
        kind: 'retrieval',
        protocol: 'dkb.evidence.v1',
        capabilities: { vectors: 'none' },
        openRuntime() {
          return { providerId: '@test/retrieval', protocol: 'dkb.evidence.v1', async search() { return { hits: [{ evidenceId: 'unknown', score: 1, channels: ['lexical'] }], trace: {} }; }, close() {} };
        },
      });
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.checks.find((entry) => entry.name === 'Retrieval Runtime and result validation')?.detail ?? '', /unknown Evidence ID/u);
});

test('conformance rejects retrieval hits outside the requested Evidence scope', async () => {
  const report = await runPluginConformance({
    apiVersion: 3,
    id: '@test/retrieval-scope',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProvider({
        kind: 'retrieval',
        protocol: 'dkb.evidence.v1',
        capabilities: { vectors: 'optional' },
        openRuntime() {
          return {
            providerId: '@test/retrieval-scope',
            protocol: 'dkb.evidence.v1',
            async search() {
              return { hits: [{ evidenceId: 'evidence-out-of-scope', score: 1, channels: ['vector'] }], trace: {} };
            },
            close() {},
          };
        },
      });
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.checks.find((entry) => entry.name === 'Retrieval Runtime and result validation')?.detail ?? '', /outside the requested Evidence scope/u);
});

test('conformance protects record provenance', async () => {
  const report = await runPluginConformance({
    apiVersion: 3,
    id: '@test/processor',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProcessor({
        id: '@test/processor',
        version: '1.0.0',
        stage: 'record',
        mutate(record) { return { ...record, provenance: { ...record.provenance, title: 'changed' } }; },
      });
    },
  });
  assert.equal(report.ok, false);
  assert.match(report.checks.find((entry) => entry.name === 'record processor mutation')?.detail ?? '', /protected provenance/u);
});

test('conformance protects processor correlation identities and source paths', async () => {
  const record = await runPluginConformance({
    apiVersion: 3,
    id: '@test/record-identity-processor',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProcessor({
        id: '@test/record-identity-processor',
        version: '1.0.0',
        stage: 'record',
        mutate(value) { return { ...value, id: 'replacement-record' }; },
      });
    },
  });
  const document = await runPluginConformance({
    apiVersion: 3,
    id: '@test/document-identity-processor',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProcessor({
        id: '@test/document-identity-processor',
        version: '1.0.0',
        stage: 'document',
        mutate(value) { return { ...value, path: '../replacement.md' }; },
      });
    },
  });

  assert.equal(record.ok, false);
  assert.match(record.checks.find((entry) => entry.name === 'record processor mutation')?.detail ?? '', /protected record identity/u);
  assert.equal(document.ok, false);
  assert.match(document.checks.find((entry) => entry.name === 'document processor mutation')?.detail ?? '', /portable path|protected document identity/u);
});

test('conformance executes the complete managed index lifecycle', async () => {
  const calls = [];
  const report = await runPluginConformance({
    apiVersion: 3,
    id: '@test/managed-index',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProvider({
        kind: 'index',
        mode: 'managed',
        storageIdentity() { return `sha256:${'a'.repeat(64)}`; },
        format: 'test.managed.v1',
        capabilities: { vectors: 'optional' },
        async compilePackage({ artifactsRoot, compiled, signal }) {
          signal?.throwIfAborted();
          calls.push('compile');
          await fs.writeFile(path.join(artifactsRoot, 'index.json'), JSON.stringify(compiled.records));
          return { build: { count: compiled.records.length } };
        },
        async validatePackage() { calls.push('validate'); return { documentCount: 1 }; },
        async installPackage() { calls.push('install'); return { indexId: 'managed', documentCount: 1, status: 'ready', created: true }; },
        async verifyRuntime() { calls.push('verify'); return { indexId: 'managed', documentCount: 1, status: 'ready' }; },
        async openRuntime({ embedQuery }) {
          calls.push('open');
          assert.deepEqual(await embedQuery('alpha'), [1]);
          return { providerId: '@test/managed-index', mode: 'managed', format: 'test.managed.v1', packages: [], async search() { calls.push('search'); return { hits: [{ id: 'evidence-1', score: 1 }], trace: {} }; }, async close() { calls.push('close'); } };
        },
        async uninstallPackage() { calls.push('uninstall'); return { indexId: 'managed', documentCount: 0, status: 'removed' }; },
        async discardPackage({ indexId }) { calls.push('discard'); assert.equal(indexId, 'managed'); return { indexId, documentCount: 0, status: 'removed' }; },
        async dispose() { calls.push('dispose'); },
      });
    },
  });

  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
  assert.deepEqual(calls, ['compile', 'validate', 'install', 'verify', 'open', 'search', 'close', 'discard', 'uninstall', 'dispose']);
  assert.equal(report.checks.find((entry) => entry.name === 'managed index lifecycle')?.status, 'passed');
  assert.equal(report.checks.find((entry) => entry.name === 'index provider disposal')?.status, 'passed');
});

test('conformance reports index hits outside the Evidence catalog and disposal failures', async () => {
  const report = await runPluginConformance({
    apiVersion: 3,
    id: '@test/broken-index',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProvider({
        kind: 'index',
        mode: 'packaged',
        format: 'test.packaged.v1',
        capabilities: { vectors: 'none' },
        async compilePackage() { return { build: {} }; },
        async validatePackage() { return { documentCount: 1 }; },
        async verifyRuntime() { return { indexId: 'broken', documentCount: 1, status: 'ready' }; },
        async openRuntime() { return { providerId: '@test/broken-index', mode: 'packaged', format: 'test.packaged.v1', packages: [], async search() { return { hits: [{ id: 'unknown', score: 1 }], trace: {} }; }, async close() {} }; },
        async dispose() { throw new Error('disposal failed'); },
      });
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.checks.find((entry) => entry.name === 'packaged index lifecycle')?.detail ?? '', /unknown Evidence ID/u);
  assert.match(report.checks.find((entry) => entry.name === 'index provider disposal')?.detail ?? '', /disposal failed/u);
});

test('conformance requires providers to reject an already-aborted operation', async () => {
  const ignored = await runPluginConformance({
    apiVersion: 3,
    id: '@test/cancellation-ignored',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProvider({
        kind: 'embedding',
        async embedDocuments({ texts }) { return texts.map(() => [1, 0]); },
        async embedQuery() { return [1, 0]; },
        compatibility() { return { embeddingSpace: 'test-space', dimensions: 2, metric: 'cosine', normalized: true }; },
      });
    },
  });
  assert.equal(ignored.ok, false);
  assert.match(ignored.checks.find((entry) => entry.name === 'embedding cancellation')?.detail ?? '', /ignored an already-aborted signal/u);

  const guarded = await runPluginConformance({
    apiVersion: 3,
    id: '@test/cancellation-guarded',
    version: '1.0.0',
    optionsSchema,
    setup(context) {
      context.registerProvider(defineEmbeddingProvider({
        kind: 'embedding',
        async embedDocuments({ texts }) { return texts.map(() => [1, 0]); },
        async embedQuery() { return [1, 0]; },
        compatibility() { return { embeddingSpace: 'test-space', dimensions: 2, metric: 'cosine', normalized: true }; },
      }));
    },
  });
  assert.equal(guarded.ok, true, JSON.stringify(guarded.checks, null, 2));
  assert.equal(guarded.checks.find((entry) => entry.name === 'embedding cancellation')?.status, 'passed');
});

test('every generated provider scaffold passes the public conformance runner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-plugin-scaffolds-'));
  try {
    const packageScope = path.join(root, 'node_modules', '@sjshovan');
    const typesScope = path.join(root, 'node_modules', '@types');
    await fs.mkdir(packageScope, { recursive: true });
    await fs.mkdir(typesScope, { recursive: true });
    await fs.symlink(path.resolve('packages/pipeline'), path.join(packageScope, 'dkb-pipeline'), 'junction');
    await fs.symlink(path.resolve('node_modules/@types/node'), path.join(typesScope, 'node'), 'junction');
    for (const [index, kind] of DKB_PLUGIN_KINDS.entries()) {
      const directory = path.join(root, kind);
      await scaffoldPlugin({ id: `@fixture/plugin-${index}`, kind, directory });
      const generatedPackage = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      const sdkPackage = JSON.parse(await fs.readFile(path.resolve('packages/pipeline/package.json'), 'utf8'));
      assert.equal(generatedPackage.peerDependencies['@sjshovan/dkb-pipeline'], `^${sdkPackage.version}`);
      try {
        await execFileAsync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '--project', path.join(directory, 'tsconfig.json')]);
      } catch (error) {
        assert.fail(`${kind} scaffold typecheck failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
      }
      const plugin = await import(`${pathToFileURL(path.join(directory, 'plugin.mjs')).href}?case=${index}`);
      const invalid = [{ unknown: true }, [], new Date(), null];
      if (kind === 'embedding') invalid.push(...['8', 'bad', 0, -1, 1.5, 4097, Infinity, NaN, null].map((dimensions) => ({ dimensions })));
      if (kind === 'chunker') invalid.push(...[
        { chunkSize: '1000' }, { chunkSize: 0 }, { chunkSize: 1000001 }, { chunkSize: 1.5 },
        { chunkSize: 50 }, { overlap: '100' }, { overlap: -1 }, { overlap: 1000 }, { overlap: 0.5 },
        { overlap: null },
      ]);
      for (const options of invalid) {
        let setupCalled = false;
        // Explicit null is passed directly to the schema: the inspection API's
        // omitted-options convention uses nullish defaults to an empty object.
        if (options === null) {
          assert.ok((await plugin.optionsSchema['~standard'].validate(options)).issues?.length);
          continue;
        }
        await assert.rejects(() => verifyPluginModule({ ...plugin, setup(context) { setupCalled = true; return plugin.setup(context); } }, { options }));
        assert.equal(setupCalled, false, `${kind} executed setup with invalid options`);
      }
      const defaults = await verifyPluginModule(plugin);
      assert.equal(Object.isFrozen(defaults.options), true);
      if (kind === 'embedding') assert.deepEqual(defaults.options, { dimensions: 8 });
      if (kind === 'chunker') assert.deepEqual(defaults.options, { chunkSize: 1000, overlap: 100 });
      for (const provider of defaults.providers) await provider.dispose?.();
      const report = await runPluginConformance(plugin);
      assert.equal(report.ok, true, `${kind}: ${JSON.stringify(report.checks, null, 2)}`);
      assert.ok(!report.checks.some((check) => check.status === 'skipped' && !/health|disposal/u.test(check.name)), `${kind} skipped a required check`);
      if (kind === 'evidence') assert.equal(report.checks.find((check) => check.name === 'Evidence deterministic output')?.status, 'passed');
      if (kind === 'evidence' || kind === 'parser') await assertGeneratedSourceProvenance(plugin, path.join(root, `source-${kind}`), kind);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function assertGeneratedSourceProvenance(plugin, sourceRoot, kind) {
  await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, 'dkb.json'), JSON.stringify({ manifestVersion: 1, type: 'dkb',
    name: '@fixture/byte-source', version: '1.0.0', permissions: { read: true, write: false } }));
  const bytes = Buffer.from('\ufeffalpha beta\r\nSource bytes are independent of host file timestamps.\n');
  const sourceFile = path.join(sourceRoot, 'source.txt');
  await fs.writeFile(sourceFile, bytes);
  const dkb = await loadDkb(sourceRoot);
  const verified = await verifyPluginModule(plugin);
  const provider = verified.providers.find((value) => value.kind === kind);
  const read = () => kind === 'evidence' ? provider.compile({ dkb, options: verified.options }).then((result) => result.records)
    : provider.parse({ dkb, options: verified.options });
  try {
    const first = await read();
    assert.equal(first.length, 1);
    assert.equal(first[0].provenance.sourceHash, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.equal(first[0].provenance.updatedAt, '1970-01-01T00:00:00.000Z');
    const changedTime = new Date('2030-01-01T00:00:00.000Z');
    await fs.utimes(sourceFile, changedTime, changedTime);
    assert.deepEqual(await read(), first, 'source copies with changed host mtimes must preserve Evidence provenance');
    await fs.writeFile(path.join(sourceRoot, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
    await assert.rejects(read, /encoded|encoding|valid/iu, 'invalid UTF-8 must not be silently replaced before source interpretation');
  } finally {
    await provider.dispose?.();
  }
}
