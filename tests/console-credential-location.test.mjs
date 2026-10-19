import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRoot } from './runtime-query-fixture.mjs';
import { ConsoleCommandRunner } from '@sjshovan/dkb-console';
import { ConsoleActivityStore } from '../apps/console/dist/server/activity.js';

test('Console preserves the operator credential-file location without forwarding Registry bearer variables', async t => {
  const { root } = await createRoot(t);
  const keys = ['DKB_REGISTRY_CREDENTIALS', 'DKB_REGISTRY_TOKEN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  process.env.DKB_REGISTRY_CREDENTIALS = path.join(root, 'private', 'credentials.json');
  process.env.DKB_REGISTRY_TOKEN = 'must-not-cross-the-console-environment';
  const entry = path.join(root, 'cli.mjs');
  await fs.writeFile(entry, `
    const value = { credentialPath: process.env.DKB_REGISTRY_CREDENTIALS,
      hasBearer: Boolean(process.env.DKB_REGISTRY_TOKEN), args: process.argv.slice(2) };
    [{event:'start',label:'Check'}, {event:'result',value}, {event:'completion',status:'succeeded'}]
      .forEach((event,sequence)=>console.log(JSON.stringify({format:'dkb.command-event.v1',sequence,
        timestamp:new Date().toISOString(),...event})));
  `);
  const activity = new ConsoleActivityStore(path.join(root, 'activity.sqlite'));
  const runner = new ConsoleCommandRunner({ cliEntrypoint: entry, cwd: root, activity });
  try {
    const operation = await runner.run('registry.list', {});
    assert.equal(operation.status, 'succeeded');
    assert.equal(operation.result.credentialPath, process.env.DKB_REGISTRY_CREDENTIALS);
    assert.equal(operation.result.hasBearer, false);
    assert.equal(operation.result.args.some(value => value.includes('credentials.json')), false);
    assert.doesNotMatch(JSON.stringify(activity.list()), /must-not-cross/u);
  } finally { await runner.close(); activity.close(); }
});
