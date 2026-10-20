import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeBundledIntegrityReceipt } from '@sjshovan/dkb-pipeline/bundledIntegrity.js';

const BRIDGE_KEY = 'dkb.test.bundled-provider-fixture.bridge.v1';

/**
 * Materialize real ESM entrypoints for host contract fixtures. They obtain
 * test-owned closures through a per-package bridge, not a production callback.
 * Closure source is receipt-bound, but this does not prove executable provenance;
 * independent bundled release tests must load self-contained provider packages.
 */
export async function materializeBundledProviderFixtures(t, distribution) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-bundled-contract-fixture-'));
  const symbol = Symbol.for(BRIDGE_KEY);
  const bridge = globalThis[symbol] ??= new Map();
  const entries = [];
  t.after(async () => {
    for (const entry of entries) bridge.delete(entry);
    if (bridge.size === 0 && globalThis[symbol] === bridge) delete globalThis[symbol];
    await fs.rm(root, { recursive: true, force: true });
  });
  const plugins = [];
  for (const [index, descriptor] of distribution.plugins.entries()) {
    const packageRoot = path.join(root, String(index));
    const entrypoint = path.join(packageRoot, 'dist', 'plugin.mjs');
    const identity = {
      apiVersion: descriptor.apiVersion, id: descriptor.id, version: descriptor.version,
      protocols: descriptor.integrity.protocols, artifactFormats: descriptor.integrity.artifactFormats,
    };
    const sourceUrl = pathToFileURL(entrypoint).href;
    bridge.set(sourceUrl, { ...descriptor, integrity: identity, sourceUrl });
    entries.push(sourceUrl);
    await fs.mkdir(path.dirname(entrypoint), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
      name: descriptor.id, version: descriptor.version, type: 'module', files: ['dist/'],
    }, null, 2)}\n`);
    await fs.writeFile(entrypoint, [
      '// Host contract fixture: closure state is supplied only by the owning test.',
      '// Real ESM loading is exercised; this bridge is not executable provenance proof.',
      `export const fixture = ${JSON.stringify({
        ...identity,
        setupSource: String(descriptor.setup),
        optionsSchemaSource: String(descriptor.optionsSchema['~standard'].validate),
        ...(descriptor.identity === undefined ? {} : { identitySource: typeof descriptor.identity === 'function' ? String(descriptor.identity) : descriptor.identity }),
      }, null, 2)};`,
      'const entry = new URL(import.meta.url);',
      "entry.search = ''; entry.hash = '';",
      `const descriptor = globalThis[Symbol.for(${JSON.stringify(BRIDGE_KEY)})]?.get(entry.href);`,
      "if (!descriptor) throw new Error('Bundled contract fixture bridge is unavailable');",
      'export const PLUGIN = descriptor;',
      '',
    ].join('\n'));
    await writeBundledIntegrityReceipt({ packageRoot, entrypoint, identity });
    plugins.push({ id: descriptor.id, version: descriptor.version, sourceUrl, exportName: 'PLUGIN' });
  }
  return { ...distribution, plugins };
}
