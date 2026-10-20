import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDkb } from '@sjshovan/dkb-protocol/manifest.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { inspectPluginDefinition, runPluginConformance } from '@sjshovan/dkb-pipeline/testing.js';
import { importPluginModule } from '@sjshovan/dkb-pipeline/pluginModule.js';
import type { DkbPluginModule } from '@sjshovan/dkb-pipeline/types.js';

export async function verifyPluginPath(target: string) {
  const { plugin } = await loadPlugin(target);
  const verified = await inspectPluginDefinition(plugin);
  return {
    ok: true as const,
    plugin: { apiVersion: verified.apiVersion, id: verified.id, version: verified.version },
    setupExecuted: false,
    checks: [
      { name: 'Plugin definition', status: 'passed' },
      { name: 'Schema defaults and identity', status: 'passed' },
      { name: 'Runtime contracts', status: 'skipped', detail: `Run dkb plugin test ${JSON.stringify(target)} to execute provider conformance.` },
    ],
  };
}

export async function testPluginPath(target: string, fixture?: string) {
  const { plugin, entrypoint } = await loadPlugin(target);
  const dkb = fixture ? await loadDkb(path.resolve(fixture)) : undefined;
  const report = await runPluginConformance(plugin, { root: path.dirname(entrypoint), ...(dkb ? { dkb } : {}) });
  if (!report.ok) throw new DkbError(`Plugin conformance failed: ${report.checks.filter((check) => check.status === 'failed').map((check) => `${check.name}: ${check.detail}`).join('; ')}`);
  return report;
}

async function loadPlugin(target: string): Promise<{ plugin: Partial<DkbPluginModule>; entrypoint: string }> {
  const resolved = path.resolve(target);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new DkbError(`Plugin path does not exist: ${resolved}`);
  const entrypoint = stat.isDirectory() ? path.join(resolved, 'plugin.mjs') : resolved;
  if (path.basename(entrypoint) !== 'plugin.mjs') throw new DkbError('Plugin path must be a directory containing plugin.mjs or the plugin.mjs file itself.');
  try {
    return { plugin: await importPluginModule(entrypoint, { contextRoot: path.dirname(entrypoint), reload: true }), entrypoint };
  } catch (error) {
    throw new DkbError(`Unable to load plugin ${entrypoint}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
