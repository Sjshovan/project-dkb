import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbEvidence, DkbRecord, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { IndexedSourceUnit } from '@sjshovan/dkb-providers-bundled/sourceIndex.js';
import type { DkbCompileSourceUnitsInput, DkbExecuteReadPlanInput, DkbReader, DkbReadPlanResult } from './adapter.js';
import { blocked, complete } from './sqlShared.js';

export class PostgresAdapter implements DkbReader {
  async readRecords(_dkb: LoadedDkb): Promise<DkbRecord[]> {
    return [];
  }

  async compileSourceUnits(_input: DkbCompileSourceUnitsInput): Promise<IndexedSourceUnit[]> {
    throw new DkbError('Postgres direct chunk compilation is not implemented; use a compiler adapter that emits compiled chunks.');
  }

  async executeReadPlan({ query, sourceUnits }: DkbExecuteReadPlanInput): Promise<DkbReadPlanResult> {
    const chunks = sourceUnits ?? [];

    if (chunks.length === 0) {
      return blocked(query, 'no_results', 'No compiled Postgres chunks were selected.', {});
    }

    const first = chunks[0]!;
    const evidence: DkbEvidence = {
      type: 'text',
      label: first.title,
      text: chunks.map((chunk) => chunk.text).join('\n\n'),
      source: {
        storeId: first.storeId,
        type: first.type,
        locator: first.locator,
        hash: first.hash,
      },
    };

    return complete(query, [evidence], {
      adapter: 'postgres',
      dkbId: first.dkbId,
      storeId: first.storeId,
      chunksRead: chunks.length,
      sourceSelection: 'compiled-chunks',
    });
  }
}
