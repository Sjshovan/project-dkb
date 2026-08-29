import type {
  DkbRetrievalHit,
  DkbRetrievalProvider,
  DkbRetrievalRuntime,
} from '@sjshovan/dkb-pipeline/types.js';

export const DKB_HYBRID_RETRIEVAL_PROTOCOL = 'dkb.evidence.v1';

export function createHybridRetrievalProvider(providerId: string): DkbRetrievalProvider {
  return {
    kind: 'retrieval',
    protocol: DKB_HYBRID_RETRIEVAL_PROTOCOL,
    openRuntime({ index }) {
      let closed = false;
      const runtime: DkbRetrievalRuntime = {
        providerId,
        protocol: DKB_HYBRID_RETRIEVAL_PROTOCOL,
        async search({ query, limit, scope, signal }) {
          if (closed) throw new Error(`Retrieval Runtime ${providerId} is closed`);
          if (signal?.aborted) throw signal.reason ?? new Error(`Retrieval search was cancelled`);
          if (!index) return { hits: [], trace: { engine: providerId, status: 'empty', channels: [] } };

          const candidateLimit = Math.max(1, Math.min(Math.max(limit * 5, 50), 1_000));
          const [vector, lexical] = await Promise.all([
            index.search(query, candidateLimit, signal),
            Promise.resolve(index.lexicalSearch?.(query, candidateLimit, scope) ?? []),
          ]);
          const hits = fuseCandidates(lexical, vector.hits, limit);

          return {
            hits,
            trace: {
              engine: providerId,
              status: hits.length > 0 ? 'ready' : 'empty',
              strategy: 'weighted-rank-fusion',
              lexicalCandidates: lexical.length,
              vectorCandidates: vector.hits.length,
              index: vector.trace,
            },
          };
        },
        close() {
          closed = true;
        },
      };

      return runtime;
    },
    health: async () => ({ ok: true, detail: 'Lexical/vector candidate ranking and fusion' }),
  };
}

function fuseCandidates(
  lexical: readonly { unitId: string; score: number; matchedTokens: string[] }[],
  vector: readonly { id: string; score: number }[],
  limit: number,
): DkbRetrievalHit[] {
  const fused = new Map<string, { score: number; channels: Set<string>; matchedTokens: Set<string> }>();
  addRanked(fused, lexical.map((hit) => ({ id: hit.unitId, matchedTokens: hit.matchedTokens })), 'lexical', 0.65);
  addRanked(fused, vector.map((hit) => ({ id: hit.id, matchedTokens: [] })), 'vector', lexical.length > 0 ? 0.35 : 1);

  return [...fused.entries()]
    .map(([evidenceId, value]) => ({
      evidenceId,
      score: Math.round(Math.min(1, value.score) * 1_000_000) / 1_000_000,
      channels: [...value.channels].sort(),
      ...(value.matchedTokens.size > 0 ? { matchedTokens: [...value.matchedTokens].sort() } : {}),
    }))
    .sort((left, right) => right.score - left.score || left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, Math.max(1, limit));
}

function addRanked(
  output: Map<string, { score: number; channels: Set<string>; matchedTokens: Set<string> }>,
  hits: readonly { id: string; matchedTokens: readonly string[] }[],
  channel: string,
  weight: number,
): void {
  const denominator = Math.max(1, hits.length);

  hits.forEach((hit, index) => {
    const value = output.get(hit.id) ?? { score: 0, channels: new Set<string>(), matchedTokens: new Set<string>() };
    value.score += weight * (1 - index / denominator);
    value.channels.add(channel);
    hit.matchedTokens.forEach((token) => value.matchedTokens.add(token));
    output.set(hit.id, value);
  });
}
