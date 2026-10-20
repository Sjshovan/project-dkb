import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import MiniSearch from 'minisearch';
import { definePackagedIndexProvider } from '@sjshovan/dkb-pipeline/sdk.js';

const filename = 'lexical.json';
const format = 'example.minisearch.v1';
// MiniSearch owns tokenization and ranking. No original text is stored here.
const settings = { fields: ['text'], storeFields: [] };
const maxArtifactBytes = 256 * 1024 * 1024;

/** @param {string} providerId */
export function lexicalIndex(providerId) {
  return definePackagedIndexProvider({
    kind: 'index', mode: 'packaged', format, capabilities: { vectors: 'none' },
    async compilePackage({ artifactsRoot, compiled, signal }) {
      if (compiled.vectors.length) throw new Error('The lexical index does not accept vectors');
      const index = new MiniSearch(settings);
      const records = [...compiled.records].sort((a, b) => compare(a.id, b.id));
      for (const [ordinal, record] of records.entries()) {
        if (ordinal % 32 === 0) await setImmediate(undefined, { signal });
        signal?.throwIfAborted();
        index.add({ id: record.id, text: record.text });
      }
      const bytes = JSON.stringify({ format, ids: records.map((record) => record.id), index: index.toJSON() });
      if (Buffer.byteLength(bytes) > maxArtifactBytes) throw new Error('The example index exceeds its 256 MiB artifact limit; use a disk-backed provider');
      await fs.mkdir(artifactsRoot, { recursive: true });
      await fs.writeFile(path.join(artifactsRoot, filename), bytes, { flag: 'wx', signal });
      return { build: { documentCount: records.length, format, engine: 'minisearch' } };
    },
    async validatePackage({ artifactsRoot }) {
      const index = await openIndex(artifactsRoot);
      return { documentCount: index.documentCount };
    },
    async verifyRuntime({ packages, signal }) {
      let documentCount = 0;
      for (const build of packages) documentCount += (await openIndex(build.artifactsRoot, signal)).documentCount;
      return { indexId: providerId, documentCount, status: 'ready' };
    },
    async openRuntime({ packages, signal }) {
      /** @type {{ index: MiniSearch, id: string, version: string, indexId: string, documentCount: number }[]} */
      const indexes = [];
      for (const build of packages) {
        const index = await openIndex(build.artifactsRoot, signal);
        indexes.push({ index, id: build.dkb.manifest.id, version: build.dkb.manifest.version,
          indexId: `${build.dkb.manifest.id}@${build.dkb.manifest.version}`, documentCount: index.documentCount });
      }
      let closed = false;
      return {
        providerId, mode: 'packaged', format,
        packages: indexes.map(({ index: _index, ...entry }) => entry),
        async search(query, limit, querySignal) {
          if (closed) throw new Error('Lexical index is closed');
          if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Search limit must be a positive integer');
          querySignal?.throwIfAborted();
          /** @type {Map<string, number>} */
          const candidates = new Map();
          for (const { index } of indexes) {
            await setImmediate(undefined, { signal: querySignal });
            // String queries are data; the browser cannot supply query callbacks.
            const rows = index.search(query).sort((a, b) => b.score - a.score || compare(String(a.id), String(b.id))).slice(0, limit);
            for (const [rank, row] of rows.entries()) {
              if (typeof row.id !== 'string' || !Number.isFinite(row.score)) throw new Error('MiniSearch returned invalid candidates');
              // Packages have independent ranking statistics. Fuse ranks, not raw scores.
              candidates.set(row.id, (candidates.get(row.id) ?? 0) + 1 / (60 + rank + 1));
            }
          }
          querySignal?.throwIfAborted();
          return {
            hits: [...candidates].map(([id, score]) => ({ id, score }))
              .sort((a, b) => b.score - a.score || compare(a.id, b.id)).slice(0, limit),
            trace: { engine: 'minisearch', packageFusion: 'rrf-60', packages: indexes.length },
          };
        },
        close() { closed = true; indexes.length = 0; },
      };
    },
    async health() {
      const probe = new MiniSearch(settings);
      probe.add({ id: 'probe', text: 'healthcheck' });
      return { ok: probe.search('healthcheck')[0]?.id === 'probe' };
    },
  });
}

/** @param {string} root @param {AbortSignal} [signal] */
async function openIndex(root, signal) {
  signal?.throwIfAborted();
  const target = path.join(root, filename);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.size > maxArtifactBytes) throw new Error('Invalid or oversized lexical artifact');
  const bytes = await fs.readFile(target, { encoding: 'utf8', signal });
  if (Buffer.byteLength(bytes) > maxArtifactBytes) throw new Error('Lexical artifact grew beyond its size limit');
  const stored = JSON.parse(bytes);
  if (stored?.format !== format || !Array.isArray(stored.ids)
    || stored.ids.some((/** @type {unknown} */ id) => typeof id !== 'string' || !id.length)
    || new Set(stored.ids).size !== stored.ids.length || !stored.index || typeof stored.index !== 'object') {
    throw new Error('Invalid lexical artifact format or Evidence identities');
  }
  const index = await MiniSearch.loadJSONAsync(JSON.stringify(stored.index), settings);
  signal?.throwIfAborted();
  if (index.documentCount !== stored.ids.length || stored.ids.some((/** @type {string} */ id) => !index.has(id))) {
    throw new Error('Lexical artifact identity mapping does not match its index');
  }
  return index;
}

/** @param {string} a @param {string} b */
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
