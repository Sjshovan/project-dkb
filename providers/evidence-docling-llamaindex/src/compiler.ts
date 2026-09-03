import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import {
  LLAMAINDEX_COMPILER_ID,
  LLAMAINDEX_COMPILER_IMAGE,
  LLAMAINDEX_DOCUMENT_BATCH_SIZE,
} from './compilerConstants.js';
import {
  checkpointFor,
  llamaIndexCachePath,
  llamaIndexCheckpointPath,
  readCheckpoint,
  readRecordCache,
  writeCheckpoint,
  writeRecordCache,
} from './compilerCache.js';
import {
  cachePlanFor,
  requestFor,
  requestForChangedSources,
} from './compilerSource.js';
import {
  compareRecords,
  elapsedMs,
  ensureImage,
  readCompilerOutput,
  runCompiler,
  runCompilerService,
} from './compilerTransport.js';
import { maybePrepareCompilerServiceJob } from './compilerService.js';
import { tokenizerRevision } from './model.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { evidenceModelAssetsDigest, resolveEvidenceOptions, type EvidenceOptions } from './evidenceOptions.js';

export {
  LLAMAINDEX_COMPILER_ID,
  LLAMAINDEX_COMPILER_IMAGE,
  LLAMAINDEX_COMPILER_SERVICE_VERSION,
  LLAMAINDEX_DOCUMENT_BATCH_SIZE,
} from './compilerConstants.js';
export {
  compilerProviderHealth,
  compilerServiceStatus,
  doctorLlamaIndexCompilerService,
  inspectLlamaIndexCompiler,
  startLlamaIndexCompilerService,
  stopLlamaIndexCompilerService,
} from './compilerService.js';
export type {
  LlamaIndexCompilerInspection,
  LlamaIndexCompilerServiceStatus,
} from './compilerService.js';

export interface LlamaIndexCompilerRecord {
  id: string;
  assetId: string;
  storeId: string;
  type: 'filesystem' | 'sqlite' | 'database';
  locator: Record<string, unknown>;
  assetLocator: Record<string, unknown>;
  title: string;
  text: string;
  hash: string;
  sourceHash: string;
  updatedAt: string;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
  metadata: Record<string, unknown>;
}

export interface LlamaIndexCompilerResult {
  compiler: {
    id: string;
    model: string;
    modelRevision: string;
    modelAssetsDigest: string;
    evidenceOptions: EvidenceOptions;
    image: string;
  };
  execution?: {
    mode?: string;
    workers?: number;
    batching?: {
      documentBatchSize?: number;
      embeddingBatchSize?: number;
      inferenceBatchSize?: number;
      provider?: string;
      recordCount?: number;
    };
    timingsMs?: Record<string, number>;
    wrapperTimingsMs?: Record<string, number>;
  };
  records: LlamaIndexCompilerRecord[];
  cache?: LlamaIndexCompilerCacheStats;
}

export interface LlamaIndexCompilerCacheStats {
  cachePath: string;
  checkpointPath: string;
  cacheHit: boolean;
  resumed: boolean;
  cacheableSources: number;
  changedSources: number;
  reusedSources: number;
  changedSourceKeys: string[];
  reusedSourceKeys: string[];
  compiledRecords: number;
  reusedRecords: number;
}

export interface LlamaIndexCompilerOutput {
  format: 'dkb.llamaindex.compile.v2';
  compiler: { id: string; model: string; modelRevision: string; modelAssetsDigest: string; evidenceOptions: EvidenceOptions };
  execution?: LlamaIndexCompilerResult['execution'];
  records: LlamaIndexCompilerRecord[];
}

export interface LlamaIndexCompilerRequest {
  dkbId: string;
  version: string;
  stores: Array<{
    id: string;
    type: 'filesystem' | 'sqlite';
    path: string;
    includePaths?: string[];
    excludePaths?: string[];
  }>;
}

export interface SourceCandidate {
  key: string;
  type: 'filesystem' | 'sqlite';
  storeId: string;
  path: string;
  hash: string;
}

export interface LlamaIndexRecordCache {
  version: 2;
  compilerId: typeof LLAMAINDEX_COMPILER_ID;
  model: string;
  dkbId: string;
  dkbVersion: string;
  entries: Record<string, {
    sourceHash: string;
    records: LlamaIndexCompilerRecord[];
  }>;
  updatedAt: string;
}

export interface LlamaIndexCompileCheckpoint {
  version: 1;
  compilerId: typeof LLAMAINDEX_COMPILER_ID;
  model: string;
  dkbId: string;
  dkbVersion: string;
  status: 'running' | 'completed';
  startedAt: string;
  updatedAt: string;
  changedSources: Array<Pick<SourceCandidate, 'key' | 'type' | 'storeId' | 'path' | 'hash'>>;
  reusedSources: string[];
}

export async function compileDkbWithLlamaIndex(dkb: LoadedDkb, options: {
  image?: string;
  model?: string;
  modelRevision?: string;
  imageDigest?: string;
  evidenceOptions?: EvidenceOptions;
  timeoutMs?: number;
  workers?: number;
} = {}): Promise<LlamaIndexCompilerResult> {
  const image = options.image ?? process.env.DKB_LLAMA_COMPILER_IMAGE ?? LLAMAINDEX_COMPILER_IMAGE;
  const model = options.model ?? process.env.DKB_COMPILER_MODEL ?? 'BAAI/bge-small-en-v1.5';
  const modelRevision = tokenizerRevision(model, options.modelRevision ?? process.env.DKB_COMPILER_MODEL_REVISION);
  const evidenceOptions = resolveEvidenceOptions(options.evidenceOptions ? { ...options.evidenceOptions } : {});
  const modelAssetsDigest = evidenceModelAssetsDigest(evidenceOptions);
  const cacheIdentity = stableHash({ model, modelRevision, imageDigest: options.imageDigest ?? null, evidenceOptions, modelAssetsDigest });
  const request = requestFor(dkb);
  const cachePath = llamaIndexCachePath(dkb.root);
  const checkpointPath = llamaIndexCheckpointPath(dkb.root);
  const cacheEnabled = /^sha256:[a-f0-9]{64}$/u.test(options.imageDigest ?? '') && (process.env.DKB_LLAMA_RECORD_CACHE === undefined
    || environmentFlag(process.env.DKB_LLAMA_RECORD_CACHE));
  const previousCheckpoint = cacheEnabled ? await readCheckpoint(checkpointPath) : null;
  const cache = cacheEnabled ? await readRecordCache(cachePath, dkb, cacheIdentity) : null;
  const plan = !cacheEnabled
    ? null
    : await cachePlanFor(dkb, request, cache);
  const resumed = previousCheckpoint?.status === 'running';

  if (plan && plan.changed.length === 0 && plan.reusedRecords.length > 0) {
    await writeCheckpoint(checkpointPath, checkpointFor(dkb, cacheIdentity, [], plan.reused.map((item) => item.key), 'completed'));

    return {
      compiler: {
        id: LLAMAINDEX_COMPILER_ID,
        model,
        modelRevision,
        modelAssetsDigest,
        evidenceOptions,
        image,
      },
      execution: {
        mode: 'cached',
        workers: 0,
        timingsMs: {
          total: 0,
        },
      },
      records: plan.reusedRecords.sort(compareRecords),
      cache: {
        cachePath,
        checkpointPath,
        cacheHit: true,
        resumed,
        cacheableSources: plan.candidates.length,
        changedSources: 0,
        reusedSources: plan.reused.length,
        changedSourceKeys: [],
        reusedSourceKeys: plan.reused.map((item) => item.key),
        compiledRecords: 0,
        reusedRecords: plan.reusedRecords.length,
      },
    };
  }

  const requestToCompile = plan ? requestForChangedSources(request, plan.changed) : request;

  await writeCheckpoint(checkpointPath, checkpointFor(dkb, cacheIdentity, plan?.changed ?? [], plan?.reused.map((item) => item.key) ?? [], 'running'));

  if (process.env.DKB_TEST_ABORT_LLAMA_AFTER_CHECKPOINT === '1') {
    throw new DkbError(`Aborted LlamaIndex compile after checkpoint at ${checkpointPath}`);
  }

  const serviceJob = await maybePrepareCompilerServiceJob(dkb.root, requestToCompile, {
    image,
    imageDigest: options.imageDigest,
    model,
    modelRevision,
    timeoutMs: options.timeoutMs,
    workers: options.workers,
  });
  if (serviceJob) {
    const serviceStart = performance.now();
    let parsed: LlamaIndexCompilerOutput;
    try {
      parsed = await runCompilerService(serviceJob.serviceUrl, requestToCompile, {
        jobId: serviceJob.jobId,
        model,
        modelRevision,
        evidenceOptions,
        timeoutMs: options.timeoutMs,
        workers: options.workers,
      });
    } finally {
      await fs.rm(serviceJob.jobRoot, { recursive: true, force: true });
    }
    verifyCompilerModel(parsed, model, modelRevision, evidenceOptions);
    const records = plan
      ? [...plan.reusedRecords, ...parsed.records].sort(compareRecords)
      : parsed.records.sort(compareRecords);

    if (plan) {
      await writeRecordCache(cachePath, dkb, cacheIdentity, plan.candidates, records);
    }
    await writeCheckpoint(checkpointPath, checkpointFor(dkb, cacheIdentity, plan?.changed ?? [], plan?.reused.map((item) => item.key) ?? [], 'completed'));

    return {
      compiler: {
        id: LLAMAINDEX_COMPILER_ID,
        model: parsed.compiler.model,
        modelRevision: parsed.compiler.modelRevision,
        modelAssetsDigest,
        evidenceOptions,
        image,
      },
      execution: {
        ...parsed.execution,
        wrapperTimingsMs: {
          serviceRequest: elapsedMs(serviceStart),
          total: elapsedMs(serviceStart),
        },
      },
      records,
      cache: {
        cachePath,
        checkpointPath,
        cacheHit: false,
        resumed,
        cacheableSources: plan?.candidates.length ?? 0,
        changedSources: plan?.changed.length ?? 0,
        reusedSources: plan?.reused.length ?? 0,
        changedSourceKeys: plan?.changed.map((item) => item.key) ?? [],
        reusedSourceKeys: plan?.reused.map((item) => item.key) ?? [],
        compiledRecords: parsed.records.length,
        reusedRecords: plan?.reusedRecords.length ?? 0,
      },
    };
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-llamaindex-'));
  const requestDir = path.join(scratch, 'request');
  const outputDir = path.join(scratch, 'output');
  const wrapperStart = performance.now();
  let requestWriteMs = 0;
  let imageMs = 0;
  let containerMs = 0;
  let outputReadMs = 0;

  try {
    const requestStart = performance.now();
    await fs.mkdir(requestDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(requestDir, 'request.json'), `${JSON.stringify(requestToCompile, null, 2)}\n`, 'utf8');
    requestWriteMs = elapsedMs(requestStart);
    const imageStart = performance.now();
    await ensureImage(image);
    imageMs = elapsedMs(imageStart);
    const containerStart = performance.now();
    await runCompiler(image, dkb.root, requestDir, outputDir, {
      imageDigest: options.imageDigest,
      model,
      modelRevision,
      evidenceOptions,
      timeoutMs: options.timeoutMs,
      workers: options.workers,
    });
    containerMs = elapsedMs(containerStart);
    const outputReadStart = performance.now();
    const parsed = await readCompilerOutput(outputDir);
    verifyCompilerModel(parsed, model, modelRevision, evidenceOptions);
    outputReadMs = elapsedMs(outputReadStart);
    const records = plan
      ? [...plan.reusedRecords, ...parsed.records].sort(compareRecords)
      : parsed.records.sort(compareRecords);

    if (plan) {
      await writeRecordCache(cachePath, dkb, cacheIdentity, plan.candidates, records);
    }
    await writeCheckpoint(checkpointPath, checkpointFor(dkb, cacheIdentity, plan?.changed ?? [], plan?.reused.map((item) => item.key) ?? [], 'completed'));

    return {
      compiler: {
        id: LLAMAINDEX_COMPILER_ID,
        model: parsed.compiler.model,
        modelRevision: parsed.compiler.modelRevision,
        modelAssetsDigest,
        evidenceOptions,
        image,
      },
      execution: {
        ...parsed.execution,
        wrapperTimingsMs: {
          requestWrite: requestWriteMs,
          image: imageMs,
          container: containerMs,
          outputRead: outputReadMs,
          total: elapsedMs(wrapperStart),
        },
      },
      records,
      cache: {
        cachePath,
        checkpointPath,
        cacheHit: false,
        resumed,
        cacheableSources: plan?.candidates.length ?? 0,
        changedSources: plan?.changed.length ?? 0,
        reusedSources: plan?.reused.length ?? 0,
        changedSourceKeys: plan?.changed.map((item) => item.key) ?? [],
        reusedSourceKeys: plan?.reused.map((item) => item.key) ?? [],
        compiledRecords: parsed.records.length,
        reusedRecords: plan?.reusedRecords.length ?? 0,
      },
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

function environmentFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function verifyCompilerModel(result: LlamaIndexCompilerOutput, model: string, revision: string, options: EvidenceOptions): void {
  if (result.compiler.model !== model || result.compiler.modelRevision !== revision) {
    throw new DkbError(`Evidence worker tokenizer identity mismatch: expected ${model}@${revision}. Rebuild and restart the Evidence worker before compilation.`);
  }
  if (result.compiler.modelAssetsDigest !== evidenceModelAssetsDigest(options)
    || stableHash(result.compiler.evidenceOptions ?? null) !== stableHash(options)) {
    throw new DkbError('Evidence worker model assets or resolved extraction options do not match the selected recipe. Rebuild and restart the selected Evidence worker before compilation.');
  }
}
