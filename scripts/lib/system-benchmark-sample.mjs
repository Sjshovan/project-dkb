import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { compileComposeProject } from '@sjshovan/dkb-compiler/compile.js';
import { assertDiskCapacity, estimateIngestionWorkingBytes } from '@sjshovan/dkb-compiler/diskCapacity.js';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { resolveBuildProfiles } from '@sjshovan/dkb-pipeline/buildProfiles.js';
import { addLibraryRoot } from '@sjshovan/dkb-library/resolver.js';
import { readRetrievalBuildProfile } from '@sjshovan/dkb-library/builds.js';
import { runtimeActivationDigest } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '@sjshovan/dkb-runtime/defaultComposition.js';
import { ensureRuntimeState } from '@sjshovan/dkb-runtime/runtime/state.js';
import { switchRuntimePipelineFromRegistry } from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
import { searchRuntime, readRuntime } from '@sjshovan/dkb-runtime/runtime/queryAccess.js';
import { closeQueryContext } from '@sjshovan/dkb-runtime/runtime/queryCache.js';
import { listQueryAudit } from '@sjshovan/dkb-runtime/runtime/queryAudit.js';
import { prepareHostProofContext } from './host-proof-composition.mjs';
import { generateDenseCorpus, DENSE_CORPUS_TIERS } from './benchmark-corpus.mjs';
import { CACHE_POLICY, MEASUREMENT_SCOPE, WORKLOAD, digest, fileInventory, hostIdentity } from './system-benchmark-report.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixedSourceTime = new Date('2026-01-01T00:00:00.000Z');

// One process per run makes module caches and the complete query boundary
// explicit. The parent owns the deadline and waits for close before cleanup.
export async function runSample(root, options) {
  const libraryRoot = path.join(root, 'library');
  const stateRoot = path.join(root, 'runtime');
  const packageRoot = path.join(libraryRoot, `dense-${options.tier}`);
  const packageId = `@benchmark/dense-${options.tier}`;
  const result = { ordinal: options.ordinal, status: 'failed', stage: 'setup' };
  let host;
  try {
    await fs.mkdir(libraryRoot, { recursive: true });
    await fs.writeFile(path.join(libraryRoot, 'dkb.json'), `${JSON.stringify({ type: 'library', name: 'System benchmark', roots: {} })}\n`);
    await initializeIsolatedContext(root, options);
    const tier = DENSE_CORPUS_TIERS[options.tier];
    const estimate = estimateIngestionWorkingBytes(tier.sourceBytes);
    assert.ok(estimate <= options.maxWorkingBytes, 'Working-set estimate exceeds benchmark limit');
    await assertDiskCapacity(root, estimate, 'system benchmark');
    await generateDenseCorpus(packageRoot, options.tier, tier);
    const files = await fileInventory(packageRoot);
    for (const file of files) await fs.utimes(path.join(packageRoot, file.path), fixedSourceTime, fixedSourceTime);
    const composition = await prepareHostProofContext({ root: libraryRoot, target: options.target });
    host = await DkbProviderHost.create({ root: libraryRoot, target: options.target, distribution: DEFAULT_DKB_DISTRIBUTION });
    const profiles = await resolveBuildProfiles(host);
    // Managed indexes require separate external-state cleanup. This bounded
    // harness must not delete a shared managed index to make its test pass.
    assert.equal(profiles.retrieval.index.mode, 'packaged', 'System benchmark currently requires a packaged index');
    for (const provider of host.describe().providers) {
      const lifecycle = host.provider(provider.kind).lifecycle;
      if (lifecycle?.status) {
        const status = await lifecycle.status();
        if ('running' in status) assert.equal(status.running, true, `Start the ${provider.id} service before benchmarking`);
      }
    }
    const health = await host.health();
    assert.ok(health.every((entry) => entry.ok), 'Selected providers must be healthy before benchmarking');
    const description = host.describe();
    const providerIdentities = description.providers.map(({ sourcePath: _path, ...provider }) => ({
      ...provider, integrity: host.providerIntegrity(provider.kind),
    }));
    const profileOptions = Object.fromEntries(description.providers.map((provider) => [provider.id, host.profileOptionsFor(provider.id)]));
    result.identity = {
      corpus: { generator: 'dense-prose-table-code.v1', tier: options.tier, files, digest: digest(files), sourceMtime: fixedSourceTime.toISOString() },
      workload: WORKLOAD, scope: MEASUREMENT_SCOPE, cache: CACHE_POLICY,
      host: hostIdentity(), querySamples: options.querySamples, warmups: options.warmups,
      pipeline: { target: options.target, kind: options.lexicalExample ? 'lexical-example-only' : 'bundled-packaged',
        evidenceProfileDigest: profiles.evidence.profileDigest, retrievalProfileDigest: profiles.retrieval.profileDigest,
        compatibilityDigest: profiles.retrieval.compatibilityDigest, compatibility: profiles.retrieval.compatibility,
        providers: providerIdentities, processors: description.processors.map(({ sourcePath: _path, ...processor }) => processor),
        // Hash all validated non-secret options; avoid disclosing custom text
        // options or endpoint paths in a shareable benchmark report.
        optionsDigest: digest(profileOptions),
        model: profiles.retrieval.embedding ?? null,
      },
    };
    result.identityDigest = digest(result.identity);
    await host.dispose();
    host = undefined;
    result.stage = 'compile';
    const started = performance.now();
    const compiled = await compileComposeProject(packageRoot, { force: true, ...composition });
    const wallMs = performance.now() - started;
    assert.equal(compiled.cacheHit, false, 'Full compilation must not reuse an existing build');
    assert.ok(compiled.recordCount > 0);
    assert.ok(compiled.profile?.statistics, 'Compiler statistics are required');
    const profile = await readRetrievalBuildProfile(compiled.retrievalBuildPath);
    assert.equal(profile.profile.evidence.profileDigest, profiles.evidence.profileDigest);
    assert.equal(profile.profileDigest, profiles.retrieval.profileDigest);
    assert.equal(profile.compatibilityDigest, profiles.retrieval.compatibilityDigest);
    result.compile = { wallMs, cacheHit: false, evidenceRecords: compiled.recordCount,
      corpus: compiled.profile.statistics.corpus, storage: compiled.profile.statistics.storage,
      timingsMs: compiled.profile.timingsMs, providerStages: compiled.profile.statistics.providerStages };
    assert.ok(result.compile.storage.totalDerivedBytes <= options.maxWorkingBytes, 'Derived bytes exceed benchmark limit');
    result.stage = 'activation';
    await addLibraryRoot(libraryRoot, packageId);
    await ensureRuntimeState(stateRoot, { runtimeId: 'system-benchmark', libraryRoot, target: options.target });
    await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot, target: options.target });
    const { activation } = await ensureRuntimeState(stateRoot);
    assert.ok(activation);
    result.build = activation.packages[packageId];
    assert.ok(result.build);
    const activationDigest = runtimeActivationDigest(activation);
    result.queries = [];
    const expectedAudit = [];
    result.stage = 'queries';
    for (let iteration = 0; iteration < options.warmups + options.querySamples; iteration++) {
      const measured = iteration >= options.warmups;
      const query = async (kind, operation, check) => {
        const start = performance.now();
        const value = await operation();
        const elapsed = performance.now() - start;
        check(value);
        const [audit] = await listQueryAudit(stateRoot, 1);
        assert.ok(audit, 'Completed operation must already be persisted in mandatory audit');
        assert.equal(audit.admission, 'admitted');
        assert.equal(audit.runtime.activationDigest, activationDigest);
        assert.equal(audit.library.stateDigest, activation.library.stateDigest);
        assert.equal(audit.pipeline.compatibilityDigest, activation.compatibilityDigest);
        assert.equal(audit.outcome, kind === 'insufficient' ? 'insufficient' : 'success');
        assert.ok(audit.packages.some((entry) => entry.id === packageId && entry.evidenceDigest === result.build.evidenceDigest
          && entry.retrievalBuildDigest === result.build.retrievalBuildDigest));
        if (kind !== 'insufficient') assert.ok(audit.candidates.every((entry) => entry.evidenceDigest === result.build.evidenceDigest && entry.retrievalBuildDigest === result.build.retrievalBuildDigest));
        if (kind === 'fetch') assert.ok(audit.citations.length > 0);
        expectedAudit.push(audit.eventId);
        if (measured) result.queries.push({ kind, iteration: iteration - options.warmups, wallMs: elapsed, auditEventId: audit.eventId });
        return value;
      };
      const search = await query('search', () => searchRuntime({ stateRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
        query: WORKLOAD.search.query, limit: WORKLOAD.search.limit }), (value) => assert.ok(value.results.length > 0));
      const evidenceId = search.results[0].evidenceId;
      await query('fetch', () => readRuntime({ stateRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
        request: { queries: [{ id: 'benchmark', target: evidenceId, operation: 'fetch' }] } }), (value) => {
        assert.equal(value.queries[0].evidence[0].source.evidenceId, evidenceId);
        assert.ok(JSON.stringify(value).includes(WORKLOAD.search.marker));
      });
      await query('insufficient', () => searchRuntime({ stateRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
        query: WORKLOAD.insufficient.query, limit: WORKLOAD.insufficient.limit }), (value) => assert.equal(value.results.length, 0));
    }
    const events = await listQueryAudit(stateRoot, expectedAudit.length + 1);
    assert.equal(events.length, expectedAudit.length, 'Exactly one terminal audit event per request');
    assert.equal(new Set(expectedAudit).size, expectedAudit.length);
    assert.deepEqual(events.map((event) => event.eventId).sort(), [...expectedAudit].sort());
    result.audit = { validated: true, terminalEvents: events.length, activationDigest };
    result.status = 'completed';
    result.stage = 'complete';
  } catch (error) {
    result.status = 'failed';
    result.error = { code: 'sample_failed', message: `Benchmark failed during ${result.stage}; check the selected pipeline, services, disk limits and build before retrying.` };
  } finally {
    try { await host?.dispose(); await closeQueryContext(stateRoot); }
    catch { result.status = 'failed'; result.error = { code: 'cleanup_failed', message: 'Provider/Runtime disposal failed; sample is not valid.' }; }
    await fs.writeFile(path.join(root, 'sample.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

async function initializeIsolatedContext(root, options) {
  const globalRoot = path.join(root, 'global');
  await fs.mkdir(globalRoot, { recursive: true });
  process.env.DKB_GLOBAL_ROOT = globalRoot;
  process.env.DKB_CLI_CONFIG = path.join(globalRoot, 'config.json');
  process.env.DKB_HOST_INVENTORY = path.join(root, 'host.json');
  process.env.DKB_EMBEDDING_CACHE = '0';
  if (options.lexicalExample) {
    const example = path.join(repositoryRoot, 'examples', 'lexical-pipeline');
    const plugin = path.join(globalRoot, 'plugins', '@example', 'minisearch-lexical');
    await fs.mkdir(path.dirname(plugin), { recursive: true });
    await fs.symlink(example, plugin, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.copyFile(path.join(example, 'pipeline.json'), process.env.DKB_CLI_CONFIG);
  } else await fs.writeFile(process.env.DKB_CLI_CONFIG, '{"format":"dkb.config.v2"}\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const result = await runSample(path.dirname(process.argv[2]), options);
  process.exitCode = result.status === 'completed' ? 0 : 1;
}
