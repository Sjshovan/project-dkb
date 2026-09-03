import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { prepareHostProofContext } from '../scripts/lib/host-proof-composition.mjs';
import { proofStackLibraryRoot } from '../scripts/lib/disposable-stack.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFile = promisify(childProcess.execFile);

test('proof composition uses bounded host image inspection and persists the selected attestation', async (t) => {
  const root = await temporaryRoot(t);
  const inspection = dockerInspection(t);
  const retainedRecipe = DEFAULT_DKB_DISTRIBUTION.defaults.targets['tei-faiss'];
  await fs.mkdir(path.join(root, '.dkb'), { recursive: true });
  await fs.writeFile(path.join(root, '.dkb/config.json'), JSON.stringify({
    format: 'dkb.config.v2',
    targets: {
      retained: retainedRecipe,
      'fastembed-faiss': { options: { '@dkb/evidence-docling-llamaindex': { workers: 2 } } },
    },
  }));
  const composition = await prepareHostProofContext({ root, target: 'fastembed-faiss' });
  assert.equal(composition.contextRoot, root);
  assert.equal(composition.target, 'fastembed-faiss');
  assert.equal(inspection.length, 3);
  const config = JSON.parse(await fs.readFile(path.join(root, '.dkb/config.json'), 'utf8'));
  assert.deepEqual(config.targets.retained, retainedRecipe);
  assert.equal(config.targets['fastembed-faiss'].options['@dkb/evidence-docling-llamaindex'].workers, 2);
  assert.deepEqual(config.targets['fastembed-faiss'].options, composition.targetOptions);
  const selectedIds = ['@dkb/evidence-docling-llamaindex', '@dkb/embedding-fastembed', '@dkb/index-faiss'];
  for (const id of selectedIds) {
    const service = DEFAULT_DKB_DISTRIBUTION.services.find((item) => item.providerId === id);
    assert.equal(composition.targetOptions[id].imageDigest, imageFixtureDigest(service.image));
  }
  const host = await DkbProviderHost.create({ root, target: composition.target, distribution: DEFAULT_DKB_DISTRIBUTION });
  try {
    assert.doesNotThrow(() => host.assertRequiredExternalIdentities());
    for (const id of selectedIds) {
      for (const [key, value] of Object.entries(composition.targetOptions[id])) {
        assert.deepEqual(host.optionsFor(id)[key], value);
      }
    }
  } finally {
    await host.dispose();
  }
  const before = await fs.readFile(path.join(root, '.dkb/config.json'), 'utf8');
  assert.deepEqual(await prepareHostProofContext({ root, target: composition.target }), composition);
  assert.equal(inspection.length, 3, 'existing exact attestations must not be replaced by another image inspection');
  assert.equal(await fs.readFile(path.join(root, '.dkb/config.json'), 'utf8'), before);
});

test('proof composition preserves recipes and fails closed on unresolved or broken identities', async (t) => {
  const root = await temporaryRoot(t);
  const inspection = dockerInspection(t, { status: 1, stdout: '' });
  await assert.rejects(prepareHostProofContext({ root, target: 'default' }), /not available in the local Docker engine/u);
  await assert.rejects(fs.access(path.join(root, '.dkb/config.json')), { code: 'ENOENT' });
  assert.equal(inspection.length, 1);

  const config = {
    format: 'dkb.config.v2',
    activeTarget: 'fastembed-faiss',
    targets: {
      'fastembed-faiss': { options: { '@dkb/evidence-docling-llamaindex': { imageDigest: 'mutable-tag' } } },
      another: DEFAULT_DKB_DISTRIBUTION.defaults.targets['tei-faiss'],
    },
  };
  await fs.mkdir(path.join(root, '.dkb'), { recursive: true });
  await fs.writeFile(path.join(root, '.dkb/config.json'), JSON.stringify(config));
  const original = await fs.readFile(path.join(root, '.dkb/config.json'), 'utf8');
  await assert.rejects(prepareHostProofContext({ root, target: 'fastembed-faiss' }), /will not replace a broken higher-precedence value/u);
  assert.equal(await fs.readFile(path.join(root, '.dkb/config.json'), 'utf8'), original);
  assert.equal(inspection.length, 1);
});

test('proof Library selection follows the Stack Library mount, never Runtime state', () => {
  const stack = path.join(os.tmpdir(), 'dkb-proof-path-fixture');
  assert.equal(proofStackLibraryRoot(stack, {}), path.resolve(stack, 'library'));
  assert.equal(proofStackLibraryRoot(stack, { DKB_LIBRARY_HOST_PATH: '  ' }), path.resolve(stack, 'library'));
  const shared = path.join(os.tmpdir(), 'dkb-shared-library-fixture');
  assert.equal(proofStackLibraryRoot(stack, { DKB_LIBRARY_HOST_PATH: shared }), path.resolve(shared));
  assert.notEqual(proofStackLibraryRoot(stack, {}), path.resolve(stack, 'runtime'));
});

test('service proof and benchmark entry points retain shared host-composition wiring', async () => {
  const scale = await readScript('benchmark-corpus-scale.mjs');
  assert.match(scale, /await prepareHostProofContext\(\{ root, target \}\)/u);
  assert.match(scale, /compileComposeProject\(root, \{ force: true, \.\.\.composition \}\)/u);
  const embedding = await readScript('benchmark-embedding-providers.mjs');
  assert.match(embedding, /compositions\[target\] = await prepareHostProofContext/u);
  assert.match(embedding, /compileRetrievalFromEvidence\(root, evidence, compositions\[target\]\)/u);
  assert.match(embedding, /\.\.\.compositions\['tei-faiss'\]/u);
  const pipeline = await readScript('prove-provider-pipeline.mjs');
  assert.match(pipeline, /async function writePipelineConfig\(root\)[\s\S]*await prepareHostProofContext\(\{ root, target \}\)/u);
  for (const name of ['prove-stack-lifecycle.mjs', 'prove-real-corpus.mjs']) {
    assert.match(await readScript(name), /const libraryRoot = proofStackLibraryRoot\(stackRoot, stackEnvironment\)/u);
  }
});

test('embedding benchmark describes components and cannot claim a whole-system promotion gate', async () => {
  const source = await readScript('benchmark-embedding-providers.mjs');
  assert.match(source, /format: 'dkb\.embedding-benchmark\.v2'/u);
  assert.match(source, /compile: 'Retrieval Build only/u);
  assert.match(source, /query: 'Direct embedding call only/u);
  assert.match(source, /memory: 'Node process RSS plus one sampled embedding container/u);
  assert.match(source, /eligibleForDefaultPromotion: false/u);
  assert.match(source, /promotion: 'not-evaluated:/u);
  assert.match(source, /endToEndRegression: 'not-evaluated:/u);
});

for (const runs of ['1', '2', '3.5', '3oops']) {
  test(`embedding benchmark rejects ${runs} runs before service or temporary resource setup`, async (t) => {
    const root = await temporaryRoot(t);
    await assert.rejects(execFile(process.execPath, [path.join(repositoryRoot, 'scripts/benchmark-embedding-providers.mjs')], {
      cwd: root,
      env: { ...process.env, DKB_BENCHMARK_CORPUS_ROOT: root, DKB_BENCHMARK_RUNS: runs },
      timeout: 20_000,
      windowsHide: true,
    }), (error) => error.code === 1 && /DKB_BENCHMARK_RUNS must be (?:at least 3 valid runs|a positive integer)/u.test(error.stderr));
    assert.deepEqual(await fs.readdir(root), []);
  });
}

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-proof-host-composition-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function dockerInspection(t, failure) {
  const calls = [];
  // Only the process boundary is simulated. Production resolution and parsing
  // run unchanged; this fixture never starts Docker or attests a real image.
  const mocked = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.equal(command, 'docker');
    assert.deepEqual(args.slice(0, 2), ['image', 'inspect']);
    assert.deepEqual(args.slice(3), ['--format', '{{.Id}}']);
    assert.equal(options.timeout, 5_000);
    assert.equal(options.windowsHide, true);
    calls.push(args[2]);
    return failure ?? { status: 0, stdout: `${imageFixtureDigest(args[2])}\n` };
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return calls;
}

function imageFixtureDigest(image) {
  return `sha256:${createHash('sha256').update(`proof-image-inspection-fixture:${image}`).digest('hex')}`;
}

function readScript(name) {
  return fs.readFile(path.join(repositoryRoot, 'scripts', name), 'utf8');
}
