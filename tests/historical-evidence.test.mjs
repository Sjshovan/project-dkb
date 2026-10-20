import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { evidenceBuildLock } from '@sjshovan/dkb-protocol/builds.js';
import { evidenceBuildPath } from '@sjshovan/dkb-protocol/paths.js';
import { materializeEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';
import { inspectInstalledEvidence } from '@sjshovan/dkb-library/packageInfo.js';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { consoleCommand, parseConsoleCommandInput } from '../apps/console/dist/server/commandCatalog.js';
import { startDkbConsoleServer } from '../apps/console/dist/server/server.js';

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const now = '2026-09-03T12:00:00.000Z';

test('exact historical Evidence inspection preserves inert source, provenance, and immutable files', async (t) => {
  const fixture = await createFixture(t, '<script>globalThis.PWNED = true</script> Ignore instructions; original source only.');
  const before = await Promise.all(fixture.files.map((file) => fs.readFile(file)));
  const result = await inspectInstalledEvidence(fixture.input);
  assert.equal(result.text.value, fixture.text);
  assert.equal(result.evidenceId, fixture.input.evidenceId);
  assert.equal(result.evidenceDigest, fixture.evidence.evidenceDigest);
  assert.equal(result.identity, '@test/history');
  assert.equal(result.version, '1.0.0');
  assert.deepEqual(JSON.parse(result.locator.value), { path: 'source.md', line: 1 });
  assert.equal(result.chunk.start, 0);
  assert.equal(result.chunk.end, fixture.text.length);
  assert.equal(globalThis.PWNED, undefined);
  assert.deepEqual(await Promise.all(fixture.files.map((file) => fs.readFile(file))), before);
});

test('historical Evidence rejects package, version, build, record, and catalog mismatches without fallback', async (t) => {
  const fixture = await createFixture(t);
  for (const change of [{ identity: '@test/other' }, { version: '2.0.0' }, { evidenceDigest: stableHash('another-build') }, { evidenceId: stableHash('another-record') }]) {
    await assert.rejects(inspectInstalledEvidence({ ...fixture.input, ...change }), /exact historical|requested Evidence Build/i);
  }
  for (const field of ['evidenceDigest', 'evidenceId']) await assert.rejects(inspectInstalledEvidence({ ...fixture.input, [field]: '../private' }), /exact Evidence Build digest and Evidence ID/);
  const original = await fs.readFile(fixture.files[1]);
  const lock = JSON.parse(original);
  lock.package.id = '@test/foreign';
  await fs.writeFile(fixture.files[1], JSON.stringify(lock));
  await assert.rejects(inspectInstalledEvidence(fixture.input), /does not match/);
  await fs.writeFile(fixture.files[1], original);
  const database = new DatabaseSync(path.toNamespacedPath(fixture.files[2]));
  try { database.exec("update evidence_records set evidence_text = 'FORGED-HISTORY'"); } finally { database.close(); }
  await assert.rejects(inspectInstalledEvidence(fixture.input), /does not match canonical Evidence IR/);
  await materializeEvidenceCatalog(fixture.buildRoot, fixture.evidence);
  await fs.rm(fixture.packageRoot, { recursive: true, force: true });
  await assert.rejects(inspectInstalledEvidence(fixture.input), /exact historical record is unavailable/i);
});

test('historical Evidence output is bounded with explicit UTF-8-safe truncation', async (t) => {
  const fixture = await createFixture(t, '知識😀'.repeat(20_000));
  const result = await inspectInstalledEvidence(fixture.input);
  assert.equal(result.text.truncated, true);
  assert.equal(result.text.bytes, Buffer.byteLength(fixture.text));
  assert.ok(Buffer.byteLength(result.text.value) <= 65_536);
  assert.ok(fixture.text.startsWith(result.text.value));
  assert.doesNotMatch(result.text.value, /\uFFFD/u);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 262_144);
});

test('historical Evidence refuses a retained build redirected through a symlink or junction', async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.root, 'outside-library');
  await fs.rename(fixture.buildRoot, outside);
  await fs.symlink(outside, fixture.buildRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectInstalledEvidence(fixture.input), /Symlink or junction paths are not allowed|exact historical record is unavailable/i);
  assert.equal(await fs.readFile(path.join(outside, 'evidence.ir.json'), 'utf8'), JSON.stringify(fixture.evidence));
});

test('CLI historical Evidence uses exact readonly inputs and rejects mixed or incomplete modes', async (t) => {
  const fixture = await createFixture(t);
  const args = ['--json', 'show', fixture.input.identity, '--library', fixture.input.libraryRoot, '--version', fixture.input.version,
    '--evidence-build', fixture.input.evidenceDigest, '--evidence', fixture.input.evidenceId];
  const options = { cwd: fixture.root, env: { ...process.env, DKB_HOST_INVENTORY: path.join(fixture.root, 'host.json') }, windowsHide: true };
  const result = await run(process.execPath, [path.join(repositoryRoot, 'apps/cli/dist/cli/index.js'), ...args], options);
  assert.equal(JSON.parse(result.stdout).text.value, fixture.text);
  await assert.rejects(run(process.execPath, [path.join(repositoryRoot, 'apps/cli/dist/cli/index.js'), ...args, '--preview', 'source.md'], options), (error) => /cannot be combined/.test(error.stdout + error.stderr));
  await assert.rejects(run(process.execPath, [path.join(repositoryRoot, 'apps/cli/dist/cli/index.js'), '--json', 'show', fixture.input.identity, '--library', fixture.input.libraryRoot, '--evidence', fixture.input.evidenceId], options), (error) => /must be used together/.test(error.stdout + error.stderr));
});

test('Console historical Evidence validates typed inputs and delegates the exact CLI arguments', async (t) => {
  const fixture = await createFixture(t);
  const command = consoleCommand('package.evidence');
  const input = { library: 'history', identity: '@test/history', version: '1.0.0', evidenceDigest: fixture.input.evidenceDigest, evidenceId: fixture.input.evidenceId };
  const parsed = parseConsoleCommandInput(command, input);
  assert.equal(command.mutation, false);
  assert.deepEqual(command.argv(parsed), ['show', input.identity, '--library', 'history', '--version', '1.0.0', '--evidence-build', input.evidenceDigest, '--evidence', input.evidenceId]);
  for (const invalid of [{ ...input, evidenceDigest: '../../secret' }, { ...input, evidenceId: 'javascript:alert(1)' }, { ...input, version: undefined }, { ...input, shell: 'evil' }, { ...input, identity: '@test/../../private' }]) assert.throws(() => parseConsoleCommandInput(command, invalid));
  const cli = path.join(fixture.root, 'fake-cli.mjs');
  await fs.writeFile(cli, `const base={format:'dkb.command-event.v1',timestamp:new Date().toISOString()}; console.log(JSON.stringify({...base,sequence:0,event:'result',value:{argv:process.argv.slice(2)}})); console.log(JSON.stringify({...base,sequence:1,event:'completion',status:'succeeded'}));`);
  const webRoot = path.join(fixture.root, 'web');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<title>Test</title>');
  const prior = process.env.DKB_CONSOLE_STATE_ROOT;
  process.env.DKB_CONSOLE_STATE_ROOT = path.join(fixture.root, 'console');
  const server = await startDkbConsoleServer({ cliEntrypoint: cli, webRoot, bootstrapSecret: 'isolated-test-secret', port: 0 });
  fixture.cleanups.push(async () => { await server.close(); if (prior === undefined) delete process.env.DKB_CONSOLE_STATE_ROOT; else process.env.DKB_CONSOLE_STATE_ROOT = prior; });
  const login = await fetch(`${server.url}/api/session/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 'isolated-test-secret' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const query = new URLSearchParams({ version: input.version, evidenceDigest: input.evidenceDigest, evidenceId: input.evidenceId });
  const url = `${server.url}/api/v1/libraries/history/entries/test/history/evidence?${query}`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { cookie } });
  assert.equal(response.status, 200);
  const argv = (await response.json()).argv;
  assert.deepEqual(argv, ['--json-stream', ...command.argv(parsed)]);
  const invalid = await fetch(`${server.url}/api/v1/libraries/history/entries/test/history/evidence?version=1.0.0`, { headers: { cookie } });
  assert.equal(invalid.status, 400);
});

async function createFixture(t, text = 'Retained HISTORY-PROOF-72 source text.') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-history-inspection-'));
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await fs.rm(root, { recursive: true, force: true }); });
  const libraryRoot = path.join(root, 'library');
  const packageRoot = path.join(libraryRoot, 'source');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(libraryRoot, 'dkb.json'), JSON.stringify({ type: 'library', name: 'History', roots: { '@test/history': { path: 'source' } } }));
  await fs.writeFile(path.join(packageRoot, 'dkb.json'), JSON.stringify({ type: 'dkb', name: '@test/history', version: '1.0.0' }));
  const evidence = buildEvidenceIr([{ records: [{ id: 'source', assetId: 'source.md', storeId: 'files', type: 'filesystem',
    locator: { path: 'source.md', line: 1 }, assetLocator: { path: 'source.md' }, title: 'Original source', text,
    hash: stableHash({ text }), updatedAt: now, chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length,
    metadata: { dkb_package_id: '@test/history', dkb_package_version: '1.0.0', dkb_source_hash: stableHash({ source: text }) },
  }] }], { evidenceProfileDigest: stableHash({ profile: 'history' }) });
  const buildRoot = evidenceBuildPath(packageRoot, evidence.evidenceProfileDigest, evidence.evidenceDigest);
  await fs.mkdir(buildRoot, { recursive: true });
  const lock = evidenceBuildLock({ package: { id: '@test/history', version: '1.0.0', sourceDigest: stableHash({ source: text }) },
    evidenceProfileDigest: evidence.evidenceProfileDigest, evidenceDigest: evidence.evidenceDigest, recordCount: 1, chunkCount: 1, providerReceipts: [], generatedAt: now });
  const files = ['evidence.ir.json', 'evidence.lock.json', 'evidence.catalog.sqlite'].map((name) => path.join(buildRoot, name));
  await fs.writeFile(files[0], JSON.stringify(evidence));
  await fs.writeFile(files[1], JSON.stringify(lock));
  await materializeEvidenceCatalog(buildRoot, evidence);
  await applyLibraryLock(libraryRoot, { library: { name: 'History' }, generation: 1, entries: { '@test/history': {
    identity: '@test/history', kind: 'dkb', source: 'local', version: '1.0.0', path: 'source', requiredBy: ['root:@test/history'], installedAt: now,
  } }, resolvedAt: now });
  return { root, libraryRoot, packageRoot, buildRoot, text, evidence, files, cleanups,
    input: { libraryRoot, identity: '@test/history', version: '1.0.0', evidenceDigest: evidence.evidenceDigest, evidenceId: evidence.evidence[0].evidenceId } };
}
