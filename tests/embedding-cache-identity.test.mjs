import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { embedDkbEvidenceWithProviderHost } from '@sjshovan/dkb-compiler/pipelineRunner.js';

test('embedding cache binds full integrity and semantic options while retaining operational reuse', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cache-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '@test/cache-identity';
  let calls = 0;
  const compile = async ({ dependency = 'one', external = 'one', transform = 'one', timeoutMs = 1000, reject = false } = {}) => {
    const identity = { dependency, external };
    const options = { transform, timeoutMs };
    const host = {
      root, config: { target: { embedding: id } },
      optionsFor: () => options,
      profileOptionsFor: () => ({ transform }),
      describe: () => ({ providers: [{ id, kind: 'embedding', version: '1.0.0', sourceDigest: stableHash('unchanged files'), integrityDigest: stableHash(identity) }] }),
      provider: () => ({
        compatibility: () => ({ embeddingSpace: 'fixed-space', dimensions: 1, metric: 'cosine', normalized: false }),
        embedDocuments: async ({ texts }) => {
          calls++;
          if (reject) throw new Error('Embedding service unavailable');
          return texts.map(() => [calls]);
        },
      }),
    };
    return embedDkbEvidenceWithProviderHost(host, { documents: [], chunks: [], records: [{ id: 'evidence-1', text: 'same evidence' }], receipts: [] });
  };
  const first = await compile();
  const operational = await compile({ timeoutMs: 5000 });
  assert.deepEqual(operational.vectors, first.vectors);
  assert.equal(calls, 1);
  const semantic = await compile({ transform: 'two' });
  const dependency = await compile({ dependency: 'two' });
  const external = await compile({ external: 'two' });
  assert.equal(calls, 4);
  assert.equal(new Set([first, semantic, dependency, external].map((result) => result.receipts[0].diagnostics.cache.spaceDigest)).size, 4);
  assert.deepEqual((await compile()).vectors, first.vectors);
  assert.equal(calls, 4);
  await assert.rejects(compile({ transform: 'failure', reject: true }), /Embedding service unavailable/u);
  assert.equal((await compile({ transform: 'failure' })).receipts[0].diagnostics.cache.misses, 1);
  assert.equal(calls, 6);
});
