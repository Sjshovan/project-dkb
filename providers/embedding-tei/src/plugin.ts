import type { DkbBundledPluginModule } from '@sjshovan/dkb-pipeline/host.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { defineOptionsSchema } from '@sjshovan/dkb-pipeline/sdk.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
import { DKB_PLUGIN_API_VERSION, type DkbEmbeddingProvider } from '@sjshovan/dkb-pipeline/types.js';
import {
  DKB_TEI_PLUGIN_ID,
  TEI_CPU_IMAGE,
  TEI_DEFAULT_DIMENSIONS,
  TEI_DEFAULT_MODEL,
  doctorTeiService,
  embedWithTei,
  ensureTeiService,
  stopTeiService,
  teiCompatibility,
  teiServiceStatus,
  resolveTeiModelRevision,
} from './tei.js';

export const DKB_TEI_PLUGIN_VERSION = '0.1.0';
const optionsSchema = defineOptionsSchema((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ message: 'Options must be an object' }];
  const options = value as Record<string, unknown>;
  const allowed = ['url', 'urlEnv', 'image', 'imageDigest', 'model', 'modelRevision', 'dimensions', 'normalized', 'metric', 'batchSize', 'timeoutMs', 'truncate', 'queryPrefix', 'documentPrefix', 'queryPromptName', 'documentPromptName'];
  const issues = Object.keys(options).filter((key) => !allowed.includes(key)).map((key) => ({ message: `Unknown option ${key}`, path: [key] }));
  if (options.imageDigest !== undefined && !isSha256Digest(options.imageDigest)) issues.push({ message: 'imageDigest must be an exact sha256 digest', path: ['imageDigest'] });
  if (issues.length > 0) return issues;
  const model = optionalString(options.model) ?? TEI_DEFAULT_MODEL;
  return {
    ...(optionalString(options.url) ? { url: optionalString(options.url)! } : {}),
    urlEnv: optionalString(options.urlEnv) ?? 'DKB_TEI_URL',
    image: optionalString(options.image) ?? TEI_CPU_IMAGE,
    ...(isSha256Digest(options.imageDigest) ? { imageDigest: options.imageDigest } : {}),
    model,
    modelRevision: resolveTeiModelRevision(model, options.modelRevision),
    dimensions: positiveInteger(options.dimensions) ?? TEI_DEFAULT_DIMENSIONS,
    normalized: options.normalized === undefined ? true : Boolean(options.normalized),
    metric: optionalString(options.metric) ?? 'cosine',
    batchSize: Math.min(positiveInteger(options.batchSize) ?? 32, 128),
    timeoutMs: positiveInteger(options.timeoutMs) ?? 120_000,
    truncate: options.truncate === undefined ? true : Boolean(options.truncate),
    queryPrefix: rawString(options.queryPrefix),
    documentPrefix: rawString(options.documentPrefix),
    queryPromptName: optionalString(options.queryPromptName) ?? '',
    documentPromptName: optionalString(options.documentPromptName) ?? '',
  };
}, DKB_TEI_PLUGIN_ID);

export const TEI_PLUGIN: DkbBundledPluginModule = {
  apiVersion: DKB_PLUGIN_API_VERSION,
  id: DKB_TEI_PLUGIN_ID,
  version: DKB_TEI_PLUGIN_VERSION,
  sourceUrl: import.meta.url,
  optionsSchema,
  identity: ({ options }) => {
    const imageDigest = isSha256Digest(options.imageDigest) ? options.imageDigest : undefined;
    const model = optionalString(options.model) ?? TEI_DEFAULT_MODEL;
    const modelRevision = resolveTeiModelRevision(model, options.modelRevision);
    return {
      profileOptions: {
        model,
        modelRevision,
        dimensions: positiveInteger(options.dimensions) ?? TEI_DEFAULT_DIMENSIONS,
        normalized: options.normalized === undefined ? true : Boolean(options.normalized),
        metric: optionalString(options.metric) ?? 'cosine',
        truncate: options.truncate === undefined ? true : Boolean(options.truncate),
        queryPrefix: rawString(options.queryPrefix),
        documentPrefix: rawString(options.documentPrefix),
        queryPromptName: optionalString(options.queryPromptName) ?? '',
        documentPromptName: optionalString(options.documentPromptName) ?? '',
      },
      external: [
        ...(imageDigest ? [{ kind: 'image' as const, name: 'embedding-service', digest: imageDigest }] : []),
        { kind: 'model', name: 'embedding-model', digest: stableHash({ model, revision: modelRevision }) },
      ],
    };
  },
  integrity: {
    apiVersion: DKB_PLUGIN_API_VERSION,
    id: DKB_TEI_PLUGIN_ID,
    version: DKB_TEI_PLUGIN_VERSION,
    protocols: ['tei.embed.v1'],
    artifactFormats: [],
  },
  setup(context) {
    const provider: DkbEmbeddingProvider = {
      kind: 'embedding',
      lifecycle: {
        start: (options) => ensureTeiService(context.options, Boolean(options?.restart)),
        status: () => teiServiceStatus(context.options),
        stop: () => stopTeiService(context.options),
        doctor: () => doctorTeiService(context.options),
      },
      embedDocuments: ({ texts, options, signal }) => embedWithTei(texts, 'document', options, signal),
      async embedQuery({ text, options, signal }) { return (await embedWithTei([text], 'query', options, signal))[0] ?? []; },
      compatibility: teiCompatibility,
      async health() {
        const result = await doctorTeiService(context.options);
        return { ok: result.ok, detail: result.ok ? `TEI ${result.status.model}@${result.status.modelRevision} ready at ${result.status.url}` : result.recovery };
      },
    };
    context.registerProvider(provider);
  },
};

function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function rawString(value: unknown): string { return typeof value === 'string' ? value : ''; }
function positiveInteger(value: unknown): number | undefined { return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined; }
