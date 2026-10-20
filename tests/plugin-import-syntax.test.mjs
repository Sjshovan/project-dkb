import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { writeBundledIntegrityReceipt } from '@sjshovan/dkb-pipeline/bundledIntegrity.js';

const id = '@test/import-syntax';
const identity = { apiVersion: 3, id, version: '1.0.0', protocols: [], artifactFormats: [] };
const execute = promisify(execFile);

async function fixture(t, { prefix = '', files = {}, dependencies = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-plugin-import-syntax-'));
  const packageRoot = path.join(root, 'provider');
  const entrypoint = path.join(packageRoot, 'dist/plugin.mjs');
  const probe = `dkb-import-syntax-${randomUUID()}`;
  t.after(async () => { delete globalThis[probe]; await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module', files: ['dist/'], dependencies }));
  await fs.writeFile(entrypoint, [
    `globalThis[${JSON.stringify(probe)}] = true;`,
    prefix,
    'export const PLUGIN = {',
    `apiVersion:3,id:${JSON.stringify(id)},version:'1.0.0',sourceUrl:import.meta.url,integrity:${JSON.stringify(identity)},`,
    "optionsSchema:{'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}},",
    'setup(context) {',
    "context.registerProvider({kind:'evidence',async compile(){return {records:[],receipt:{build:{}}};}});",
    "context.registerProvider({kind:'index',mode:'packaged',format:'test.index.v1',capabilities:{vectors:'none'},async compilePackage(){return null;},async validatePackage(){return {documentCount:0};},async verifyRuntime(){return {indexId:'test',documentCount:0,status:'ready'};},async openRuntime(){return null;}});",
    `context.registerProvider({kind:'retrieval',protocol:'dkb.evidence.v1',capabilities:{vectors:'none'},openRuntime(){return {providerId:${JSON.stringify(id)},protocol:'dkb.evidence.v1',async search(){return {hits:[],trace:{}};},close(){}};}});`,
    '}};',
  ].join('\n'));
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(packageRoot, 'dist', name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
  const options = {
    root: path.join(root, 'runtime'), globalRoot: path.join(root, 'global'),
    distribution: {
      id: '@test/import-distribution', version: '1.0.0', services: [],
      defaults: { format: 'dkb.config.v2', targets: { default: { evidence: id, index: id, retrieval: id } } },
      plugins: [{ id, version: '1.0.0', sourceUrl: pathToFileURL(entrypoint).href, exportName: 'PLUGIN' }],
    },
  };
  return {
    root, packageRoot, entrypoint, probe, options,
    async seal() { await writeBundledIntegrityReceipt({ packageRoot, entrypoint, identity }); },
    async open() {
      await writeBundledIntegrityReceipt({ packageRoot, entrypoint, identity });
      return DkbProviderHost.create(options);
    },
  };
}

test('import inspection ignores stop words, comments, regexes, and inert string/template contents', async (t) => {
  const item = await fixture(t, { prefix: [
    "const words = ['with', 'from', 'the', 'and'];",
    "// import 'comment-only'; require('comment-only');",
    "/* export { value } from 'another-comment'; */",
    `const text = "import 'string-only'; from 'string-only'; require('string-only')";`,
    "const expression = /import\\s+['\"]regexp-only['\"]/;",
    "const template = `export * from 'template-only'; import('template-only')`;",
  ].join('\n') });
  const host = await item.open();
  try { assert.equal(globalThis[item.probe], true); await host.assertCurrent(); } finally { await host.dispose(); }
});

for (const [kind, prefix] of [
  ['static side-effect import', "import /* checked comment */ 'outside';"],
  ['static named import', "import { value } from 'outside';"],
  ['named re-export', "export { value } from 'outside';"],
  ['star re-export', "export * from 'outside';"],
  ['dynamic literal import', "async function unused() { return import /* checked comment */ ('outside'); }"],
  ['literal require', "function unused(require) { return require /* checked comment */ ('outside'); }"],
  ['module require', "function unused(module) { return module.require('outside'); }"],
  ['computed module require', "function unused(module) { return module['require']('outside'); }"],
  ['escaped string literal', String.raw`async function unused() { return import('\x6futside'); }`],
  ['constant template literal', 'async function unused() { return import(`outside`); }'],
  ['template interpolation expression', 'const text = `${false ? await import("outside") : ""}`;'],
]) {
  test(`import inspection rejects an undeclared ${kind} before executing the plugin`, async (t) => {
    const item = await fixture(t, { prefix });
    await assert.rejects(item.open(), /Plugin import outside is not a declared runtime dependency/u);
    assert.equal(globalThis[item.probe], undefined);
  });
}

test('syntax-aware imports preserve literal traversal and shipped-file containment checks', async (t) => {
  const escaped = await fixture(t, { prefix: String.raw`async function unused() { return import('\x2e\x2e/\x2e\x2e/outside.mjs'); }` });
  await assert.rejects(escaped.open(), /relative import .* escapes its package/u);
  assert.equal(globalThis[escaped.probe], undefined);
  const unshipped = await fixture(t, { prefix: 'async function unused() { return import(`../unshipped.mjs`); }' });
  await fs.writeFile(path.join(unshipped.packageRoot, 'unshipped.mjs'), 'export const value = 1;');
  await assert.rejects(unshipped.open(), /outside its integrity receipt file inventory/u);
  assert.equal(globalThis[unshipped.probe], undefined);
});

for (const extension of ['ts', 'mts', 'cts']) {
  test(`native Node ${extension} helpers erase type-only imports but retain actual runtime imports`, async (t) => {
    const commonjs = extension === 'cts';
    const item = await fixture(t, {
      prefix: commonjs ? `import helper from './helper.${extension}'; if (helper.value !== 'from') throw new Error('wrong helper');`
        : `import { value } from './helper.${extension}'; if (value !== 'from') throw new Error('wrong helper');`,
      files: { [`helper.${extension}`]: [
        "import type { Unavailable } from 'erased-type-package';",
        commonjs ? "const fs = require('node:fs');" : "import fs from 'node:fs';",
        "const value: string = 'from';",
        commonjs ? 'module.exports = { value };' : 'export { value };',
      ].join('\n') },
    });
    await item.seal();
    const hostModule = import.meta.resolve('@sjshovan/dkb-pipeline/host.js');
    const script = [
      `import { DkbProviderHost } from ${JSON.stringify(hostModule)};`,
      `const host = await DkbProviderHost.create(${JSON.stringify(item.options)});`,
      `try { if (globalThis[${JSON.stringify(item.probe)}] !== true) throw new Error('TypeScript helper was not executed'); } finally { await host.dispose(); }`,
      'console.log(JSON.stringify({ node: process.version, status: "passed" }));',
    ].join('\n');
    // Node 22.15 exposes native stripping behind this execution flag. The
    // inspection API itself is available without enabling a loader transform.
    const { stdout } = await execute(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { windowsHide: true, timeout: 30_000 });
    assert.deepEqual(JSON.parse(stdout), { node: process.version, status: 'passed' });
    const invalid = await fixture(t, {
      prefix: `import './helper.${extension}';`,
      files: { [`helper.${extension}`]: "import type { Unavailable } from 'erased-type-package';\nasync function unused() { return import('outside'); }" },
    });
    await assert.rejects(invalid.open(), /Plugin import outside is not a declared runtime dependency/u);
    assert.equal(globalThis[invalid.probe], undefined);
  });
}

test('CommonJS helpers keep wrapper syntax and literal require checks', async (t) => {
  const item = await fixture(t, {
    prefix: "import helper from './helper.cjs'; if (helper.value !== 3) throw new Error('wrong helper');",
    files: { 'helper.cjs': "if (false) return; const fs = require('node:fs'); module.exports = { value: 3 };" },
  });
  const host = await item.open();
  try { assert.equal(globalThis[item.probe], true); } finally { await host.dispose(); }
});

test('unsupported TypeScript syntax fails closed instead of skipping import inspection', async (t) => {
  const item = await fixture(t, { prefix: "import './helper.ts';", files: { 'helper.ts': 'enum Mode { A, B }; export const mode = Mode.A;' } });
  await assert.rejects(item.open(), /Cannot inspect imports.*native type stripping/u);
  assert.equal(globalThis[item.probe], undefined);
});

test('computed imports remain trusted operator code, not fabricated literal dependencies', async (t) => {
  const item = await fixture(t, { prefix: "const name = 'node:fs'; async function unused() { return import(name); }" });
  const host = await item.open();
  try { assert.equal(globalThis[item.probe], true); } finally { await host.dispose(); }
});

test('the explicit pinned parser dependency remains inside provider dependency integrity', async (t) => {
  const require = createRequire(import.meta.url);
  const sdk = JSON.parse(await fs.readFile('packages/pipeline/package.json', 'utf8'));
  assert.equal(sdk.dependencies.acorn, '8.18.0');
  const item = await fixture(t, { prefix: "import { parse } from 'acorn'; parse('0', { ecmaVersion: 'latest' });", dependencies: { acorn: sdk.dependencies.acorn } });
  const dependencyRoot = path.join(item.packageRoot, 'node_modules/acorn');
  await fs.cp(path.dirname(require.resolve('acorn/package.json')), dependencyRoot, { recursive: true });
  const host = await item.open();
  try {
    await fs.appendFile(path.join(dependencyRoot, 'dist/acorn.mjs'), '\n// isolated dependency drift fixture\n');
    await assert.rejects(host.assertCurrent(), /changed|drift|restart/iu);
  } finally { await host.dispose(); }
});
