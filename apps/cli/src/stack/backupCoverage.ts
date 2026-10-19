import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { readEnvironmentFile } from './context.js';

/** A host-directory archive must not be represented as a backup of external state. */
export async function assertHostBackupCoverage(root: string, restoredRoot = root): Promise<void> {
  const values = await readHostBackupEnvironment(root);
  const realRoot = await fs.realpath(root);
  const logicalLibraryRoot = path.resolve(values.DKB_LIBRARY_HOST_PATH ?? path.join(restoredRoot, 'library'));
  const libraryRelative = path.relative(path.resolve(restoredRoot), logicalLibraryRoot);
  if (!libraryRelative || libraryRelative === '..' || libraryRelative.startsWith(`..${path.sep}`) || path.isAbsolute(libraryRelative)) throw incomplete('Library');
  // Archived absolute host bindings are checked against their restoration root,
  // but only the staged archive is inspected; never follow the original path.
  const libraryRoot = path.resolve(root, libraryRelative);
  for (const [label, target] of [['Library', libraryRoot], ['Runtime', path.join(root, 'runtime')]] as const) {
    const relative = path.relative(path.resolve(root), target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw incomplete(label);
    }
    // A junction or symlink is an archive entry, not the data it points to. Check
    // every directory in this critical path, not just its resolved destination.
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw incomplete(label);
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw incomplete(label);
    }
    const contained = path.relative(realRoot, await fs.realpath(target));
    if (!contained || contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) throw incomplete(label);
  }
}

/** Existing native data may be damaged; its replacement must not repoint volumes. */
export async function readHostBackupEnvironment(root: string): Promise<Record<string, string>> {
  const values = await readEnvironmentFile(path.join(root, 'stack.env'));
  const descriptor = await fs.lstat(path.join(root, 'stack-storage.json')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (descriptor || Object.keys(values).some(key => /^DKB_.*_VOLUME$/u.test(key))) {
    throw new DkbError('This Stack uses Docker-owned state. A host-folder archive cannot back up its volumes. Volume-aware backup is required; no backup was created and no volume was changed.', 'stack_backup_incomplete');
  }
  return values;
}

function incomplete(label: string): DkbError {
  return new DkbError(`The selected ${label} is not fully contained in the Stack state directory. A host-folder archive would omit its data. Keep the services stopped and back up the ${label} in its owning environment before migration; no partial Stack backup was created.`, 'stack_backup_incomplete');
}
