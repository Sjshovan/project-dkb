import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  hostInventoryPath,
  readHostInventory,
  registerHostLibrary,
  registerHostRegistry,
  registerHostRuntime,
  registeredHostLibrary,
  selectHostLibrary,
  selectHostRuntime,
  unregisterHostLibrary,
  unregisterHostRegistry,
} from '../apps/cli/dist/host/inventory.js';
import { inspectHostLibraries } from '../apps/cli/dist/host/inspection.js';
import { resolveCliLibraryRoot, resolveCliRuntimeUrl } from '../apps/cli/dist/cli/context.js';
import { configuredRegistry, writeConfiguredRegistryUrl } from '../apps/cli/dist/cli/registryConfig.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repositoryRoot, 'apps', 'cli', 'dist', 'cli', 'index.js');

test('host inventory registers Libraries and Registries without storing secrets', async () => {
  await withInventory(async ({ inventoryPath, root }) => {
    const libraryRoot = await writeLibrary(path.join(root, 'personal'), 'Personal Knowledge', 'https://registry.example');
    const registered = await registerHostLibrary(libraryRoot, { name: 'personal', select: true });
    const repeated = await registerHostLibrary(libraryRoot);
    const inventory = await readHostInventory();

    assert.equal(registered.name, 'personal');
    assert.equal(repeated.name, 'personal');
    assert.equal(inventory.selected.library, 'personal');
    assert.equal(inventory.libraries.personal.path, await fs.realpath(libraryRoot));
    assert.equal(inventory.libraries.personal.registry, registered.registry.name);
    if (process.platform === 'win32') {
      assert.equal((await registeredHostLibrary(libraryRoot.toUpperCase())).name, 'personal');
    }
    assert.equal(Object.keys(inventory.registries).length, 1);
    assert.doesNotMatch(await fs.readFile(inventoryPath, 'utf8'), /token|password|secret/iu);
    assert.equal(hostInventoryPath(), inventoryPath);
  });
});

test('host inventory generates collision-safe names and deduplicates Registry URLs', async () => {
  await withInventory(async ({ root }) => {
    const firstRoot = await writeLibrary(path.join(root, 'first'), 'Same Name');
    const secondRoot = await writeLibrary(path.join(root, 'second'), 'Same Name');
    const first = await registerHostLibrary(firstRoot);
    const second = await registerHostLibrary(secondRoot);

    assert.equal(first.name, 'same-name');
    assert.match(second.name, /^same-name-[a-f0-9]{8}$/u);
    await assert.rejects(
      registerHostLibrary(secondRoot, { name: 'different' }),
      /already registered as/,
    );

    await registerHostRegistry('primary', 'https://registry.example/');
    await assert.rejects(
      registerHostRegistry('duplicate', 'https://registry.example'),
      /already registered as primary/,
    );
  });
});

test('host inventory serializes concurrent mutations without losing entries', async () => {
  await withInventory(async ({ root }) => {
    const libraries = await Promise.all(Array.from({ length: 8 }, async (_, index) =>
      writeLibrary(path.join(root, `library-${index}`), `Library ${index}`)));

    await Promise.all(libraries.map((library) => registerHostLibrary(library)));

    const inventory = await readHostInventory();
    assert.equal(Object.keys(inventory.libraries).length, libraries.length);
  });
});

test('host inventory rejects malformed or secret-bearing documents', async () => {
  await withInventory(async ({ inventoryPath }) => {
    await fs.mkdir(path.dirname(inventoryPath), { recursive: true });
    await fs.writeFile(inventoryPath, '{not-json}\n');
    await assert.rejects(readHostInventory(), /Invalid DKB host inventory JSON/);

    await fs.writeFile(inventoryPath, `${JSON.stringify({
      format: 'dkb.host.v1',
      selected: {},
      libraries: {},
      registries: {
        unsafe: {
          url: 'https://registry.example',
          token: 'must-not-be-stored',
          registeredAt: '2026-08-26T00:00:00.000Z',
          updatedAt: '2026-08-26T00:00:00.000Z',
        },
      },
      runtimes: {},
    })}\n`);
    await assert.rejects(readHostInventory(), /unexpected fields token/);
  });
});

test('Library listing preserves missing entries and unregister never deletes source', async () => {
  await withInventory(async ({ root }) => {
    const libraryRoot = await writeLibrary(path.join(root, 'movable'), 'Movable');
    await registerHostLibrary(libraryRoot, { name: 'movable', select: true });
    await fs.rename(libraryRoot, `${libraryRoot}-moved`);

    const listing = await inspectHostLibraries();
    assert.equal(listing.libraries[0].status, 'missing');

    const removed = await unregisterHostLibrary('movable');
    assert.equal(removed.selectedCleared, true);
    assert.equal(await exists(`${libraryRoot}-moved`), true);
  });
});

test('Library resolution honors explicit, environment, nearest, then selected precedence', async () => {
  await withInventory(async ({ root }) => {
    const selectedRoot = await writeLibrary(path.join(root, 'selected'), 'Selected');
    const nearestRoot = await writeLibrary(path.join(root, 'nearest'), 'Nearest');
    const nested = path.join(nearestRoot, 'nested');
    await fs.mkdir(nested, { recursive: true });
    await registerHostLibrary(selectedRoot, { name: 'selected', select: true });
    await registerHostLibrary(nearestRoot, { name: 'nearest' });

    assert.equal(await resolveCliLibraryRoot({ cwd: root }), await fs.realpath(selectedRoot));
    assert.equal(await resolveCliLibraryRoot({ cwd: nested }), await fs.realpath(nearestRoot));

    process.env.DKB_LIBRARY_PATH = selectedRoot;
    assert.equal(await resolveCliLibraryRoot({ cwd: nested }), await fs.realpath(selectedRoot));
    assert.equal(await resolveCliLibraryRoot({ explicit: 'nearest', cwd: root }), await fs.realpath(nearestRoot));
    delete process.env.DKB_LIBRARY_PATH;
  });
});

test('selected Runtime is used only after explicit and environment URLs', async () => {
  await withInventory(async () => {
    assert.equal(await resolveCliRuntimeUrl(), 'http://127.0.0.1:7331');
    await registerHostRuntime('home', 'https://runtime.example', { select: true });

    assert.equal(await resolveCliRuntimeUrl(), 'https://runtime.example');
    process.env.DKB_RUNTIME_URL = 'https://environment-runtime.example';
    assert.equal(await resolveCliRuntimeUrl(), 'https://environment-runtime.example');
    assert.equal(await resolveCliRuntimeUrl('https://explicit-runtime.example'), 'https://explicit-runtime.example');
    delete process.env.DKB_RUNTIME_URL;
  });
});

test('selected Registry is used after project and environment configuration but before user fallback', async () => {
  await withInventory(async ({ root }) => {
    const userConfig = path.join(root, 'user-config.json');
    const projectRoot = await writeLibrary(path.join(root, 'project'), 'Project', 'https://project.example');
    process.env.DKB_CLI_CONFIG = userConfig;
    await writeConfiguredRegistryUrl('https://user.example', { global: true });
    await registerHostRegistry('selected', 'https://selected.example', { select: true });

    assert.equal((await configuredRegistry({ root: path.join(root, 'unconfigured') })).source, 'host');
    assert.equal((await configuredRegistry({ root: path.join(root, 'unconfigured') })).url, 'https://selected.example');
    assert.equal((await configuredRegistry({ root: projectRoot })).source, 'project');
    process.env.DKB_REGISTRY_URL = 'https://environment.example';
    assert.equal((await configuredRegistry({ root: projectRoot })).source, 'environment');
  });
});

test('Registry unregister is blocked while a registered Library references it', async () => {
  await withInventory(async ({ root }) => {
    const libraryRoot = await writeLibrary(path.join(root, 'dependent'), 'Dependent', 'https://registry.example');
    await registerHostRegistry('primary', 'https://registry.example');
    await registerHostLibrary(libraryRoot);

    await assert.rejects(unregisterHostRegistry('primary'), /still used by dependent/);
  });
});

test('focused host commands and selected Library work from an unrelated directory', async () => {
  await withInventory(async ({ root, inventoryPath }) => {
    const libraryRoot = await writeLibrary(path.join(root, 'consumer'), 'Consumer', 'http://127.0.0.1:8018');
    const unrelated = path.join(root, 'unrelated');
    await fs.mkdir(unrelated, { recursive: true });
    const environment = {
      DKB_HOST_INVENTORY: inventoryPath,
      DKB_CLI_CONFIG: path.join(root, 'config.json'),
      DKB_REGISTRY_URL: '',
    };

    assert.equal((await runCli(['--json', 'registry', 'register', 'proof', 'http://127.0.0.1:8018', '--no-verify'], environment, unrelated)).code, 0);
    assert.equal((await runCli(['--json', 'library', 'register', libraryRoot, '--name', 'consumer'], environment, unrelated)).code, 0);
    assert.equal((await runCli(['--json', 'library', 'use', 'consumer'], environment, unrelated)).code, 0);

    const libraries = await runCli(['--json', 'library', 'list'], environment, unrelated);
    const registries = await runCli(['--json', 'registry', 'list'], environment, unrelated);
    const packages = await runCli(['--json', 'list'], environment, unrelated);
    const humanLibraries = await runCli(['library', 'list'], environment, unrelated);

    assert.equal(libraries.code, 0, libraries.stderr);
    assert.equal(JSON.parse(libraries.stdout).selected, 'consumer');
    assert.equal(JSON.parse(registries.stdout).registries[0].usedBy[0], 'consumer');
    assert.equal(packages.code, 0, packages.stderr);
    assert.equal(JSON.parse(packages.stdout).libraryRoot, await fs.realpath(libraryRoot));
    assert.match(humanLibraries.stdout, /DEFAULT\s+NAME\s+STATUS\s+REGISTRY\s+PATH/);
    assert.doesNotMatch(humanLibraries.stdout, /SELECTED/);
  });
});

test('offline Registry and Runtime checks report status without failing the inventory list', async () => {
  await withInventory(async ({ root, inventoryPath }) => {
    const environment = {
      DKB_HOST_INVENTORY: inventoryPath,
      DKB_CLI_CONFIG: path.join(root, 'config.json'),
      DKB_REGISTRY_URL: '',
    };
    const registry = await runCli(['--json', 'registry', 'register', 'offline', 'http://127.0.0.1:1', '--no-verify'], environment, root);
    const runtime = await runCli(['--json', 'runtime', 'register', 'offline', 'http://127.0.0.1:2', '--no-verify'], environment, root);

    assert.equal(registry.code, 0, registry.stderr);
    assert.equal(runtime.code, 0, runtime.stderr);

    const registries = await runCli(['--json', 'registry', 'list', '--check'], environment, root);
    const runtimes = await runCli(['--json', 'runtime', 'list', '--check'], environment, root);
    const humanRegistries = await runCli(['registry', 'list'], environment, root);
    const humanRuntimes = await runCli(['runtime', 'list'], environment, root);

    assert.equal(registries.code, 0, registries.stderr);
    assert.equal(runtimes.code, 0, runtimes.stderr);
    assert.equal(JSON.parse(registries.stdout).registries[0].status, 'unavailable');
    assert.equal(JSON.parse(runtimes.stdout).runtimes[0].status, 'offline');
    assert.match(humanRegistries.stdout, /DEFAULT\s+NAME\s+STATUS\s+USED BY\s+URL/);
    assert.match(humanRuntimes.stdout, /DEFAULT\s+NAME\s+KIND\s+STATUS\s+LIBRARY\s+URL/);
    assert.doesNotMatch(`${humanRegistries.stdout}${humanRuntimes.stdout}`, /SELECTED/);
  });
});

async function withInventory(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-host-inventory-'));
  const inventoryPath = path.join(root, '.dkb', 'host.json');
  const previousInventory = process.env.DKB_HOST_INVENTORY;
  const previousLibrary = process.env.DKB_LIBRARY_PATH;
  const previousRuntime = process.env.DKB_RUNTIME_URL;
  const previousRegistry = process.env.DKB_REGISTRY_URL;
  const previousCliConfig = process.env.DKB_CLI_CONFIG;

  process.env.DKB_HOST_INVENTORY = inventoryPath;
  delete process.env.DKB_LIBRARY_PATH;
  delete process.env.DKB_RUNTIME_URL;
  delete process.env.DKB_REGISTRY_URL;
  process.env.DKB_CLI_CONFIG = path.join(root, '.dkb', 'config.json');

  try {
    await action({ root, inventoryPath });
  } finally {
    restoreEnvironment('DKB_HOST_INVENTORY', previousInventory);
    restoreEnvironment('DKB_LIBRARY_PATH', previousLibrary);
    restoreEnvironment('DKB_RUNTIME_URL', previousRuntime);
    restoreEnvironment('DKB_REGISTRY_URL', previousRegistry);
    restoreEnvironment('DKB_CLI_CONFIG', previousCliConfig);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeLibrary(root, name, registryUrl) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1,
    type: 'library',
    name,
    roots: {},
    ...(registryUrl ? { registry: { url: registryUrl } } : {}),
  }, null, 2)}\n`);
  return root;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function runCli(args, extraEnv, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, DKB_FORCE_TTY: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
