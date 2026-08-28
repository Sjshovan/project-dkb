import type { IndexedSourceUnit } from '@sjshovan/dkb-providers-bundled/sourceIndex.js';
import type { DkbReadQuery, DkbReadResult, DkbStore, DkbRecord, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';

export interface DkbReader {
  readRecords(dkb: LoadedDkb): Promise<DkbRecord[]>;
}

export interface DkbWriter {
  appendRecord(dkb: LoadedDkb, record: DkbRecord): Promise<DkbRecord>;
}

export interface DkbCompileSourceUnitsInput {
  dkb: LoadedDkb;
  store: DkbStore;
}

export interface DkbExecuteReadPlanInput {
  dkb: LoadedDkb;
  store: DkbStore;
  record: any;
  query: DkbReadQuery;
  sourceUnits?: IndexedSourceUnit[];
}

export type DkbReadPlanResult = DkbReadResult['queries'][number];

export interface DkbSourceAdapter {
  compileSourceUnits(input: DkbCompileSourceUnitsInput): Promise<IndexedSourceUnit[]>;
  executeReadPlan(input: DkbExecuteReadPlanInput): Promise<DkbReadPlanResult>;
}

export type DkbAdapterHandle = DkbReader & Partial<DkbWriter> & Partial<DkbSourceAdapter>;

export function canWrite(adapter: DkbAdapterHandle): adapter is DkbReader & DkbWriter {
  return typeof adapter.appendRecord === 'function';
}

export function canCompileSourceUnits(adapter: DkbAdapterHandle): adapter is DkbAdapterHandle & DkbSourceAdapter {
  return typeof adapter.compileSourceUnits === 'function';
}

export function canExecuteReadPlan(adapter: DkbAdapterHandle): adapter is DkbAdapterHandle & DkbSourceAdapter {
  return typeof adapter.executeReadPlan === 'function';
}
