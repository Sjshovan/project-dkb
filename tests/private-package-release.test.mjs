import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { c as createTar } from 'tar';
import { parse as parseYaml } from 'yaml';
import { distributableWorkspaces } from '../scripts/package-policy.mjs';
import { releasePackageCandidates, verifyPackageCandidates } from '../scripts/release-package-candidates.mjs';

async function candidates(t, overrides = {}, extraFiles = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-private-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'release');
  await fs.mkdir(directory);
  const packages = [];
  for (const [index, name] of distributableWorkspaces.entries()) {
    const manifest = { name, version: '1.0.0', private: false,
      ...(index ? { dependencies: { [distributableWorkspaces[index - 1]]: '1.0.0' } } : {}), ...overrides[name] };
    const source = path.join(root, `source-${index}`);
    await fs.mkdir(path.join(source, 'package'), { recursive: true });
    await fs.writeFile(path.join(source, 'package', 'package.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(source, 'package', 'index.js'), 'export const fixture = true;\n');
    for (const filename of extraFiles[name] ?? []) await fs.writeFile(path.join(source, 'package', filename), 'synthetic fixture');
    const filename = `${name.replace(/^@/u, '').replace('/', '-')}-1.0.0.tgz`;
    const archive = path.join(directory, filename);
    await createTar({ cwd: source, file: archive, gzip: true, portable: true }, ['package']);
    const bytes = await fs.readFile(archive);
    packages.push({ name, version: manifest.version, private: manifest.private === true, filename, size: bytes.length,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex') });
  }
  const document = { status: 'packed', packages };
  const save = () => fs.writeFile(path.join(directory, 'candidates.json'), JSON.stringify(document));
  await save();
  return { directory, document, save };
}

const first = distributableWorkspaces[0];
const last = distributableWorkspaces.at(-1);

test('candidate verification is offline by default and reports intentional publication blockers', async t => {
  const fixture = await candidates(t, { [last]: { private: true } });
  let writes = 0;
  assert.deepEqual(await releasePackageCandidates({ directory: fixture.directory, execute: async () => { writes++; } }), {
    status: 'verified', packages: 15, publicationBlockedBy: [last],
  });
  await assert.rejects(releasePackageCandidates({ directory: fixture.directory, publish: true, execute: async () => { writes++; } }),
    /Publication blocked before any upload.*private:true/u);
  assert.equal(writes, 0, 'a private dependency anywhere in the set prevents every upload');
});

test('the actual archive private flag cannot be hidden by editing candidate metadata', async t => {
  const fixture = await candidates(t, { [last]: { private: true } });
  fixture.document.packages.at(-1).private = false;
  await fixture.save();
  let writes = 0;
  await assert.rejects(releasePackageCandidates({ directory: fixture.directory, publish: true, execute: async () => { writes++; } }), /manifest does not match/u);
  assert.equal(writes, 0);
});

test('all archive hashes are checked before any publication', async t => {
  const fixture = await candidates(t);
  const archive = path.join(fixture.directory, fixture.document.packages.at(-1).filename);
  const bytes = await fs.readFile(archive);
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(archive, bytes);
  let writes = 0;
  await assert.rejects(releasePackageCandidates({ directory: fixture.directory, publish: true, execute: async () => { writes++; } }), /integrity mismatch/u);
  assert.equal(writes, 0, 'a corrupt final candidate must not leave earlier packages published');
});

test('candidate preflight rejects incomplete, duplicate, unknown, unsafe, and unlisted archive sets', async t => {
  const fixture = await candidates(t);
  const original = structuredClone(fixture.document.packages);
  for (const [mutate, expected] of [
    [packages => packages.pop(), /all 15/u],
    [packages => { packages[1].name = first; }, /duplicate workspace/u],
    [packages => { packages[1].name = '@unrelated/package'; }, /unknown/u],
    [packages => { packages[1].filename = '../outside.tgz'; }, /unsafe/u],
    [packages => { packages[1].filename = packages[0].filename; }, /duplicate filename/u],
  ]) {
    fixture.document.packages = structuredClone(original);
    mutate(fixture.document.packages);
    await fixture.save();
    await assert.rejects(verifyPackageCandidates(fixture.directory), expected);
  }
  fixture.document.packages = original;
  await fixture.save();
  await fs.writeFile(path.join(fixture.directory, 'unreviewed.tgz'), 'unreviewed');
  await assert.rejects(verifyPackageCandidates(fixture.directory), /unlisted files/u);
});

test('candidate preflight requires exact internal dependency coverage and the private GitHub destination', async t => {
  for (const [override, expected] of [
    [{ dependencies: { [first]: '2.0.0' } }, /no exact dependency candidate/u],
    [{ optionalDependencies: { '@sjshovan/dkb-unknown': '1.0.0' } }, /no exact dependency candidate/u],
    [{ peerDependencies: { [first]: '^1.0.0' } }, /no exact dependency candidate/u],
    [{ publishConfig: { registry: 'https://registry.npmjs.org' } }, /non-GitHub/u],
  ]) {
    const fixture = await candidates(t, { [last]: override });
    let writes = 0;
    await assert.rejects(releasePackageCandidates({ directory: fixture.directory, publish: true, execute: async () => { writes++; } }), expected);
    assert.equal(writes, 0);
  }
});

test('candidate preflight reuses package archive inspection before publication', async t => {
  const fixture = await candidates(t, {}, { [last]: ['.env'] });
  let writes = 0;
  await assert.rejects(releasePackageCandidates({ directory: fixture.directory, publish: true, execute: async () => { writes++; } }), /forbidden files/u);
  assert.equal(writes, 0);
});

test('publication consumes exactly the reviewed archives without repacking or scripts', async t => {
  const fixture = await candidates(t);
  fixture.document.packages.reverse();
  await fixture.save();
  const invocations = [];
  const result = await releasePackageCandidates({ directory: fixture.directory, publish: true, npmCli: '/fixture/npm-cli.js',
    execute: async (command, args, options) => { invocations.push({ command, args, options }); } });
  assert.equal(result.status, 'published');
  assert.equal(invocations.length, 15);
  for (const [index, invocation] of invocations.entries()) {
    const candidate = fixture.document.packages.find(entry => entry.name === distributableWorkspaces[index]);
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, ['/fixture/npm-cli.js', 'publish', path.join(fixture.directory, candidate.filename),
      '--ignore-scripts', '--registry=https://npm.pkg.github.com', '--access=restricted', '--tag=preview']);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.cwd, fixture.directory);
  }
  assert.equal((await verifyPackageCandidates(fixture.directory)).length, 15, 'publication never changes reviewed archive bytes');
});

test('publication stops on the first failure and reports non-atomic partial success', async t => {
  const fixture = await candidates(t);
  let calls = 0;
  await assert.rejects(releasePackageCandidates({ directory: fixture.directory, publish: true, npmCli: '/fixture/npm-cli.js',
    execute: async () => { if (++calls === 2) throw Object.assign(new Error('Synthetic upload failure'), { code: 'EUPLOAD' }); } }),
  error => {
    assert.match(error.message, /after 1\/15 successful uploads/u);
    assert.match(error.message, /not atomic; reconcile the exact candidate digests/u);
    assert.match(error.message, /Published: @sjshovan\/dkb-protocol@1\.0\.0/u);
    return true;
  });
  assert.equal(calls, 2);
});

test('an archive changed after preflight is not published later in the sequence', async t => {
  const fixture = await candidates(t);
  let calls = 0;
  await assert.rejects(releasePackageCandidates({ directory: fixture.directory, publish: true, npmCli: '/fixture/npm-cli.js',
    execute: async () => {
      calls++;
      await fs.appendFile(path.join(fixture.directory, fixture.document.packages[1].filename), 'changed');
    } }), /after 1\/15 successful uploads/u);
  assert.equal(calls, 1);
});

test('private release workflow packages once, retains exact candidates, and publishes only by explicit opt-in', async () => {
  const source = await fs.readFile('.github/workflows/private-packages.yml', 'utf8');
  const workflow = parseYaml(source);
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const steps = workflow.jobs['verify-and-package'].steps;
  assert.ok(steps.some(step => step.run?.includes('--jq .visibility') && step.run.includes('private')));
  assert.equal(steps.filter(step => step.run?.includes('package-distribution.mjs --output release')).length, 1);
  const publisher = steps.find(step => step.run?.includes('--directory release --publish'));
  assert.equal(publisher.if, '${{ inputs.publish }}');
  assert.ok(publisher.run.includes('Pending Changesets'));
  assert.doesNotMatch(source, /changeset publish|npm pack --workspace/u);
  assert.ok(steps.find(step => step.uses?.startsWith('actions/upload-artifact')).with.path.includes('release/candidates.json'));
  const draft = steps.find(step => step.run?.includes('gh release create'));
  assert.equal(draft.if, '${{ inputs.publish }}');
  assert.ok(draft.run.includes('release/*.tgz release/candidates.json'));
});
