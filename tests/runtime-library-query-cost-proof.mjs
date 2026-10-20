// Isolated paired lexical Runtime boundary benchmark, not a corpus/embedding benchmark.
// Run after a build, with other DKB proofs stopped: node tests/runtime-library-query-cost-proof.mjs --run
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] === '--worker') await worker();
else if (process.argv[2] === '--run' && (process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--system'))) await proof();
else { console.error('Run explicitly after building: node tests/runtime-library-query-cost-proof.mjs --run [--system]'); process.exitCode = 1; }

async function proof() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-query-cost-proof-'));
  const cleanup = [];
  try {
    const baselineCommit = (await command('git', ['rev-parse', 'HEAD'])).trim();
    const baseline = path.join(root, 'baseline');
    await fs.mkdir(baseline);
    await command('git', ['archive', '--format=tar', '--output=' + path.join(root, 'baseline.tar'), baselineCommit,
      'packages/library/src', 'services/runtime/src', 'services/compiler/src']);
    await command('tar', ['-xf', path.join(root, 'baseline.tar'), '-C', baseline]);
    const ts = (await import('typescript')).default;
    const overrides = {};
    for (const workspace of ['packages/library', 'services/runtime', 'services/compiler']) {
      for (const filename of await files(path.join(baseline, workspace, 'src'))) {
        if (!filename.endsWith('.ts')) continue;
        const relative = path.relative(path.join(baseline, workspace, 'src'), filename);
        const live = path.join(repository, workspace, 'dist', relative.replace(/\.ts$/u, '.js'));
        const source = await fs.readFile(filename, 'utf8');
        overrides[pathToFileURL(live).href] = ts.transpileModule(source, { compilerOptions: {
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        } }).outputText;
      }
    }
    const overrideFile = path.join(root, 'baseline-modules.json');
    await fs.writeFile(overrideFile, JSON.stringify(overrides));
    const loader = path.join(root, 'baseline-loader.mjs');
    await fs.writeFile(loader, `import fs from 'node:fs/promises';
      const map=JSON.parse(await fs.readFile(${JSON.stringify(overrideFile)},'utf8'));
      const roots=${JSON.stringify(['packages/library', 'services/runtime', 'services/compiler'].map(w => pathToFileURL(path.join(repository, w, 'dist') + path.sep).href))};
      export async function load(url,context,nextLoad){
        if(Object.hasOwn(map,url) || (roots.some(root=>url.startsWith(root)) && url.endsWith('.js'))){
          if(!Object.hasOwn(map,url))throw new Error('No committed baseline for '+url);
          return {format:'module',source:map[url],shortCircuit:true};
        }
        return nextLoad(url,context);
      }
    `);
    const bootstrap = path.join(root, 'baseline-bootstrap.mjs');
    await fs.writeFile(bootstrap, `import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},import.meta.url);`);
    const timingBootstrap = path.join(root, 'timing-bootstrap.mjs');
    if (process.env.DKB_QUERY_COST_PROFILE === '1') {
      const timingLoader = path.join(root, 'timing-loader.mjs');
      await fs.writeFile(timingLoader, `
        const names = ['inspectSafePaths', 'assertLocalLibraryStorage', 'openState', 'withStateStore',
          'withLibraryReadSnapshot', 'readLibraryState', 'libraryStateIdentity',
          'getOrOpenRuntimeQueryContext', 'assertQueryContextCurrent', 'finalizeQueryAudit',
          'checkWindowsVolume', 'withNativeLease', 'withCompileLock', 'writeAtomicCompileArtifacts',
          'writePackageBuildGraph', 'validatePackageBuildGraph', 'collectRegistryState', 'withCompilationHost'];
        export async function load(url, context, nextLoad) {
          const loaded = await nextLoad(url, context);
          if (loaded.format !== 'module' || !url.includes('/dist/') || !loaded.source) return loaded;
          let source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
          for (const name of names) {
            const pattern = new RegExp('(export )?async function ' + name + '\\\\(');
            const match = pattern.exec(source);
            if (!match) continue;
            source = source.replace(pattern, 'async function __cost_' + name + '(');
            source += '\\n' + (match[1] ?? '') + 'async function ' + name + '(...args) {'
              + 'const start = performance.now(); try { return await __cost_' + name + '(...args); } finally {'
              + 'const rows = globalThis.__dkbQueryCostPhases; if(rows) { const row=rows[' + JSON.stringify(name)
              + '] ??= {calls:0,totalMs:0}; row.calls++; row.totalMs+=performance.now()-start; }}}';
          }
          return {...loaded, source};
        }
      `);
      await fs.writeFile(timingBootstrap, `import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(timingLoader).href)},import.meta.url);`);
    }
    process.env.DKB_GLOBAL_ROOT = path.join(root, 'global');
    process.env.DKB_CLI_CONFIG = path.join(root, 'global', 'config.json');
    process.env.DKB_HOST_INVENTORY = path.join(root, 'host.json');
    process.env.DKB_RUNTIME_CREDENTIALS_ROOT = path.join(root, 'credentials');
    if (process.argv[3] === '--system') {
      await systemProof(root, baselineCommit, bootstrap, timingBootstrap);
      return;
    }
    const { createQueryFixture } = await import('./runtime-query-fixture.mjs');
    const fixture = await createQueryFixture({ after: fn => cleanup.push(fn) });
    const { closeRuntimeQuerySnapshot } = await import('@sjshovan/dkb-runtime/runtime/state.js');
    await closeRuntimeQuerySnapshot(fixture.runtimeRoot);
    const original = await knowledgeIdentity(fixture.libraryRoot);
    const observations = { baseline: [], candidate: [] };
    let responseDigest;
    for (let round = 0; round < 3; round++) {
      for (const kind of round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
        const cpu = process.env.DKB_QUERY_COST_CPU_PROFILE === '1';
        const cpuName = `${kind}-${round}.cpuprofile`;
        const args = [...(cpu ? ['--cpu-prof', '--cpu-prof-dir=' + root, '--cpu-prof-name=' + cpuName] : []),
          ...(kind === 'baseline' ? ['--import', pathToFileURL(bootstrap).href] : []),
          ...(process.env.DKB_QUERY_COST_PROFILE === '1' ? ['--import', pathToFileURL(timingBootstrap).href] : []),
          fileURLToPath(import.meta.url), '--worker', fixture.runtimeRoot];
        const observation = JSON.parse(await command(process.execPath, args));
        if (cpu) {
          const trace = JSON.parse(await fs.readFile(path.join(root, cpuName), 'utf8'));
          observation.cpu = trace.nodes.filter(row => row.hitCount).sort((a, b) => b.hitCount - a.hitCount).slice(0, 15)
            .map(row => ({ function: row.callFrame.functionName, file: row.callFrame.url, line: row.callFrame.lineNumber + 1, hits: row.hitCount }));
        }
        responseDigest ??= observation.responseDigest;
        assert.equal(observation.responseDigest, responseDigest, 'Both implementations must return byte-identical search results');
        observations[kind].push(observation);
        assert.deepEqual(await knowledgeIdentity(fixture.libraryRoot), original, 'Source/config/build/lock bytes cannot change during search');
        console.log(JSON.stringify({ kind, round: round + 1, ...observation }));
      }
    }
    const baselineMs = median(observations.baseline.map(value => value.medianMs));
    const candidateMs = median(observations.candidate.map(value => value.medianMs));
    const passed = candidateMs <= baselineMs * 1.1;
    console.log(JSON.stringify({
      scope: 'One synthetic lexical record; full audited warm Runtime search; not a TEI/FAISS corpus or compilation benchmark',
      baselineCommit, node: process.version, platform: process.platform,
      rounds: 3, warmupsPerRound: 5, samplesPerRound: 30, baselineMs, candidateMs,
      ratio: candidateMs / baselineMs, noMoreThanTenPercentRegression: passed,
      inputFiles: Object.keys(original).length, responseDigest,
    }));
    if (!passed) process.exitCode = 1;
  } finally {
    for (const dispose of cleanup.reverse()) await dispose();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dkb-library-query-cost-proof-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function systemProof(root, baselineCommit, bootstrap, timingBootstrap) {
  const { SYSTEM_BENCHMARK_FORMAT, compareSystemBenchmarks, summarize } = await import('../scripts/lib/system-benchmark-report.mjs');
  const observations = { baseline: [], candidate: [] };
  const diagnostic = process.env.DKB_QUERY_COST_PROFILE === '1';
  // Six paired runs give each implementation three first/second positions.
  // An odd run count biases medians when host load changes during the proof.
  for (let round = 0; round < (diagnostic ? 2 : 6); round++) {
    for (const kind of round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const directory = path.join(root, `${kind}-${round}`);
      await fs.mkdir(directory);
      const optionsFile = path.join(directory, 'options.json');
      await fs.writeFile(optionsFile, JSON.stringify({ ordinal: round + 1, tier: 'smoke', target: 'minisearch-lexical',
        lexicalExample: true, maxWorkingBytes: 256 * 1024 ** 2, querySamples: 10, warmups: 5 }));
      await command(process.execPath, [...(kind === 'baseline' ? ['--import', pathToFileURL(bootstrap).href] : []),
        ...(diagnostic ? ['--import', pathToFileURL(timingBootstrap).href] : []),
        'scripts/lib/system-benchmark-sample.mjs', optionsFile]);
      const sample = JSON.parse(await fs.readFile(path.join(directory, 'sample.json'), 'utf8'));
      assert.equal(sample.status, 'completed', sample.error?.message);
      observations[kind].push(sample);
      console.log(JSON.stringify({ kind, round: round + 1, scope: 'Existing dense prose/table/code MiniSearch harness',
        records: sample.compile.evidenceRecords, ...summarize([sample]), timingsMs: sample.compile.timingsMs,
        providerStages: sample.compile.providerStages, identityDigest: sample.identityDigest,
        ...(diagnostic ? { diagnostics: sample.diagnostics } : {}) }));
    }
  }
  const report = (samples) => ({ format: SYSTEM_BENCHMARK_FORMAT, status: 'completed', samples,
    identity: samples[0].identity, identityDigest: samples[0].identityDigest });
  if (diagnostic) {
    console.log(JSON.stringify({ diagnosticOnly: true, acceptance: 'not measured under instrumentation', baselineCommit }));
    return;
  }
  const comparison = compareSystemBenchmarks(report(observations.candidate), report(observations.baseline));
  console.log(JSON.stringify({ scope: '128 KiB / eight substantive synthetic files; real MiniSearch compilation, audited search/fetch/insufficiency; not a TEI/FAISS benchmark',
    baselineCommit, baselineModules: ['Library', 'Runtime', 'Compiler'], comparison }));
  if (comparison.status !== 'passed') process.exitCode = 1;
}

async function worker() {
  const { searchRuntime } = await import('@sjshovan/dkb-runtime/runtime/queryAccess.js');
  const { closeRuntimeQuerySnapshot } = await import('@sjshovan/dkb-runtime/runtime/state.js');
  const { DEFAULT_DKB_RUNTIME_CONTEXT: runtime } = await import('@sjshovan/dkb-runtime/defaultComposition.js');
  const stateRoot = process.argv[3];
  const search = () => searchRuntime({ stateRoot, runtime, query: 'RECOVERY-MARKER' });
  try {
    let expected;
    for (let index = 0; index < 5; index++) expected = await search();
    assert.equal(expected.results.length, 1);
    const responseDigest = hash(JSON.stringify(expected));
    const profile = {}, originals = {};
    if (process.env.DKB_QUERY_COST_PROFILE === '1') {
      globalThis.__dkbQueryCostPhases = {};
      for (const method of ['realpath', 'lstat', 'stat', 'access', 'readFile', 'readdir', 'mkdir']) {
        originals[method] = fs[method];
        fs[method] = async (...args) => {
          const start = performance.now();
          try { return await originals[method](...args); }
          finally { const row = profile[method] ??= { calls: 0, totalMs: 0 }; row.calls++; row.totalMs += performance.now() - start; }
        };
      }
    }
    const samples = [];
    for (let index = 0; index < 30; index++) {
      const start = performance.now();
      const result = await search();
      samples.push(performance.now() - start);
      assert.equal(hash(JSON.stringify(result)), responseDigest);
    }
    samples.sort((a, b) => a - b);
    for (const [method, original] of Object.entries(originals)) fs[method] = original;
    console.log(JSON.stringify({ medianMs: median(samples), p95Ms: samples[28], minMs: samples[0], maxMs: samples[29], responseDigest,
      ...(Object.keys(profile).length ? { profile, phases: globalThis.__dkbQueryCostPhases } : {}) }));
  } finally { await closeRuntimeQuerySnapshot(stateRoot); }
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function median(values) { const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }
async function files(root) {
  const result = [];
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, item.name);
    assert.ok(!item.isSymbolicLink());
    if (item.isDirectory()) result.push(...await files(filename));
    else if (item.isFile()) result.push(filename);
  }
  return result.sort();
}
async function knowledgeIdentity(root) {
  const selected = (await files(root)).filter(file => {
    const relative = path.relative(root, file).replace(/\\/gu, '/');
    return !relative.startsWith('.dkb/locks/') && !relative.startsWith('.dkb/state.sqlite') && !relative.startsWith('.dkb/transactions/');
  });
  return Object.fromEntries(await Promise.all(selected.map(async filename => [path.relative(root, filename), hash(await fs.readFile(filename))])));
}
async function command(executable, args) {
  const child = spawn(executable, args, { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try { const [code] = await once(child, 'close'); assert.equal(code, 0, stderr); return stdout; }
  finally { clearTimeout(timer); }
}
