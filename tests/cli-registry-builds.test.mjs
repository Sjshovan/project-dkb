import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareRegistryPipelineGrant } from '../apps/cli/dist/providers/registryBuilds.js';

const digest = (character) => `sha256:${character.repeat(64)}`;
const selection = { packageId: '@test/package', version: '1.0.0', target: 'local-recipe', evidenceProfileDigest: digest('a'), retrievalProfileDigest: digest('b'), compatibilityDigest: digest('c') };
const published = { ...selection, target: 'registry-recipe', status: 'published', retrievalBuildDigest: digest('d') };

function clientFixture(builds, overrides = {}) {
  const calls = [];
  const client = {
    async packageDetails() { calls.push('read'); return { selectedVersion: { builds } }; },
    async requestBuild() { calls.push('request'); return { status: 'queued', target: selection.target, jobId: 7 }; },
    async waitForBuild() { calls.push('wait'); return { target: selection.target, retrievalBuildDigest: published.retrievalBuildDigest }; },
    async createInstallGrant(id, version, target, retrievalBuildDigest) {
      calls.push({ grant: { id, version, target, retrievalBuildDigest } });
      return { plan: { ...selection, target, retrievalBuildDigest }, installGrant: 'synthetic-grant' };
    },
    ...overrides,
  };
  return { client, calls };
}

test('published exact-profile variant requires read/download authority, never build authority', async () => {
  const { client, calls } = clientFixture([published], {
    async requestBuild() { assert.fail('A reader must not need registry:build for a published variant'); },
  });
  const result = await prepareRegistryPipelineGrant(client, selection);
  assert.equal(result.plan.retrievalBuildDigest, published.retrievalBuildDigest);
  assert.deepEqual(calls, ['read', { grant: { id: selection.packageId, version: selection.version, target: published.target, retrievalBuildDigest: published.retrievalBuildDigest } }]);
});

test('missing exact profile is requested once, awaited, then granted by exact digest', async () => {
  const { client, calls } = clientFixture([{ ...published, retrievalProfileDigest: digest('e') }]);
  await prepareRegistryPipelineGrant(client, selection);
  assert.deepEqual(calls.slice(0, 3), ['read', 'request', 'wait']);
  assert.equal(calls[3].grant.retrievalBuildDigest, published.retrievalBuildDigest);
});

test('catalog failure or duplicate exact profiles never trigger an implicit compilation', async () => {
  for (const builds of [undefined, [published, { ...published, retrievalBuildDigest: digest('e') }]]) {
    const { client, calls } = clientFixture(builds);
    await assert.rejects(prepareRegistryPipelineGrant(client, selection), /catalog|multiple published/u);
    assert.deepEqual(calls, ['read']);
  }
  const denied = new Error('Registry authentication required');
  const { client, calls } = clientFixture([], { async packageDetails() { throw denied; } });
  await assert.rejects(prepareRegistryPipelineGrant(client, selection), (error) => error === denied);
  assert.deepEqual(calls, []);
});

test('queued target drift and grant profile drift fail before activation', async () => {
  const queued = clientFixture([], { async waitForBuild() { return { target: 'wrong-recipe', retrievalBuildDigest: digest('d') }; } });
  await assert.rejects(prepareRegistryPipelineGrant(queued.client, selection), /not requested Pipeline/u);
  assert.equal(queued.calls.some((call) => typeof call === 'object'), false);
  const granted = clientFixture([published], { async createInstallGrant() { return { plan: { ...selection, compatibilityDigest: digest('e'), retrievalBuildDigest: digest('d') } }; } });
  await assert.rejects(prepareRegistryPipelineGrant(granted.client, selection), /does not match Pipeline/u);
});
