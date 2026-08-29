import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), `dkb-test-global-${process.pid}-`));
const configPath = path.join(root, 'config.json');

fs.writeFileSync(configPath, `${JSON.stringify({ format: 'dkb.config.v2' }, null, 2)}\n`, 'utf8');
process.env.DKB_GLOBAL_ROOT = root;
process.env.DKB_CLI_CONFIG = configPath;

process.once('exit', () => {
  const resolved = path.resolve(root);
  const expectedParent = path.resolve(os.tmpdir());
  if (path.dirname(resolved) === expectedParent && path.basename(resolved).startsWith('dkb-test-global-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
