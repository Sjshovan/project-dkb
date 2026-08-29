import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbEvidence, DkbRecord, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import { renderUntrustedSourceBlock } from '@sjshovan/dkb-protocol/security/sourceContent.js';
import type { DkbExecuteReadPlanInput, DkbReader, DkbReadPlanResult, DkbWriter } from './adapter.js';
import { blocked, complete } from './sqlShared.js';

export class FolderAdapter implements DkbReader, DkbWriter {
  async readRecords(_dkb: LoadedDkb): Promise<DkbRecord[]> {
    return [];
  }

  async executeReadPlan({ query, sourceUnits }: DkbExecuteReadPlanInput): Promise<DkbReadPlanResult> {
    const chunks = sourceUnits ?? [];

    if (chunks.length === 0) {
      return blocked(query, 'no_results', 'No compiled chunks were selected for filesystem evidence.', {});
    }

    const text = chunks
      .sort((left, right) => left.assetId.localeCompare(right.assetId) || left.chunkOrdinal - right.chunkOrdinal)
      .map((unit, index) => `Source chunk ${index + 1}\n${unit.text}`)
      .join('\n\n')
      .slice(0, Math.max(1000, Math.min((query.limit ?? 1) * 4000, 12000)));
    const first = chunks[0]!;
    const evidence: DkbEvidence = {
      type: 'text',
      label: first.title,
      text: renderUntrustedSourceBlock(text),
      source: {
        storeId: first.storeId,
        type: first.type,
        locator: first.locator,
        hash: first.hash,
      },
    };

    return complete(query, [evidence], {
      adapter: 'filesystem',
      dkbId: first.dkbId,
      storeId: first.storeId,
      chunksRead: chunks.length,
      sourceSelection: 'compiled-chunks',
    });
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
