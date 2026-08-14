import type { IndexedKnowledgeRegion } from '../indexes/knowledgeIndex.js';
import type { IndexedSourceUnit } from '../indexes/sourceIndex.js';
import type { DkbReadQuery, DkbReadResult, DkbStore, KnowledgeRegion, LoadedDkb } from '../protocol/types.js';

export interface DkbReader {
  readRecords(dkb: LoadedDkb): Promise<KnowledgeRegion[]>;
}

export interface DkbWriter {
  appendRecord(dkb: LoadedDkb, record: KnowledgeRegion): Promise<KnowledgeRegion>;
}

export interface DkbCompileRegionsInput {
  dkb: LoadedDkb;
  store: DkbStore;
}

export interface DkbCompileSourceUnitsInput {
  dkb: LoadedDkb;
  store: DkbStore;
}

export interface DkbExecuteReadPlanInput {
  dkb: LoadedDkb;
  store: DkbStore;
  record: IndexedKnowledgeRegion;
  query: DkbReadQuery;
  sourceUnits?: IndexedSourceUnit[];
}

export type DkbReadPlanResult = DkbReadResult['queries'][number];

export interface DkbSourceAdapter {
  compileSourceUnits(input: DkbCompileSourceUnitsInput): Promise<IndexedSourceUnit[]>;
  compileRegions?(input: DkbCompileRegionsInput): Promise<IndexedKnowledgeRegion[]>;
  executeReadPlan(input: DkbExecuteReadPlanInput): Promise<DkbReadPlanResult>;
}

export type DkbAdapterHandle = DkbReader & Partial<DkbWriter> & Partial<DkbSourceAdapter>;
export type DkbRegionCompiler = DkbAdapterHandle & {
  compileRegions(input: DkbCompileRegionsInput): Promise<IndexedKnowledgeRegion[]>;
};

export function canWrite(adapter: DkbAdapterHandle): adapter is DkbReader & DkbWriter {
  return typeof adapter.appendRecord === 'function';
}

export function canCompileRegions(adapter: DkbAdapterHandle): adapter is DkbRegionCompiler {
  return typeof adapter.compileRegions === 'function';
}

export function canCompileSourceUnits(adapter: DkbAdapterHandle): adapter is DkbAdapterHandle & DkbSourceAdapter {
  return typeof adapter.compileSourceUnits === 'function';
}

export function canExecuteReadPlan(adapter: DkbAdapterHandle): adapter is DkbAdapterHandle & DkbSourceAdapter {
  return typeof adapter.executeReadPlan === 'function';
}
