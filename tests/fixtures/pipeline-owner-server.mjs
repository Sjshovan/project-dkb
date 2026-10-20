// Synthetic, opt-in Docker proof only. Nothing in this file ships with DKB.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createQueryFixture } from '../runtime-query-fixture.mjs';
import { signRuntimeFixture } from '../runtime-trust-fixture.mjs';
import { serveDkbRuntime } from '@sjshovan/dkb-runtime/runtime/server.js';

const descriptorPath = '/proof/descriptor.json';
let descriptor;
try { descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const fixture = await signRuntimeFixture(await createQueryFixture({ after() {} }), {
    downloadable: true, origin: process.env.DKB_PROOF_REGISTRY_ORIGIN,
  });
  descriptor = { runtimeRoot: fixture.runtimeRoot, packageId: fixture.packageId, plan: fixture.plan, keys: fixture.keys,
    layerBytes: Object.fromEntries([...fixture.layerBytes].map(([kind, bytes]) => [kind, bytes.toString('base64')])) };
  assert.ok(path.resolve(fixture.graph.retrievalPath).startsWith('/proof/'));
  await fs.rm(fixture.graph.retrievalPath, { recursive: true });
  await fs.writeFile(descriptorPath, JSON.stringify(descriptor));
}
await serveDkbRuntime({ stateRoot: descriptor.runtimeRoot, host: '0.0.0.0', port: 7331, adminToken: 'synthetic-proof-admin',
  runtime: { distribution: { id: '@test/pipeline-owner', version: '1.0.0', defaults: { format: 'dkb.config.v2' }, plugins: [], services: [] } } });
console.log('PIPELINE_OWNER_READY');
