import type { DkbRecord, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbReader } from './adapter.js';

export class PostgresAdapter implements DkbReader {
  async readRecords(_dkb: LoadedDkb): Promise<DkbRecord[]> {
    return [];
  }

}
