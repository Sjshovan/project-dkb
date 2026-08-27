import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const apply = process.argv.includes('--apply');
const tempRoot = await fs.realpath(os.tmpdir());
const entries = await fs.readdir(tempRoot, { withFileTypes: true });
const ownedInventoryFiles = entries
  .filter((entry) => entry.isFile() && /^dkb-cli-ux-\d+-\d+\.json$/u.test(entry.name))
  .map((entry) => path.join(tempRoot, entry.name));
const emptyFakeCompilerDirectories = [];

for (const entry of entries) {
  if (!entry.isDirectory() || !/^dkb-fake-compiler-[a-f\d]{16}$/u.test(entry.name)) continue;
  const target = path.join(tempRoot, entry.name);
  if ((await fs.readdir(target)).length === 0) emptyFakeCompilerDirectories.push(target);
}
const removableTargets = [...ownedInventoryFiles, ...emptyFakeCompilerDirectories];

if (apply) {
  for (const target of removableTargets) {
    if (path.dirname(target) !== tempRoot) {
      throw new Error(`Refusing to remove a DKB Temp path outside ${tempRoot}: ${target}`);
    }
    await fs.rm(target, {
      force: true,
      recursive: emptyFakeCompilerDirectories.includes(target),
    });
  }
}

const remaining = (await fs.readdir(tempRoot, { withFileTypes: true }))
  .filter((entry) => /^dkb(?:-|$)/u.test(entry.name))
  .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }))
  .sort((left, right) => left.name.localeCompare(right.name));

console.log(JSON.stringify({
  tempRoot,
  mode: apply ? 'clean' : 'audit',
  removed: apply ? removableTargets.length : 0,
  removable: apply ? 0 : removableTargets.length,
  remaining,
}, null, 2));
