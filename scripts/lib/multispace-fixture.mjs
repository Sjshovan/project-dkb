import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { writeDkbContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { readDkbStack } from '@sjshovan/dkb-cli/dist/stack/context.js';
import { assertRequiredImages, runCompose } from '@sjshovan/dkb-cli/dist/stack/docker.js';
import { prepareHostProofContext } from './host-proof-composition.mjs';

export const CHANGED_EVIDENCE_TARGET = 'proof-plain-evidence';
const evidenceProvider = '@dkb/evidence-docling-llamaindex';

export function multispaceRecipes(initial, alternate) {
  assert.notEqual(initial, alternate, 'multispace proof requires two distinct retrieval recipes');
  const recipes = {};
  for (const name of [initial, alternate]) {
    const recipe = DEFAULT_DKB_DISTRIBUTION.defaults.targets[name];
    assert.ok(recipe, `Unknown bundled proof target ${name}`);
    assert.equal(recipe.evidence, evidenceProvider, 'rich/plain proof requires the bundled Evidence provider');
    recipes[name] = structuredClone(recipe);
    recipes[name].options[evidenceProvider] = {
      ...recipes[name].options[evidenceProvider], richFiles: true, richFileFallback: false,
    };
  }
  assert.deepEqual(recipes[initial].options[evidenceProvider], recipes[alternate].options[evidenceProvider]);
  recipes[CHANGED_EVIDENCE_TARGET] = structuredClone(recipes[alternate]);
  recipes[CHANGED_EVIDENCE_TARGET].options[evidenceProvider].richFiles = false;
  return recipes;
}

export function concurrentRuntimeCompose(source, { initial, runtimeName, port }) {
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  const compose = YAML.parse(source);
  const primary = compose.services['dkb-runtime'];
  const faiss = compose.services['dkb-faiss'];
  assert.ok(primary?.environment && faiss?.environment, 'proof requires the existing Runtime and FAISS services');
  const stateMount = '${DKB_STACK_STATE:?DKB_STACK_STATE is required}/runtime-b:/runtime-b';
  compose.services['dkb-runtime-b'] = {
    ...structuredClone(primary),
    profiles: ['proof-runtime-b'],
    environment: {
      ...primary.environment,
      DKB_RUNTIME_STATE_ROOT: '/runtime-b',
      DKB_RUNTIME_ID: runtimeName,
      DKB_PIPELINE_TARGET: initial,
      DKB_PUBLIC_URL: `http://127.0.0.1:${port}`,
      DKB_MCP_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    },
    volumes: [...primary.volumes.filter((value) => !value.endsWith(':/state')), stateMount],
    ports: [`127.0.0.1:${port}:7331`],
  };
  faiss.volumes.push(stateMount);
  faiss.environment.DKB_FAISS_ALLOWED_ROOTS += ',/runtime-b';
  return compose;
}

export async function prepareMultispaceFixture({ repositoryRoot, stateRoot, stackName, environment, initial, alternate }) {
  const stackRoot = path.join(stateRoot, stackName);
  const targets = multispaceRecipes(initial, alternate);
  const compilerRoot = path.join(stackRoot, 'compiler-context');
  await writeDkbContextConfig(path.join(compilerRoot, '.dkb/config.json'), {
    format: 'dkb.config.v2', activeTarget: initial, targets,
  });
  for (const target of Object.keys(targets)) await prepareHostProofContext({ root: compilerRoot, target });
  const config = JSON.parse(await fs.readFile(path.join(compilerRoot, '.dkb/config.json'), 'utf8'));
  config.activeTarget = initial;
  await writeDkbContextConfig(path.join(compilerRoot, '.dkb/config.json'), config);
  for (const directory of ['runtime', 'runtime-b']) {
    await writeDkbContextConfig(path.join(stackRoot, directory, '.dkb/config.json'), config);
  }
  const port = await availableLoopbackPort();
  const compose = concurrentRuntimeCompose(await fs.readFile(path.join(repositoryRoot, 'deploy/compose.yaml'), 'utf8'), {
    initial, runtimeName: `${stackName}-runtime-b`, port,
  });
  const composePath = path.join(stackRoot, 'proof-compose.yaml');
  await fs.writeFile(composePath, YAML.stringify(compose), 'utf8');
  Object.assign(environment, {
    DKB_COMPILER_ALLOWED_TARGETS: Object.keys(targets).join(','),
    DKB_STACK_COMPOSE_FILE: composePath,
    DKB_PROOF_CHANGED_TARGET: CHANGED_EVIDENCE_TARGET,
    DKB_PROOF_RUNTIME_B_URL: `http://127.0.0.1:${port}`,
  });
}

export function requiredProofServices(targets, recipes) {
  const ids = new Set(targets.flatMap((target) => {
    const base = DEFAULT_DKB_DISTRIBUTION.defaults.targets[target];
    assert.ok(recipes[target] || base, `Missing trusted proof recipe ${target}`);
    const recipe = { ...base, ...recipes[target] };
    return [recipe.evidence, recipe.parser, recipe.chunker, recipe.embedding, recipe.index, recipe.retrieval];
  }));
  return DEFAULT_DKB_DISTRIBUTION.services
    .filter((service) => service.stack?.composeProfile && ids.has(service.providerId))
    .map((service) => service.stack.composeService ?? service.id).sort();
}

// Proof-owned host composition: start the optional services this fixture needs
// explicitly, without teaching product startup to start every advertised recipe.
export async function provisionMultispaceServices({ stackName, targets }) {
  const context = await readDkbStack(DEFAULT_DKB_DISTRIBUTION, stackName);
  const config = JSON.parse(await fs.readFile(path.join(context.root, 'compiler-context/.dkb/config.json'), 'utf8'));
  const names = requiredProofServices(targets, config.targets ?? {});
  const additional = DEFAULT_DKB_DISTRIBUTION.services.filter((service) =>
    names.includes(service.stack?.composeService ?? service.id)
    && !context.requiredServices.some((current) => current.id === service.id));
  const requiredServices = [...context.requiredServices, ...additional];
  const digests = assertRequiredImages({ ...context, requiredServices });
  assertProofImagePins(targets, config.targets, requiredServices, digests);
  if (additional.length) {
    runCompose(context, ['up', '--detach', '--no-deps', '--wait', '--wait-timeout', '240',
      ...additional.map((service) => service.stack.composeService ?? service.id)], false, false, 'all');
  }
}

export function assertProofImagePins(targets, recipes, services, digests) {
  for (const name of targets) {
    const recipe = recipes[name];
    assert.ok(recipe, `Missing trusted proof recipe ${name}`);
    const selected = new Set([recipe.evidence, recipe.parser, recipe.chunker, recipe.embedding, recipe.index, recipe.retrieval]);
    for (const service of services) {
      if (!selected.has(service.providerId)) continue;
      for (const identity of service.providerExternalIdentities ?? []) {
        if (identity.kind !== 'image') continue;
        assert.match(digests[service.id] ?? '', /^sha256:[a-f0-9]{64}$/u);
        assert.equal(recipe.options?.[service.providerId]?.[identity.option], digests[service.id],
          `${name} image identity does not match the actual ${service.id} image selected by Stack Compose`);
      }
    }
  }
}

export function assertRecipeBuildRelationship(initial, alternate, changed) {
  assert.deepEqual(alternate.package, initial.package, 'alternate build changed immutable source identity');
  assert.deepEqual(changed.package, initial.package, 'changed Evidence recipe changed immutable source identity');
  const [source, evidence] = initial.artifacts;
  for (const plan of [alternate, changed]) assert.equal(plan.artifacts[0].receiptHash, source.receiptHash);
  assert.equal(alternate.evidenceProfileDigest, initial.evidenceProfileDigest);
  assert.equal(alternate.evidenceDigest, initial.evidenceDigest);
  assert.equal(alternate.artifacts[1].receiptHash, evidence.receiptHash);
  assert.notEqual(alternate.retrievalProfileDigest, initial.retrievalProfileDigest);
  assert.notEqual(alternate.compatibilityDigest, initial.compatibilityDigest);
  assert.notEqual(alternate.retrievalBuildDigest, initial.retrievalBuildDigest);
  assert.notEqual(changed.evidenceProfileDigest, initial.evidenceProfileDigest);
  assert.notEqual(changed.evidenceDigest, initial.evidenceDigest);
  assert.notEqual(changed.artifacts[1].receiptHash, evidence.receiptHash);
  assert.notEqual(changed.retrievalBuildDigest, alternate.retrievalBuildDigest);
}

export function assertRichEvidence(ir, enabled, evidenceLock) {
  const receipt = evidenceLock.providerReceipts.find((entry) => entry.kind === 'evidence' && entry.providerId === evidenceProvider);
  assert.ok(receipt, 'missing signed Evidence execution receipt');
  assert.equal(receipt.build.evidenceOptions.richFiles, enabled);
  assert.equal(receipt.build.evidenceOptions.richFileFallback, false, 'proof must disable parser fallback explicitly');
  const records = ir.evidence.filter((record) => record.assetLocator.path === 'sources/feeding-table.html');
  assert.ok(records.length, 'HTML table did not produce canonical Evidence');
  assert.ok(records.some((record) => record.text.includes('TABLE-DENSE-46')));
  if (enabled) {
    assert.ok(records.some((record) => record.locator.tableRefs?.some((ref) => ref.startsWith('#/tables/'))
      || record.locator.itemRefs?.some((ref) => ref.startsWith('#/tables/'))), 'rich HTML has no canonical Docling table locator');
    assert.ok(records.every((record) => !record.text.includes('<table')), 'rich parsing returned raw HTML');
  } else {
    assert.ok(records.some((record) => record.text.includes('<table')), 'plain Evidence recipe did not preserve its raw HTML input');
    assert.ok(records.every((record) => !record.locator.itemRefs && !record.locator.tableRefs));
  }
}

async function availableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
