import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import {
  CHANGED_EVIDENCE_TARGET, multispaceRecipes, concurrentRuntimeCompose,
  requiredProofServices, assertRecipeBuildRelationship, assertRichEvidence,
  assertProofImagePins,
} from '../scripts/lib/multispace-fixture.mjs';
import { sourceAnchors } from '../scripts/lib/multispace-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceId = '@dkb/evidence-docling-llamaindex';

test('multispace fixture defines shared-Evidence and genuinely different interpretation recipes', () => {
  const original = structuredClone(DEFAULT_DKB_DISTRIBUTION.defaults);
  const recipes = multispaceRecipes('fastembed-faiss', 'tei-faiss');
  assert.deepEqual(Object.keys(recipes), ['fastembed-faiss', 'tei-faiss', CHANGED_EVIDENCE_TARGET]);
  assert.deepEqual(recipes['fastembed-faiss'].options[evidenceId], recipes['tei-faiss'].options[evidenceId]);
  assert.equal(recipes['tei-faiss'].options[evidenceId].richFiles, true);
  assert.equal(recipes['tei-faiss'].options[evidenceId].richFileFallback, false);
  assert.equal(recipes[CHANGED_EVIDENCE_TARGET].options[evidenceId].richFiles, false);
  const changed = structuredClone(recipes[CHANGED_EVIDENCE_TARGET]);
  changed.options[evidenceId].richFiles = true;
  assert.deepEqual(changed, recipes['tei-faiss']);
  assert.deepEqual(DEFAULT_DKB_DISTRIBUTION.defaults, original, 'proof setup mutated the distribution');
  assert.throws(() => multispaceRecipes('tei-faiss', 'tei-faiss'), /distinct retrieval/u);
  assert.throws(() => multispaceRecipes('missing', 'tei-faiss'), /Unknown bundled/u);
});

test('Runtime B Compose fixture retains the Library but owns separate state and helper-visible roots', async () => {
  const source = await fs.readFile(path.join(root, 'deploy/compose.yaml'), 'utf8');
  const original = YAML.parse(source);
  const compose = concurrentRuntimeCompose(source, { initial: 'fastembed-faiss', runtimeName: 'proof-b', port: 7349 });
  const a = compose.services['dkb-runtime'];
  const b = compose.services['dkb-runtime-b'];
  assert.deepEqual(a, original.services['dkb-runtime']);
  assert.deepEqual(b.profiles, ['proof-runtime-b']);
  assert.equal(b.environment.DKB_RUNTIME_STATE_ROOT, '/runtime-b');
  assert.equal(b.environment.DKB_LIBRARY_PATH, a.environment.DKB_LIBRARY_PATH);
  assert.equal(b.environment.DKB_RUNTIME_ID, 'proof-b');
  assert.equal(b.environment.DKB_PIPELINE_TARGET, 'fastembed-faiss');
  assert.deepEqual(b.ports, ['127.0.0.1:7349:7331']);
  assert.ok(b.volumes.includes(a.volumes.find((mount) => mount.endsWith(':/library'))));
  assert.ok(b.volumes.every((mount) => !mount.endsWith(':/state')));
  const owned = b.volumes.find((mount) => mount.endsWith(':/runtime-b'));
  assert.ok(owned?.includes('/runtime-b:/runtime-b'));
  assert.ok(compose.services['dkb-faiss'].volumes.includes(owned));
  assert.ok(compose.services['dkb-faiss'].environment.DKB_FAISS_ALLOWED_ROOTS.split(',').includes('/runtime-b'));
  assert.deepEqual(YAML.parse(YAML.stringify(compose)), compose);
  assert.throws(() => concurrentRuntimeCompose(source, { initial: 'default', runtimeName: 'b', port: 0 }));
});

test('proof service expectations follow recipe provider IDs including aliases and partial config', () => {
  const recipes = multispaceRecipes('fastembed-faiss', 'tei-faiss');
  assert.deepEqual(requiredProofServices([CHANGED_EVIDENCE_TARGET], recipes), ['dkb-faiss', 'dkb-tei']);
  assert.deepEqual(requiredProofServices(['fastembed-faiss', CHANGED_EVIDENCE_TARGET], recipes), ['dkb-embedder', 'dkb-faiss', 'dkb-tei']);
  assert.deepEqual(requiredProofServices(['default'], { default: { options: {} } }), ['dkb-faiss', 'dkb-tei']);
});

test('optional proof services must match inspected image identities before starting', () => {
  const recipes = multispaceRecipes('fastembed-faiss', 'tei-faiss');
  const digest = `sha256:${'b'.repeat(64)}`;
  const service = DEFAULT_DKB_DISTRIBUTION.services.find((value) => value.providerId === '@dkb/embedding-tei');
  for (const name of ['tei-faiss', CHANGED_EVIDENCE_TARGET]) {
    recipes[name].options[service.providerId].imageDigest = digest;
  }
  assert.doesNotThrow(() => assertProofImagePins(Object.keys(recipes), recipes, [service], { [service.id]: digest }));
  assert.throws(() => assertProofImagePins(Object.keys(recipes), recipes, [service], {}));
  assert.throws(() => assertProofImagePins(Object.keys(recipes), recipes, [service], { [service.id]: `sha256:${'c'.repeat(64)}` }), /actual/u);
});

test('proof asserts exact source and Evidence parent reuse rather than target labels', () => {
  const initial = plan('initial', 'evidence-a', 'profile-a', 'retrieval-a');
  const alternate = plan('alternate', 'evidence-a', 'profile-a', 'retrieval-b');
  const changed = plan('changed', 'evidence-b', 'profile-b', 'retrieval-c');
  assert.doesNotThrow(() => assertRecipeBuildRelationship(initial, alternate, changed));
  for (const corrupt of [
    (value) => { value.package.version = '2.0.0'; },
    (value) => { value.artifacts[0].receiptHash = 'other-source-receipt'; },
    (value) => { value.artifacts[1].receiptHash = 'other-evidence-receipt'; },
    (value) => { value.evidenceDigest = 'wrong-evidence'; },
    (value) => { value.retrievalBuildDigest = initial.retrievalBuildDigest; },
  ]) {
    const broken = structuredClone(alternate);
    corrupt(broken);
    assert.throws(() => assertRecipeBuildRelationship(initial, broken, changed));
  }
  assert.throws(() => assertRecipeBuildRelationship(initial, alternate, { ...changed, evidenceDigest: initial.evidenceDigest }));
});

test('rich HTML proof rejects empty content and fallback masquerading as Docling', () => {
  const receipt = (richFiles, richFileFallback = false) => ({ providerReceipts: [{ kind: 'evidence', providerId: evidenceId,
    build: { evidenceOptions: { richFiles, richFileFallback } } }] });
  const record = { assetLocator: { path: 'sources/feeding-table.html' }, text: 'TABLE-DENSE-46', locator: { tableRefs: ['#/tables/0'] } };
  assert.doesNotThrow(() => assertRichEvidence({ evidence: [record] }, true, receipt(true)));
  assert.doesNotThrow(() => assertRichEvidence({ evidence: [{ ...record, text: '<table>TABLE-DENSE-46</table>', locator: {} }] }, false, receipt(false)));
  assert.throws(() => assertRichEvidence({ evidence: [] }, true, receipt(true)));
  assert.throws(() => assertRichEvidence({ evidence: [{ ...record, locator: {} }] }, true, receipt(true)));
  assert.throws(() => assertRichEvidence({ evidence: [record] }, true, receipt(true, true)), /disable parser fallback/u);
  assert.throws(() => assertRichEvidence({ evidence: [record] }, true, receipt(false)));
});

test('source anchor comparison ignores Evidence chunk multiplicity but detects source drift', () => {
  const record = { sourceId: 's', sourceHash: 'h', assetId: 'a', assetLocator: { path: 'source.html' }, evidenceId: 'e1' };
  assert.deepEqual(sourceAnchors({ evidence: [record] }), sourceAnchors({ evidence: [record, { ...record, evidenceId: 'e2' }] }));
  assert.notDeepEqual(sourceAnchors({ evidence: [record] }), sourceAnchors({ evidence: [{ ...record, sourceHash: 'changed' }] }));
});

test('integrated harness uses signed public verification, digest-pinned jobs, and real dual-Runtime controls', async () => {
  const source = await fs.readFile(path.join(root, 'scripts/lib/multispace-lifecycle.mjs'), 'utf8');
  assert.match(source, /verifySignedInstallPlanForInstalledSource\(\{/u);
  assert.match(source, /verifyStoredSignedBuildChain\(\{/u);
  assert.match(source, /retrievalProfileDigest: recipe\.retrievalProfileDigest, compatibilityDigest: recipe\.compatibilityDigest/u);
  assert.match(source, /assert\.equal\(job\.stage, expectedStage/u);
  assert.match(source, /assert\.equal\(ready\.jobId, undefined\)/u);
  assert.match(source, /assert\.deepEqual\(\(await runtimeStatus\(secondaryUrl\)\)\.activation, secondBefore\.activation\)/u);
  assert.match(source, /Promise\.all\(\[searchMarker\(runtimeUrl\), searchMarker\(secondaryUrl\)\]\)/u);
  assert.match(source, /HTTP search only here; CLI\/HTTP\/MCP audit-equivalence proof is separate/u);
  assert.doesNotMatch(source, /\['stack', 'up'/u, 'alternate recipe proof must not change the publication default');
  const fixture = await fs.readFile(path.join(root, 'scripts/lib/multispace-fixture.mjs'), 'utf8');
  assert.match(fixture, /assertRequiredImages\(\{ \.\.\.context, requiredServices \}\)/u);
  assert.match(fixture, /assertProofImagePins\(targets, config\.targets, requiredServices, digests\)/u);
  assert.match(fixture, /'--no-deps', '--wait', '--wait-timeout', '240'/u);
});

function plan(target, evidenceDigest, evidenceProfileDigest, retrievalBuildDigest) {
  return {
    target, package: { id: '@proof/package', version: '1.0.0', sourceDigest: 'source' },
    evidenceDigest, evidenceProfileDigest, retrievalBuildDigest,
    retrievalProfileDigest: `profile-${retrievalBuildDigest}`, compatibilityDigest: `compatibility-${retrievalBuildDigest}`,
    artifacts: [{ receiptHash: 'source-receipt' }, { receiptHash: `receipt-${evidenceDigest}` }],
  };
}
