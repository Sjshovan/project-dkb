import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbRecord, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbReader, DkbWriter } from './adapter.js';

export class FolderAdapter implements DkbReader, DkbWriter {
  async readRecords(_dkb: LoadedDkb): Promise<DkbRecord[]> {
    return [];
  }

  async appendRecord(dkb: LoadedDkb, record: DkbRecord): Promise<DkbRecord> {
    const directory = resolveFrom(dkb.root, dkb.manifest.entrypoint);
    const target = path.join(directory, `${record.id.replace(/[^a-zA-Z0-9._-]/g, '-')}.json`);

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });

    return {
      ...record,
      source: record.source || target,
    };
  }
}
