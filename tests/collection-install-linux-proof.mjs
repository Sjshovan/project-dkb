// Opt-in packaged CLI proof: synthetic Collections, Linux-local databases, no host Library.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly with --run');
const raw = async args => ownerDockerProcess(args, { timeoutMs: 180_000 });
const run = async args => {
  const result = await raw(args);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return result.stdout.trim();
};
const context = await run(['context', 'show']);
const call = args => run(['--context', context, ...args]);
const [contextInfo] = JSON.parse(await call(['context', 'inspect', context]));
assert.match(contextInfo.Endpoints.docker.Host, /^(?:unix:\/\/\/[^\0\r\n]+|npipe:\/{4}\.\/pipe\/[^/\\\s]+)$/u);
const image = await call(['image', 'inspect', process.env.DKB_PROOF_CLI_IMAGE ?? 'dkb-cli:collection-candidate', '--format', '{{.Id}}']);
assert.match(image, /^sha256:[a-f0-9]{64}$/u);
// Recovery tests use the development-only MCP client. Supply only its missing
// pure-JS test dependencies, read-only; never replace the image's product code,
// workspace links, native modules, or full production node_modules tree.
const testDependencies = ['@modelcontextprotocol/client', 'eventsource', 'eventsource-parser', 'pkce-challenge', 'jose'];
const testMounts = testDependencies.flatMap(name => ['--mount',
  `type=bind,src=${fileURLToPath(new URL(`../node_modules/${name}/`, import.meta.url))},dst=/workspace/node_modules/${name},readonly`]);
const id = randomUUID(), volume = `dkb-collection-proof-${id}`, container = `${volume}-suite`;
const labelKey = 'dev.dkb.collection-proof';
let created = false;
try {
  await call(['volume', 'create', '--driver', 'local', '--label', `${labelKey}=${id}`, volume]);
  created = true;
  const [metadata] = JSON.parse(await call(['volume', 'inspect', volume]));
  assert.equal(metadata.Driver, 'local');
  assert.equal(metadata.Labels[labelKey], id);
  assert.equal(Object.keys(metadata.Options ?? {}).length, 0);
  const suite = files => call(['run', '--rm', '--pull', 'never', '--name', container,
    '--label', `${labelKey}=${id}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${volume},dst=/proof,volume-nocopy`,
    '--mount', `type=bind,src=${fileURLToPath(new URL('.', import.meta.url))},dst=/workspace/tests,readonly`,
    ...testMounts,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--env', 'TMPDIR=/proof', '--env', 'DKB_HOST_INVENTORY=/proof/host.json',
    '--entrypoint', 'node', image, '--import', './tests/test-environment.mjs', '--test', '--test-concurrency=2', ...files]);
  const output = await suite([
    'tests/collection-install-trust.test.mjs', 'tests/registry-collection-contract.test.mjs',
    'tests/runtime-library-recovery.test.mjs', 'tests/library-contract.test.mjs', 'tests/library-owner-install.test.mjs',
    'tests/collection-grant-install.test.mjs', 'tests/library-install-transport.test.mjs',
    'tests/package-library-destination.test.mjs', 'tests/library-owner-removal.test.mjs']);
  console.log(output);
  assert.match(output, /# fail 0\b/u);
  assert.match(output, /# skipped 0\b/u);
  const managed = await suite(['--test-name-pattern=managed retention|managed cleanup|Runtime validates managed|managed preparation|failed activation',
    'tests/runtime-pipeline-switch.test.mjs']);
  console.log(managed);
  assert.match(managed, /# fail 0\b/u);
  assert.match(managed, /# skipped 0\b/u);
  console.log(JSON.stringify({ status: 'passed', image, scope: 'packaged Collection verifier, grant adapter, and atomic lifecycle on Linux-local storage; separate live owner proof verifies host delegation' }));
} finally {
  const existing = await raw(['--context', context, 'container', 'inspect', container]);
  if (existing.code === 0) {
    assert.equal(JSON.parse(existing.stdout)[0].Config.Labels[labelKey], id);
    await call(['container', 'rm', '--force', container]);
  } else assert.match(existing.stderr, /No such (?:object|container)/iu);
  if (created) {
    const [metadata] = JSON.parse(await call(['volume', 'inspect', volume]));
    assert.equal(metadata.Labels[labelKey], id);
    await call(['volume', 'rm', volume]);
  }
}
