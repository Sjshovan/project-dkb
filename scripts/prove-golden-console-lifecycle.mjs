import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const stackName = process.env.DKB_STACK_NAME ?? 'final-proof';
const libraryName = process.env.DKB_PROOF_LIBRARY ?? `${stackName}-library`;
const registryName = process.env.DKB_PROOF_REGISTRY ?? `${stackName}-registry`;
const namespace = process.env.DKB_PROOF_NAMESPACE ?? 'final-proof';
const marineVersion = process.env.DKB_MARINE_VERSION ?? '1.2.0';
const systemsVersion = process.env.DKB_SYSTEMS_VERSION ?? '1.2.1';
const collectionRevision = Number(process.env.DKB_COLLECTION_REVISION ?? '1');
const marineId = `@${namespace}/marine-proof`;
const systemsId = `@${namespace}/systems-proof`;
const collectionId = `@${namespace}/complete-proof`;
const stackRoot = path.join(os.homedir(), '.dkb', 'stacks', stackName);
const stackEnvironment = parseEnvironment(await fs.readFile(path.join(stackRoot, 'stack.env'), 'utf8'));
const runtimeUrl = `http://127.0.0.1:${required(stackEnvironment.DKB_RUNTIME_PORT, 'Runtime port')}`;
const runtimeReadToken = required(stackEnvironment.DKB_RUNTIME_READ_TOKEN, 'Runtime read token');
const mcpToken = required(stackEnvironment.DKB_MCP_BEARER_TOKEN, 'MCP token');
const consoleState = JSON.parse(await fs.readFile(path.join(os.homedir(), '.dkb', 'console', 'process.json'), 'utf8'));
const consoleUrl = required(consoleState.url, 'Console URL');
const controlToken = required(consoleState.controlToken, 'Console control token');
const session = await openConsoleSession();
const registryRoute = `/api/v1/registries/${encodeURIComponent(registryName)}`;
let currentStep = 'startup';

try {
  step('browse the private Registry catalog through the Console');
  const registry = await consoleGet(registryRoute);
  assert.equal(registry.registry.name, registryName);
  assert.ok(registry.libraries.some((library) => library.name === libraryName));
  const catalog = await consoleGet(`${registryRoute}/catalog?type=all&page=1&perPage=20`);
  for (const identity of [marineId, systemsId, collectionId]) {
    assert.ok(catalog.entries.some((entry) => entry.id === identity), `${identity} is missing from the Console catalog`);
  }

  step('inspect versions, signed provenance, builds, Contents, and Collection members');
  const marineRemote = await registryDkb(marineId, marineVersion);
  const systemsRemote = await registryDkb(systemsId, systemsVersion);
  for (const detail of [marineRemote, systemsRemote]) {
    assert.equal(detail.selectedVersion.status, 'published');
    assert.ok(detail.selectedVersion.sourceReceipt?.receiptHash);
    assert.ok(detail.selectedVersion.sourceReceipt?.sourceInventory?.hash);
    assert.ok(detail.selectedVersion.builds?.some((build) => build.status === 'published' && build.target === 'default'));
  }
  const contents = await consoleGet(`${registryRoute}/dkbs/${namespace}/marine-proof/contents?version=${encodeURIComponent(marineVersion)}&path=.&limit=200`);
  assert.ok(contents.entries.some((entry) => entry.path === 'sources/whale-behavior.md'));
  assert.ok(contents.entries.every((entry) => !isForbiddenInventoryPath(entry.path)));
  const collectionRemote = await consoleGet(`${registryRoute}/collections/${namespace}/complete-proof?revision=${collectionRevision}`);
  assert.equal(collectionRemote.selectedRevision.revision, collectionRevision);
  assert.deepEqual(
    collectionRemote.selectedRevision.manifest.members.map((member) => `${member.id}@${member.version}`).sort(),
    [`${marineId}@${marineVersion}`, `${systemsId}@${systemsVersion}`].sort(),
  );
  const immutableBuilds = {
    marine: buildIdentity(marineRemote.selectedVersion),
    systems: buildIdentity(systemsRemote.selectedVersion),
    collection: collectionRemote.selectedRevision.digest,
  };

  step('remove direct proof packages through the Console');
  await removeIfInstalled(collectionId);
  await removeIfInstalled(systemsId);
  await removeIfInstalled(marineId);
  await assertInstalled([]);
  await assertMarker('WHALE-BUBBLE-73', false);
  await assertMarker('RUNTIME-MOUNT-28', false);

  step('install the exact Collection revision through the Console');
  await runOperation('package.install', {
    library: libraryName,
    identity: collectionId,
    revision: collectionRevision,
    registryUrl: registry.registry.url,
  });
  await assertInstalled([collectionId, marineId, systemsId]);
  await assertMarker('WHALE-BUBBLE-73', true);
  await assertMarker('RUNTIME-MOUNT-28', true);
  const safeEvidence = await assertMarker('SAFE-SOURCE-91', true);
  assert.doesNotMatch(JSON.stringify(safeEvidence), /PWNED/u);
  assert.equal((await runtimeRetrieve('What is the launch code for the moon base?')).sufficiency?.matchedNeed, false);
  for (const identity of [marineId, systemsId]) {
    const verification = await runOperation('package.verify', { library: libraryName, identity });
    assert.notEqual(verification.status, 'failed', `${identity} failed installed integrity verification`);
  }
  const firstMarine = await installedDetail(marineId);
  const firstSystems = await installedDetail(systemsId);

  step('uninstall the Collection and prove all Collection-only evidence disappears');
  await runOperation('package.uninstall', { library: libraryName, identity: collectionId });
  await assertInstalled([]);
  await assertMarker('WHALE-BUBBLE-73', false);
  await assertMarker('RUNTIME-MOUNT-28', false);
  await assertMarker('SAFE-SOURCE-91', false);

  step('install marine directly, then reinstall the Collection with dependency reuse');
  await runOperation('package.install', {
    library: libraryName,
    identity: marineId,
    version: marineVersion,
    target: 'default',
    registryUrl: registry.registry.url,
  });
  const directMarine = await installedDetail(marineId);
  await runOperation('package.install', {
    library: libraryName,
    identity: collectionId,
    revision: collectionRevision,
    registryUrl: registry.registry.url,
  });
  const reusedMarine = await installedDetail(marineId);
  assert.equal(reusedMarine.installedAt, directMarine.installedAt, 'direct marine package was replaced instead of reused');
  assert.deepEqual(reusedMarine.activeBuild, directMarine.activeBuild);
  await assertInstalled([collectionId, marineId, systemsId]);

  step('uninstall the Collection while preserving the directly installed marine package');
  await runOperation('package.uninstall', { library: libraryName, identity: collectionId });
  await assertInstalled([marineId]);
  await assertMarker('WHALE-BUBBLE-73', true);
  await assertMarker('RUNTIME-MOUNT-28', false);
  await assertMarker('SAFE-SOURCE-91', false);

  step('reinstall the Collection without compilation and verify immutable build identity');
  await runOperation('package.install', {
    library: libraryName,
    identity: collectionId,
    revision: collectionRevision,
    registryUrl: registry.registry.url,
  });
  await assertInstalled([collectionId, marineId, systemsId]);
  assert.deepEqual(buildIdentity((await registryDkb(marineId, marineVersion)).selectedVersion), immutableBuilds.marine);
  assert.deepEqual(buildIdentity((await registryDkb(systemsId, systemsVersion)).selectedVersion), immutableBuilds.systems);
  assert.equal((await consoleGet(`${registryRoute}/collections/${namespace}/complete-proof?revision=${collectionRevision}`)).selectedRevision.digest, immutableBuilds.collection);
  assert.deepEqual((await installedDetail(marineId)).activeBuild, firstMarine.activeBuild);
  assert.deepEqual((await installedDetail(systemsId)).activeBuild, firstSystems.activeBuild);

  step('confirm remote MCP remains authenticated and read-only');
  const tools = await mcpRequest('tools/list', {}, 1);
  assert.deepEqual(tools.result.tools.map((tool) => tool.name).sort(), ['fetch', 'search']);
  await assertMarker('WHALE-BUBBLE-73', true);
  await assertMarker('RUNTIME-MOUNT-28', true);
  const finalSafe = await assertMarker('SAFE-SOURCE-91', true);
  assert.doesNotMatch(JSON.stringify(finalSafe), /PWNED/u);

  console.log(JSON.stringify({
    ok: true,
    stack: stackName,
    library: libraryName,
    registry: registryName,
    runtimeUrl,
    releases: [`${marineId}@${marineVersion}`, `${systemsId}@${systemsVersion}`, `${collectionId}@r${collectionRevision}`],
    checks: {
      consoleCatalog: true,
      signedProvenance: true,
      boundedContents: true,
      buildAvailability: true,
      collectionMembers: true,
      installedIntegrity: true,
      knownAnswers: '3/3',
      hostileInstructionRemoved: true,
      unrelatedEvidenceInsufficient: true,
      dependencyReuse: true,
      directDependencyPreserved: true,
      reinstallWithoutCompilation: true,
      mcpTools: ['search', 'fetch'],
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    stackName,
    step: currentStep,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
  }, null, 2));
  process.exitCode = 1;
}

async function openConsoleSession() {
  const bootstrap = await fetch(`${consoleUrl}/control/bootstrap`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(bootstrap.status, 200);
  const { secret } = await bootstrap.json();
  const response = await fetch(`${consoleUrl}/api/session/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const { csrf } = await response.json();
  assert.ok(cookie && csrf);
  return { cookie, csrf };
}

async function consoleGet(route) {
  const response = await fetch(`${consoleUrl}${route}`, {
    headers: { cookie: session.cookie },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function runOperation(commandId, input) {
  const response = await fetch(`${consoleUrl}/api/v1/operations`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      'x-dkb-csrf': session.csrf,
    },
    body: JSON.stringify({ commandId, input }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = await response.json();
  assert.equal(response.status, 202, JSON.stringify(created));
  for (let attempt = 0; attempt < 1_800; attempt += 1) {
    const operation = await consoleGet(`/api/v1/operations/${created.operationId}`);
    if (operation.status === 'succeeded') return operation.result;
    if (operation.status === 'failed' || operation.status === 'cancelled') {
      const failure = [...operation.events].reverse().find((event) => event.event === 'failure');
      throw new Error(`${commandId} ${operation.status}: ${failure?.error?.message ?? 'unknown failure'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${commandId} timed out`);
}

async function installedPackages() {
  return (await consoleGet(`/api/v1/libraries/${encodeURIComponent(libraryName)}/packages`)).packages;
}

async function assertInstalled(expected) {
  const actual = (await installedPackages()).map((entry) => entry.id).sort();
  assert.deepEqual(actual, [...expected].sort());
}

async function removeIfInstalled(identity) {
  if ((await installedPackages()).some((entry) => entry.id === identity)) {
    await runOperation('package.uninstall', { library: libraryName, identity });
  }
}

async function installedDetail(identity) {
  const [, namespace, name] = identity.match(/^@([^/]+)\/(.+)$/u) ?? [];
  return consoleGet(`/api/v1/libraries/${encodeURIComponent(libraryName)}/entries/${namespace}/${name}`);
}

async function registryDkb(identity, version) {
  const [, namespaceValue, name] = identity.match(/^@([^/]+)\/(.+)$/u) ?? [];
  return consoleGet(`${registryRoute}/dkbs/${namespaceValue}/${name}?version=${encodeURIComponent(version)}`);
}

async function runtimeRetrieve(need) {
  const response = await fetch(`${runtimeUrl}/api/retrieve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${runtimeReadToken}` },
    redirect: 'error',
    body: JSON.stringify({ need, phrases: [need], intent: 'evidence', limit: 5 }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function assertMarker(marker, expected) {
  const result = await runtimeRetrieve(marker);
  const present = JSON.stringify(result.evidence).includes(marker);
  assert.equal(present, expected, `${marker} presence was ${present}, expected ${expected}`);
  return result;
}

async function mcpRequest(method, params, id) {
  const response = await fetch(`${runtimeUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.error, undefined, JSON.stringify(body));
  return body;
}

function buildIdentity(version) {
  return {
    packageTreeHash: version.packageTreeHash,
    receiptHash: version.receiptHash,
    sourceInventoryHash: version.sourceReceipt?.sourceInventory?.hash,
    target: version.defaultBuild?.target,
    evidenceDigest: version.defaultBuild?.evidenceDigest,
    retrievalBuildDigest: version.defaultBuild?.retrievalBuildDigest,
    compatibilityDigest: version.defaultBuild?.compatibilityDigest,
  };
}

function isForbiddenInventoryPath(value) {
  return value.split('/').some((part) => ['.dkb', '.git', 'node_modules', 'vendor', 'dist', 'coverage'].includes(part))
    || /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/iu.test(value);
}

function parseEnvironment(source) {
  return Object.fromEntries(source.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const separator = trimmed.indexOf('=');
    return separator < 1 ? [] : [[trimmed.slice(0, separator), trimmed.slice(separator + 1)]];
  }));
}

function required(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
  return value;
}

function step(value) {
  currentStep = value;
  console.log(JSON.stringify({ event: 'proof.step', step: value }));
}
