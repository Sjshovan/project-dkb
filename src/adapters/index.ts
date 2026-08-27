import { DkbError } from '@dkb/protocol/errors.js';
import type { DkbAdapter, DkbStoreType } from '@dkb/protocol/types.js';
import type { DkbAdapterHandle } from './adapter.js';

export async function adapterFor(name: DkbAdapter): Promise<DkbAdapterHandle> {
  if (name === 'folder') {
    const { FolderAdapter } = await import('./folder.js');

    return new FolderAdapter();
  }

  if (name === 'sqlite') {
    const { SqliteAdapter } = await import('./sqlite.js');

    return new SqliteAdapter();
  }

  if (name === 'postgres') {
    const { PostgresAdapter } = await import('./postgres.js');

    return new PostgresAdapter();
  }

  if (name === 'compose') {
    const { ComposeStoreAdapter } = await import('./compose.js');

    return new ComposeStoreAdapter();
  }

  throw new DkbError(`Unsupported adapter: ${name}`);
}

export async function adapterForStore(type: DkbStoreType): Promise<DkbAdapterHandle> {
  if (type === 'filesystem') {
    return adapterFor('folder');
  }

  if (type === 'sqlite') {
    return adapterFor('sqlite');
  }

  if (type === 'postgres') {
    return adapterFor('postgres');
  }

  throw new DkbError(`Unsupported store type: ${type}`);
}
