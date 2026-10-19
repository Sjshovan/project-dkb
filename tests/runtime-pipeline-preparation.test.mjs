import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createQueryFixture, writeJson } from './runtime-query-fixture.mjs';
import { inspectRuntimePipelines, validateRuntimePipelinePreparation } from '@sjshovan/dkb-runtime/runtime/pipelinePreparation.js';
import { switchRuntimePipelineFromRegistry } from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { dockerRegistryTransportUrl, validateRegistryTransportUrl } from '@sjshovan/dkb-registry-client/config.js';

const runtime = { distribution: { id: '@test/preparation', version: '1.0.0', defaults: { format: 'dkb.config.v2' }, plugins: [], services: [] } };
const activationPath = fixture => path.join(fixture.runtimeRoot, '.dkb/runtime-activation.lock.json');
const inspect = fixture => inspectRuntimePipelines(fixture.runtimeRoot, runtime);
const use = (fixture, expected) => switchRuntimePipelineFromRegistry({ runtime, stateRoot: fixture.runtimeRoot, target: 'fixture', expected });

test('owner catalog supplies a path-free checked preparation and separates missing from invalid builds', async t => {
  const fixture = await createQueryFixture(t);
  const current = (await inspect(fixture)).targets[0];
  assert.equal(current.coverage.packages[0].status, 'ready');
  assert.deepEqual(validateRuntimePipelinePreparation(current.preparation), current.preparation);
  assert.equal(JSON.stringify(current.preparation).includes(fixture.root), false);
  const configPath = path.join(fixture.libraryRoot, '.dkb/config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.targets.second = { ...config.targets.fixture, options: { '@test/recovery': { recipe: 'other' } } };
  await writeJson(configPath, config);
  const catalog = await inspect(fixture);
  assert.equal(catalog.targets.find(x => x.name === 'second').coverage.packages[0].status, 'missing');
  const { listPackageBuilds } = await import('@sjshovan/dkb-library/builds.js');
  const builds = await listPackageBuilds(fixture.packageRoot);
  await fs.appendFile(path.join(builds.retrieval[0].path, 'artifacts/index.json'), 'corrupt');
  assert.equal((await inspect(fixture)).targets.find(x => x.name === 'fixture').coverage.packages[0].status, 'invalid');
});

test('Pipeline preparation rejects a changed Library before replacing activation', async t => {
  const fixture = await createQueryFixture(t);
  const expected = (await inspect(fixture)).targets[0].preparation;
  const previous = await fs.readFile(activationPath(fixture));
  const lock = JSON.parse(await fs.readFile(path.join(fixture.libraryRoot, 'dkb-lock.json'), 'utf8'));
  lock.generation++;
  await applyLibraryLock(fixture.libraryRoot, lock);
  await assert.rejects(use(fixture, expected), { code: 'runtime_pipeline_conflict' });
  assert.deepEqual(await fs.readFile(activationPath(fixture)), previous);
});

test('Pipeline preparation rejects superseded selection and provider recipe drift', async t => {
  const fixture = await createQueryFixture(t);
  const expected = (await inspect(fixture)).targets[0].preparation;
  await use(fixture, expected);
  const previous = await fs.readFile(activationPath(fixture));
  await assert.rejects(use(fixture, expected), { code: 'runtime_pipeline_conflict' });
  assert.deepEqual(await fs.readFile(activationPath(fixture)), previous);
  const fresh = (await inspect(fixture)).targets[0].preparation;
  const configPath = path.join(fixture.libraryRoot, '.dkb/config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.targets.fixture.options = { '@test/recovery': { changed: true } };
  await writeJson(configPath, config);
  await assert.rejects(use(fixture, fresh), { code: 'runtime_pipeline_conflict' });
  assert.deepEqual(await fs.readFile(activationPath(fixture)), previous);
});

test('preparation rejects malformed, foreign and wrong-target receipts without changing activation', async t => {
  const fixture = await createQueryFixture(t);
  const expected = (await inspect(fixture)).targets[0].preparation;
  const previous = await fs.readFile(activationPath(fixture));
  for (const value of [null, {}, { ...expected, format: 'old' }, { ...expected, hostPath: '/private' },
    { ...expected, libraryDigest: 'bad' }, { ...expected, runtimeId: 'foreign' }, { ...expected, target: 'second' }]) {
    await assert.rejects(use(fixture, value), error => ['runtime_pipeline_conflict', 'runtime_pipeline_preparation_invalid'].includes(error.code));
  }
  assert.deepEqual(await fs.readFile(activationPath(fixture)), previous);
});

test('catalog observation cannot repair an interrupted Runtime selection', async t => {
  const fixture = await createQueryFixture(t);
  const journal = path.join(fixture.runtimeRoot, '.dkb/runtime-selection.transaction.json');
  await fs.writeFile(journal, 'interrupted');
  const previous = await fs.readFile(activationPath(fixture));
  await assert.rejects(inspect(fixture), { code: 'runtime_busy' });
  assert.equal(await fs.readFile(journal, 'utf8'), 'interrupted');
  assert.deepEqual(await fs.readFile(activationPath(fixture)), previous);
});

test('per-origin Docker transport preserves authority, scheme, port and path without exposing credentials', () => {
  const origin = 'https://127.0.0.1:8443/registry';
  assert.equal(dockerRegistryTransportUrl(origin), 'https://host.docker.internal:8443/registry');
  assert.equal(validateRegistryTransportUrl(origin, origin), origin);
  assert.equal(validateRegistryTransportUrl(origin, dockerRegistryTransportUrl(origin)), dockerRegistryTransportUrl(origin));
  for (const transport of ['http://host.docker.internal:8443/registry', 'https://host.docker.internal:8444/registry',
    'https://host.docker.internal:8443/other', 'https://other.example/registry', 'https://private:secret@127.0.0.1:8443/registry',
    origin + '?secret=value', origin + '#fragment']) {
    assert.throws(() => validateRegistryTransportUrl(origin, transport), error => error.code === 'registry_transport_invalid' && !error.message.includes('secret'));
  }
});
