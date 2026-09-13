import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { registryPackagePath } from '@sjshovan/dkb-protocol/identity.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { readEvidenceBuild, selectStoredPackageBuild } from '@sjshovan/dkb-library/builds.js';
import {
  parseRegistryTrustedKeys,
  verifySignedInstallPlanForInstalledSource,
  verifyStoredSignedBuildChain,
} from '@sjshovan/dkb-runtime/runtime/registryInstall.js';
import { assertRecipeBuildRelationship, assertRichEvidence } from './multispace-fixture.mjs';

const executeFile = promisify(execFile);

export async function proveSignedMultispace(input) {
  const { client, runCli, step, stackName, stackRoot, libraryRoot, runtimeUrl, secondaryUrl, runtimeReadToken,
    registryUrl, registryToken, initialTarget, alternateTarget, changedTarget, packages } = input;
  assert.ok(changedTarget && secondaryUrl, 'multispace fixture must include a changed Evidence recipe and Runtime B');
  assert.ok(runtimeReadToken, 'multispace fixture must supply the Stack Runtime read credential');
  const runtimeStatus = (url) => readRuntimeStatus(url, runtimeReadToken);
  const searchMarker = (url) => searchRuntimeMarker(url, runtimeReadToken);
  step('verify both explicitly provisioned recipe service chains while preserving Runtime A');
  await input.assertStackProviderServices([initialTarget, alternateTarget]);
  assert.equal((await runtimeStatus(runtimeUrl)).activation.target, initialTarget);

  const catalog = await client.pipelines();
  assert.equal(catalog.default, initialTarget, 'proof must not change the Registry publication default');
  const targets = Object.fromEntries([initialTarget, alternateTarget, changedTarget].map((name) => {
    const selected = catalog.pipelines.find((candidate) => candidate.name === name);
    assert.ok(selected?.available, `Trusted Registry recipe ${name} is missing or unhealthy`);
    return [name, selected];
  }));
  assert.equal(targets[initialTarget].evidenceProfileDigest, targets[alternateTarget].evidenceProfileDigest);
  assert.notEqual(targets[initialTarget].evidenceProfileDigest, targets[changedTarget].evidenceProfileDigest);
  const trustedKeys = parseRegistryTrustedKeys(await client.publicKeys());
  const plans = new Map();
  const jobs = [];
  const initialGraphs = [];

  for (const entry of packages) {
    const plan = await verifiedPlan(entry, initialTarget);
    plans.set(`${entry.id}:${initialTarget}`, plan);
    initialGraphs.push(await verifiedGraph(entry, plan));
    const rows = await registryBuilds(entry);
    assert.equal(rows.length, 1, 'fresh publication must create one Evidence Build');
    assert.equal(rows[0].retrievalBuilds.length, 1, 'fresh publication must create one Retrieval Build');
  }
  assertRichEvidence(await readEvidenceBuild(initialGraphs[0].evidencePath), true, initialGraphs[0].evidence);

  for (const [target, expectedStage] of [[alternateTarget, 'retrieval'], [changedTarget, 'variant']]) {
    step(`request ${target} against existing immutable source, including concurrent request deduplication`);
    for (const entry of packages) {
      const recipe = targets[target];
      const expected = { retrievalProfileDigest: recipe.retrievalProfileDigest, compatibilityDigest: recipe.compatibilityDigest };
      const requests = await Promise.all([
        client.requestBuild(entry.id, entry.version, target, expected),
        client.requestBuild(entry.id, entry.version, target, expected),
      ]);
      const queued = requests.filter((request) => request.status === 'queued');
      assert.ok(queued.length > 0, 'a missing recipe must enqueue a compilation job');
      assert.equal(new Set(queued.map((request) => request.jobId)).size, 1, 'duplicate requests created separate compilation jobs');
      const job = await client.waitForBuild(entry.id, entry.version, queued[0].jobId);
      assert.equal(job.stage, expectedStage, `${target} must ${expectedStage === 'retrieval' ? 'reuse existing Evidence' : 'create new Evidence'}`);
      assert.equal(job.attempts, 1, 'proof compilation unexpectedly retried');
      assert.equal(job.status, 'published');
      const plan = await verifiedPlan(entry, target);
      assert.equal(job.evidenceDigest, plan.evidenceDigest);
      assert.equal(job.retrievalBuildDigest, plan.retrievalBuildDigest);
      for (const request of requests.filter((candidate) => candidate.status === 'ready')) {
        assert.equal(request.retrievalBuildDigest, plan.retrievalBuildDigest);
      }
      await assertReadyWithoutCompilation(entry, target, plan);
      plans.set(`${entry.id}:${target}`, plan);
      jobs.push({ package: entry.id, version: entry.version, target, jobId: job.jobId, stage: job.stage, attempts: job.attempts });
    }
  }
  for (const entry of packages) {
    assertRecipeBuildRelationship(...[initialTarget, alternateTarget, changedTarget].map((target) => plans.get(`${entry.id}:${target}`)));
    const rows = await registryBuilds(entry);
    assert.equal(rows.length, 2, 'three recipes must retain two Evidence Builds for one PackageVersion');
    assert.deepEqual(rows.map((row) => row.retrievalBuilds.length).sort(), [1, 2]);
  }
  const beforeSwitches = await Promise.all(packages.map(registryBuilds));

  let secondaryStarted = false;
  try {
    step('start independent Runtime B on the same Library and initial Pipeline');
    secondaryStarted = true;
    await compose(['up', '--detach', '--no-deps', 'dkb-runtime-b']);
    await waitForRuntime(secondaryUrl);
    const second = await switchRuntime(initialTarget, secondaryUrl);
    assert.ok(second.packages.every((entry) => entry.preparation === 'retained'));
    const secondBefore = await runtimeStatus(secondaryUrl);
    assert.notEqual(secondBefore.runtimeId, (await runtimeStatus(runtimeUrl)).runtimeId);
    assert.deepEqual(secondBefore.library, (await runtimeStatus(runtimeUrl)).library);
    assert.deepEqual(secondBefore.activation.packages, (await runtimeStatus(runtimeUrl)).activation.packages);
    const originalSearch = await searchMarker(secondaryUrl);

    for (const target of [alternateTarget, changedTarget, initialTarget]) {
      step(`switch Runtime A to ${target}; Runtime B must stay unchanged and queryable`);
      const result = await switchRuntime(target, runtimeUrl);
      if (target === initialTarget) assert.ok(result.packages.every((entry) => entry.preparation === 'retained'));
      const first = await runtimeStatus(runtimeUrl);
      assert.equal(first.activation.target, target);
      for (const entry of packages) {
        const plan = plans.get(`${entry.id}:${target}`);
        const selected = first.activation.packages[entry.id];
        assert.equal(selected.evidenceDigest, plan.evidenceDigest);
        assert.equal(selected.retrievalBuildDigest, plan.retrievalBuildDigest);
        const graph = await verifiedGraph(entry, plan);
        if (target === alternateTarget) {
          assert.equal(graph.evidencePath, initialGraphs[packages.indexOf(entry)].evidencePath,
            'shared Evidence recipe must reuse the exact immutable Library directory');
        }
      }
      const [left, right] = await Promise.all([searchMarker(runtimeUrl), searchMarker(secondaryUrl)]);
      assert.equal(right.evidenceId, originalSearch.evidenceId);
      assert.deepEqual((await runtimeStatus(secondaryUrl)).activation, secondBefore.activation);
      if (target !== changedTarget) assert.equal(left.evidenceId, right.evidenceId);
      if (target === changedTarget) {
        const graph = await verifiedGraph(packages[0], plans.get(`${packages[0].id}:${target}`));
        const changedIr = await readEvidenceBuild(graph.evidencePath);
        assertRichEvidence(changedIr, false, graph.evidence);
        const initialIr = await readEvidenceBuild(initialGraphs[0].evidencePath);
        assert.deepEqual(sourceAnchors(changedIr), sourceAnchors(initialIr), 'changing interpretation must preserve source anchors');
      }
      await input.assertRuntimeMarker('RUNTIME-MOUNT-28', true);
      const safe = await input.assertRuntimeMarker('SAFE-SOURCE-91', true);
      assert.doesNotMatch(JSON.stringify(safe), /PWNED/u);
      assert.equal((await input.runtimeRetrieve('What is the launch code for the moon base?')).sufficiency?.matchedNeed, false);
    }
    step('verify retained switch-back and repeated requests did not rebuild signed variants');
    for (const entry of packages) {
      for (const target of [initialTarget, alternateTarget, changedTarget]) {
        await assertReadyWithoutCompilation(entry, target, plans.get(`${entry.id}:${target}`));
      }
    }
    assert.deepEqual(await Promise.all(packages.map(registryBuilds)), beforeSwitches);
    const cacheA = path.join(stackRoot, 'runtime', '.dkb', 'cache');
    const cacheB = path.join(stackRoot, 'runtime-b', '.dkb', 'cache');
    assert.notEqual(cacheA, cacheB);
    assert.ok((await fs.stat(cacheA)).isDirectory(), 'Runtime A has no owned cache directory');
    assert.ok((await fs.stat(cacheB)).isDirectory(), 'Runtime B has no owned cache directory');
    assert.notEqual(await fs.realpath(cacheA), await fs.realpath(cacheB));
    return {
      targets: [initialTarget, alternateTarget, changedTarget],
      jobs,
      evidenceBuildsPerPackage: 2,
      retrievalBuildsPerPackage: 3,
      signedParentChains: true,
      richHtmlWithoutFallback: true,
      concurrentRequestDeduplication: true,
      switchBackPreparation: 'retained',
      simultaneousRuntimes: { independentActivation: true, sharedImmutableBuilds: true, separateCacheRoots: true,
        querySessions: 'independent provider query sessions over shared immutable Library builds' },
      auditChannels: 'HTTP search only here; CLI/HTTP/MCP audit-equivalence proof is separate',
    };
  } finally {
    if (secondaryStarted) await compose(['rm', '--force', '--stop', 'dkb-runtime-b']);
  }

  async function verifiedPlan(entry, target) {
    const plan = await client.installPlan(entry.id, entry.version, target);
    const recipe = targets[target];
    assert.equal(plan.evidenceProfileDigest, recipe.evidenceProfileDigest);
    assert.equal(plan.retrievalProfileDigest, recipe.retrievalProfileDigest);
    assert.equal(plan.compatibilityDigest, recipe.compatibilityDigest);
    return verifySignedInstallPlanForInstalledSource({ plan, packageRoot: registryPackagePath(libraryRoot, entry.id), trustedKeys });
  }

  async function verifiedGraph(entry, plan) {
    const packageRoot = registryPackagePath(libraryRoot, entry.id);
    const graph = await selectStoredPackageBuild({ root: packageRoot, target: plan.target,
      evidenceProfileDigest: plan.evidenceProfileDigest, retrievalProfileDigest: plan.retrievalProfileDigest, compatibilityDigest: plan.compatibilityDigest });
    assert.equal(graph.retrieval.retrievalBuildDigest, plan.retrievalBuildDigest);
    return verifyStoredSignedBuildChain({ packageRoot, graph, target: plan.target, trustedKeys });
  }

  async function assertReadyWithoutCompilation(entry, target, plan) {
    const recipe = targets[target];
    const ready = await client.requestBuild(entry.id, entry.version, target, {
      retrievalProfileDigest: recipe.retrievalProfileDigest, compatibilityDigest: recipe.compatibilityDigest,
    });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.jobId, undefined);
    assert.equal(ready.retrievalBuildDigest, plan.retrievalBuildDigest);
  }

  async function registryBuilds(entry) {
    const identity = entry.id.slice(1).split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${registryUrl}/api/registry/packages/${identity}/versions/${encodeURIComponent(entry.version)}/builds`, {
      headers: { authorization: `Bearer ${registryToken}` }, signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.data));
    return body.data;
  }

  function switchRuntime(target, url) {
    return runCli(['pipeline', 'use', target, '--runtime-url', url, '--registry-url', registryUrl]);
  }

  async function compose(args) {
    await executeFile('docker', ['compose', '--env-file', path.join(stackRoot, 'stack.env'),
      '--file', process.env.DKB_STACK_COMPOSE_FILE, '--profile', 'proof-runtime-b', ...args], {
      cwd: input.repositoryRoot, env: process.env, windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
  }
}

export function sourceAnchors(ir) {
  return [...new Set(ir.evidence.map((record) => stableHash({
    sourceId: record.sourceId, sourceHash: record.sourceHash, assetId: record.assetId, assetLocator: record.assetLocator,
  })))].sort();
}

async function readRuntimeStatus(url, readToken) {
  const response = await fetch(`${url}/api/runtime`, {
    headers: { authorization: `Bearer ${readToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function searchRuntimeMarker(url, readToken) {
  const response = await fetch(`${url}/api/search`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken}` },
    redirect: 'error',
    body: JSON.stringify({ query: 'WHALE-BUBBLE-73', limit: 5 }), signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const hit = body.results.find((entry) => entry.preview.includes('WHALE-BUBBLE-73'));
  assert.ok(hit?.evidenceId, 'independent Runtime missed known Evidence');
  return hit;
}

async function waitForRuntime(url) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) })).ok) return; } catch {
      // A newly launched service may refuse connections until it has bound its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Runtime B failed health at ${url}; inspect dkb stack logs before rerunning the proof.`);
}
