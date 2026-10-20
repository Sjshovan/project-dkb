import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { installDkbFromLibraryGrant } from '@sjshovan/dkb-runtime/runtime/registryInstall.js';
import { installCollectionFromLibraryGrants } from '@sjshovan/dkb-runtime/runtime/collectionGrant.js';
import { createCliPresenter } from '../cli/presentation.js';
import { createCliEventWriter } from '../cli/eventStream.js';
import { LIBRARY_OWNER_ROOT } from './libraryOwnerContract.js';
import { LIBRARY_COLLECTION_INSTALL_FORMAT, LIBRARY_INSTALL_INPUT_LIMIT, validateLibraryInstallRequest } from './libraryInstallContract.js';

// Fixed private CLI composition root: one signed install, not an arbitrary command API.
const events = createCliEventWriter();
try {
  if (process.platform !== 'linux' || process.argv.length !== 2) throw new Error('Invalid invocation');
  const chunks: Buffer[] = [];
  let size = 0;
  const inputTimer = setTimeout(() => process.stdin.destroy(new Error('Input timed out')), 10_000);
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > LIBRARY_INSTALL_INPUT_LIMIT) throw new Error('Input too large');
      chunks.push(bytes);
    }
  } finally { clearTimeout(inputTimer); }
  const request = validateLibraryInstallRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  // The transport mounts a disposable disk-backed local volume here. Never put
  // knowledge layers in the small /tmp tmpfs or in a Windows shared directory.
  process.env.TMPDIR = '/scratch';
  const presenter = createCliPresenter({ jsonStream: true, eventWriter: events });
  if (request.format === LIBRARY_COLLECTION_INSTALL_FORMAT) {
    await presenter.run('Installing signed Collection', progress => installCollectionFromLibraryGrants({
      ...request, libraryRoot: LIBRARY_OWNER_ROOT, progress,
    }));
  } else {
    await presenter.run('Installing signed DKB', progress => installDkbFromLibraryGrant({
      ...request, libraryRoot: LIBRARY_OWNER_ROOT, progress,
    }));
  }
} catch (error) {
  // Registry bodies, grant bytes and package text are untrusted diagnostics.
  const code = error instanceof DkbError && /^[a-z_]{1,80}$/u.test(error.code) ? error.code : 'library_install_failed';
  events.failure(code, code === 'library_upgrade_conflict'
    ? 'Library changed while preparing the upgrade. No package was replaced. Run dkb outdated and retry the upgrade.'
    : 'Signed Library installation failed. Check Library status, storage capacity and Registry access before retrying with a fresh grant. An interrupted Library mutation may require dkb library recover.');
  events.complete('failed');
  process.exitCode = 1;
}
