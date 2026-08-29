import type { DkbRecord, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';

export interface DkbReader {
  readRecords(dkb: LoadedDkb): Promise<DkbRecord[]>;
}

export interface DkbWriter {
  appendRecord(dkb: LoadedDkb, record: DkbRecord): Promise<DkbRecord>;
}

export type DkbAdapterHandle = DkbReader & Partial<DkbWriter>;

export function canWrite(adapter: DkbAdapterHandle): adapter is DkbReader & DkbWriter {
  return typeof adapter.appendRecord === 'function';
}
