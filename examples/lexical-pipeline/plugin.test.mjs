import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from './plugin.mjs';
import { runPluginConformance } from '@sjshovan/dkb-pipeline/testing.js';

test('MiniSearch lexical providers pass the same public SDK conformance suite', async () => {
  const report = await runPluginConformance(plugin);
  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
  assert.deepEqual(report.registrations.providers, ['parser', 'chunker', 'index', 'retrieval']);
});
