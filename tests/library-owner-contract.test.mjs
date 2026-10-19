import assert from 'node:assert/strict';
import test from 'node:test';
import { LIBRARY_OWNER_FORMAT, planLibraryOwnerCommand, libraryOwnerMutates } from '../apps/cli/dist/host/libraryOwnerContract.js';
import { assertLocalOwnerVolume, validateDockerLibraryOwner } from '../apps/cli/dist/host/libraryOwner.js';

const request = (command, input = {}, output = 'json') => ({ format: LIBRARY_OWNER_FORMAT, command, input, output });

test('owner operations map to the existing CLI with a fixed Library context', () => {
  for (const command of ['status', 'storage', 'sync', 'recover']) {
    assert.deepEqual(planLibraryOwnerCommand(request(`library.${command}`)).argv, ['--json', 'library', command, '--library', '/library']);
  }
  assert.deepEqual(planLibraryOwnerCommand(request('library.packages')).argv, ['--json', 'list', '--library', '/library']);
  assert.deepEqual(planLibraryOwnerCommand(request('library.registry.use', { registryUrl: 'https://registry.example' })).argv,
    ['--json', 'registry', 'use', 'https://registry.example/', '--root', '/library', '--no-verify']);
  assert.deepEqual(planLibraryOwnerCommand(request('package.show', { identity: '@proof/example', verify: true })).argv,
    ['--json', 'show', '@proof/example', '--library', '/library', '--verify']);
  for (const command of ['add', 'remove']) {
    assert.deepEqual(planLibraryOwnerCommand(request(`library.${command}`, { identity: '@proof/example' })).argv,
      ['--json', 'library', command, '@proof/example', '--library', '/library']);
  }
  for (const kind of ['package', 'collection']) {
    const command = `${kind}.uninstall`;
    assert.equal(libraryOwnerMutates(command), true);
    assert.deepEqual(planLibraryOwnerCommand(request(command, { identity: '@proof/example' })).argv,
      ['--json', ...(kind === 'collection' ? ['collection'] : []), 'uninstall', '@proof/example', '--library', '/library']);
    assert.throws(() => planLibraryOwnerCommand(request(command, { identity: '@proof/example', runtimeUrl: 'http://localhost:7331' })),
      { code: 'invalid_library_owner_request' });
    assert.throws(() => planLibraryOwnerCommand(request(command, { identity: '../outside' })));
  }
});

test('owner protocol retains machine, event, and human output without shell evaluation', () => {
  const text = 'Library ; $(not-a-command)';
  const value = request('library.init', { displayName: text, registryUrl: 'http://127.0.0.1:1' }, 'json-stream');
  const plan = planLibraryOwnerCommand(value);
  assert.deepEqual(plan.argv, ['--json-stream', 'init', '--dir', '/library', '--yes', '--no-verify', '--registry-url', 'http://127.0.0.1:1/', '--display-name', text]);
  assert.equal(planLibraryOwnerCommand(request('library.status', {}, 'human')).argv[0], '--no-progress');
  assert.notEqual(plan.request, value);
  assert.notEqual(plan.request.input, value.input);
});

test('owner protocol rejects raw commands, paths, secret parameters and flag injection', () => {
  const invalid = [
    null, [], {}, { ...request('library.status'), format: 'legacy' },
    request('exec', { argv: ['sh'] }), request('library.status', { library: 'C:/private' }),
    { ...request('library.status'), environment: { TOKEN: 'synthetic' } },
    request('library.status', { token: 'synthetic' }), request('library.status', {}, 'raw'),
    request('library.add', { identity: '--help' }), request('library.remove', { identity: '../elsewhere' }),
    request('package.show', { identity: '@proof/example', verify: 'false' }),
    request('library.init', { registryUrl: 'https://user:secret@example.test' }),
    request('library.init', { registryUrl: 'https://example.test?token=synthetic' }),
    request('library.init', { registryUrl: 'file:///private' }),
    request('library.registry.use', { registryUrl: 'https://user:secret@example.test' }),
    request('library.registry.use', { registryUrl: 'https://example.test?token=synthetic' }),
    request('library.registry.use', { registryUrl: 'https://example.test', root: '/other' }),
    request('library.init', { registryUrl: 'https://example.test', displayName: '--dir=/other' }),
    request('library.init', { registryUrl: 'https://example.test', displayName: 'bad\nname' }),
  ];
  for (const value of invalid) assert.throws(() => planLibraryOwnerCommand(value));
});

test('Docker owner handles accept only explicit context, volume and immutable image', () => {
  const valid = { context: 'desktop-linux', volume: 'proof-library', image: `sha256:${'a'.repeat(64)}` };
  assert.deepEqual(validateDockerLibraryOwner(valid), valid);
  for (const change of [
    { image: 'node:latest' }, { volume: '/host/path' }, { volume: 'lib,dst=/etc' },
    { context: '--host=evil' }, { context: 'local;command' }, { network: 'host' }, { image: undefined },
  ]) assert.throws(() => validateDockerLibraryOwner({ ...valid, ...change }), { code: 'invalid_library_owner' });
});

test('local volume name is insufficient: reject remote and bind driver options', () => {
  const valid = { Name: 'proof', Driver: 'local', Scope: 'local', Options: null, Mountpoint: '/var/lib/docker/volumes/proof/_data' };
  assert.doesNotThrow(() => assertLocalOwnerVolume(valid, 'proof'));
  assert.doesNotThrow(() => assertLocalOwnerVolume({ ...valid, Options: {} }, 'proof'));
  for (const change of [
    { Driver: 'nfs' }, { Scope: 'global' }, { Options: { type: 'nfs', device: 'server:/data' } },
    { Options: { type: 'none', o: 'bind', device: '/host/path' } }, { Options: [] },
    { Options: undefined }, { Mountpoint: 'C:/data' }, { Name: 'another' },
  ]) assert.throws(() => assertLocalOwnerVolume({ ...valid, ...change }, 'proof'), { code: 'unsupported_library_owner_volume' });
});
