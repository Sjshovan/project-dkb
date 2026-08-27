import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const apply = process.argv.includes('--apply');
const tempRoot = await fs.realpath(os.tmpdir());
const entries = await fs.readdir(tempRoot, { withFileTypes: true });
const ownedInventoryFiles = entries
  .filter((entry) => entry.isFile() && /^dkb-cli-ux-\d+-\d+\.json$/u.test(entry.name))
  .map((entry) => path.join(tempRoot, entry.name));
const removableDirectories = [];
const ownedDirectoryPatterns = [
  /^dkb-cli-distribution-[A-Za-z\d_-]+$/u,
  /^dkb-cli-global-windows-proof$/u,
  /^dkb-publish-upload-[A-Za-z\d_-]+$/u,
  /^dkb-real-corpus-[A-Za-z\d_-]+$/u,
];

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const target = path.join(tempRoot, entry.name);
  if (/^dkb-fake-compiler-[a-f\d]{16}$/u.test(entry.name)) {
    if ((await fs.readdir(target)).length === 0) removableDirectories.push(target);
    continue;
  }
  if (ownedDirectoryPatterns.some((pattern) => pattern.test(entry.name))) {
    removableDirectories.push(target);
  }
}
const removableTargets = [...ownedInventoryFiles, ...removableDirectories];

if (apply) {
  for (const target of removableTargets) {
    if (path.dirname(target) !== tempRoot) {
      throw new Error(`Refusing to remove a DKB Temp path outside ${tempRoot}: ${target}`);
    }
    await fs.rm(target, {
      force: true,
      recursive: removableDirectories.includes(target),
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
