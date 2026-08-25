import { DkbError } from '../protocol/errors.js';
import type { DkbStore, DkbRecord, LoadedDkb } from '../protocol/types.js';
import type { DkbReader, DkbWriter } from './adapter.js';
import { FolderAdapter } from './folder.js';
import { SqliteAdapter } from './sqlite.js';

export class ComposeStoreAdapter implements DkbReader, DkbWriter {
  async readRecords(dkb: LoadedDkb): Promise<DkbRecord[]> {
    const stores = dkb.manifest.stores ?? [];
    const batches = await Promise.all(stores.map((store) => readerFor(store.type).readRecords({
      ...dkb,
      manifest: {
        ...dkb.manifest,
        adapter: store.type === 'filesystem' ? 'folder' : 'sqlite',
        entrypoint: localPathFor(store),
      },
    })));

    return batches.flat();
  }

  async appendRecord(dkb: LoadedDkb, record: DkbRecord): Promise<DkbRecord> {
    const stores = dkb.manifest.stores ?? [];
    const targetStore = stores.find((store) => store.mode === 'write' || store.mode === 'readwrite');

    if (!targetStore) {
      throw new DkbError(`No writable store declared for DKB ${dkb.manifest.id}`);
    }

    const adapter = readerFor(targetStore.type);

    if (!('appendRecord' in adapter) || typeof adapter.appendRecord !== 'function') {
      throw new DkbError(`Store ${targetStore.id} does not support append writes`);
    }

    return adapter.appendRecord({
      ...dkb,
      manifest: {
        ...dkb.manifest,
        adapter: targetStore.type === 'filesystem' ? 'folder' : 'sqlite',
        entrypoint: localPathFor(targetStore),
      },
    }, record);
  }
}

function localPathFor(store: DkbStore): string {
  if (!store.path) {
    throw new DkbError(`Store ${store.id} requires a local path for adapter execution`);
  }

  return store.path;
}

function readerFor(type: DkbStore['type']): DkbReader & Partial<DkbWriter> {
  if (type === 'filesystem') {
    return new FolderAdapter();
  }

  if (type === 'sqlite') {
    return new SqliteAdapter();
  }

  throw new DkbError(`Unsupported store type: ${type}`);
}
