import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export type MeiliClient = InstanceType<(typeof import('meilisearch'))['MeiliSearch']>;

export async function createClient(options: Readonly<Record<string, unknown>>): Promise<MeiliClient> {
  const { MeiliSearch } = await import('meilisearch');
  const url = meilisearchUrl(options);
  const apiKey = environmentValue(options, 'apiKeyEnv', 'MEILI_MASTER_KEY', false);
  return new MeiliSearch({ host: url, ...(apiKey ? { apiKey } : {}) });
}

export async function deleteIndex(client: MeiliClient, indexId: string, options: Readonly<Record<string, unknown>>): Promise<void> {
  const task = await withMeilisearchTimeout(client.deleteIndexIfExists(indexId), options, `delete index ${indexId}`);
  if (task && typeof task === 'object' && 'taskUid' in task) await waitForTask(client, task, options);
}

export async function indexExists(client: MeiliClient, indexId: string, options: Readonly<Record<string, unknown>>): Promise<boolean> {
  try {
    await withMeilisearchTimeout(client.getIndex(indexId), options, `inspect index ${indexId}`);
    return true;
  } catch (error) {
    if (/index.*not found|index_not_found/iu.test(errorMessage(error))) return false;
    throw error;
  }
}

export async function listIndexIds(client: MeiliClient, options: Readonly<Record<string, unknown>>): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  const limit = 1_000;
  while (true) {
    const page = await withMeilisearchTimeout(client.getIndexes({ offset, limit }), options, 'list package indexes') as {
      results?: Array<{ uid?: unknown }>;
      total?: number;
    };
    const results = page.results ?? [];
    ids.push(...results.flatMap((index) => typeof index.uid === 'string' ? [index.uid] : []));
    offset += results.length;
    if (results.length < limit || offset >= Number(page.total ?? offset)) break;
  }
  return ids;
}

export async function waitForTask(
  client: MeiliClient,
  task: Parameters<MeiliClient['tasks']['waitForTask']>[0],
  options: Readonly<Record<string, unknown>>,
): Promise<void> {
  await client.tasks.waitForTask(task, { timeout: timeoutMs(options), interval: 100 });
}

export function meilisearchUrl(options: Readonly<Record<string, unknown>>): string {
  return environmentValue(options, 'urlEnv', 'MEILI_URL', true)!;
}

export function semanticRatio(options: Readonly<Record<string, unknown>>): number {
  const value = typeof options.semanticRatio === 'number' ? options.semanticRatio : 0.7;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new DkbError('Meilisearch semanticRatio must be between 0 and 1');
  }
  return value;
}

export function timeoutMs(options: Readonly<Record<string, unknown>>): number {
  return typeof options.timeoutMs === 'number' && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

export async function withMeilisearchTimeout<T>(
  promise: Promise<T>,
  options: Readonly<Record<string, unknown>>,
  operation: string,
): Promise<T> {
  const duration = timeoutMs(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DkbError(`Meilisearch ${operation} timed out after ${duration} ms`)), duration);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function environmentValue(
  options: Readonly<Record<string, unknown>>,
  optionName: string,
  fallbackName: string,
  required: boolean,
): string | undefined {
  const name = typeof options[optionName] === 'string' && options[optionName].trim().length > 0
    ? options[optionName].trim()
    : fallbackName;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new DkbError(`Meilisearch ${optionName} must name an environment variable`);
  }
  const value = process.env[name]?.trim();
  if (required && !value) throw new DkbError(`${name} is required by the selected Meilisearch provider`);
  return value || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
