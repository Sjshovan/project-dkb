import type {
  DkbRetrievalHit,
  DkbRetrievalProvider,
  DkbRetrievalRuntime,
  DkbRetrievalScope,
} from '@sjshovan/dkb-pipeline/types.js';

type DkbRetrievalEvidenceRecord = Parameters<DkbRetrievalProvider['openRuntime']>[0]['evidence']['records'][number];

export const DKB_HYBRID_RETRIEVAL_PROTOCOL = 'dkb.evidence.v1';

export function createHybridRetrievalProvider(providerId: string): DkbRetrievalProvider {
  return {
    kind: 'retrieval',
    protocol: DKB_HYBRID_RETRIEVAL_PROTOCOL,
    openRuntime({ index, evidence }) {
      let closed = false;
      const runtime: DkbRetrievalRuntime = {
        providerId,
        protocol: DKB_HYBRID_RETRIEVAL_PROTOCOL,
        async search({ query, limit, scope, signal }) {
          if (closed) throw new Error(`Retrieval Runtime ${providerId} is closed`);
          if (signal?.aborted) throw signal.reason ?? new Error(`Retrieval search was cancelled`);
          const candidateLimit = Math.max(1, Math.min(Math.max(limit * 5, 50), 1_000));
          const [vector, lexical] = await Promise.all([
            index?.search(query, candidateLimit, signal) ?? Promise.resolve({ hits: [], trace: { status: 'unavailable' } }),
            Promise.resolve(searchEvidenceLexically(evidence.records, query, candidateLimit, scope)),
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

function searchEvidenceLexically(
  records: readonly DkbRetrievalEvidenceRecord[],
  query: string,
  limit: number,
  scope?: DkbRetrievalScope,
): Array<{ unitId: string; score: number; matchedTokens: string[] }> {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return [];

  return records.flatMap((record) => {
    if (scope?.dkbId && scope.dkbId !== record.packageId) return [];
    if (scope?.packageVersion && scope.packageVersion !== record.packageVersion) return [];
    if (scope?.assetId && scope.assetId !== record.assetId) return [];
    if (scope?.sourceType && scope.sourceType !== record.sourceType) return [];
    const title = new Set(tokenize(record.title));
    const keywords = new Set(record.keywords.flatMap(tokenize));
    const text = new Set(tokenize(record.text));
    const matchedTokens = tokens.filter((token) => title.has(token) || keywords.has(token) || text.has(token));
    if (matchedTokens.length === 0) return [];
    const score = matchedTokens.reduce((total, token) => total
      + (title.has(token) ? 3 : 0)
      + (keywords.has(token) ? 2 : 0)
      + (text.has(token) ? 1 : 0), 0);
    return [{ unitId: record.evidenceId, score, matchedTokens }];
  }).sort((left, right) => right.score - left.score || left.unitId.localeCompare(right.unitId))
    .slice(0, Math.max(1, Math.min(limit, 1_000)));
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/gu) ?? [])
    .flatMap((token) => token.includes('-') ? [token, ...token.split('-')] : [token]);
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
