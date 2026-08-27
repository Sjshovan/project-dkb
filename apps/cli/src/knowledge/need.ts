import { stableHash } from '@dkb/protocol/contracts/hash.js';

export interface KnowledgeNeedFilters {
  targetIds?: string[];
  sourceTypes?: string[];
}

export interface KnowledgeNeedRetrieval {
  passes?: Array<'lexical' | 'vector' | 'graph'>;
  minScore?: number;
  cutoff?: number;
}

export interface KnowledgeNeed {
  need: string;
  phrases?: string[];
  context?: string;
  avoid?: string[];
  filters?: KnowledgeNeedFilters;
  retrieval?: KnowledgeNeedRetrieval;
  limit?: number;
  profile?: boolean;
}

export interface NormalizedKnowledgeNeed {
  requestId: string;
  retrievalText: string;
  need: string;
  phrases: string[];
  context: string;
  avoid: string[];
  filters: KnowledgeNeedFilters;
  retrieval: KnowledgeNeedRetrieval;
  limit?: number;
  profile: boolean;
}

export interface QueryHints {
  terms?: string[];
  aliases?: string[];
}

export function knowledgeNeedFromQuery(query: string, input: {
  hints?: QueryHints;
  limit?: number;
  profile?: boolean;
} = {}): KnowledgeNeed {
  return {
    need: query,
    phrases: [...(input.hints?.terms ?? []), ...(input.hints?.aliases ?? [])],
    limit: input.limit,
    profile: input.profile,
  };
}

export function normalizeKnowledgeNeed(value: KnowledgeNeed): NormalizedKnowledgeNeed {
  const need = normalizeText(value.need);

  if (!need) {
    throw new Error('KnowledgeNeed.need is required');
  }

  const phrases = uniqueStrings(value.phrases ?? []);
  const context = normalizeText(value.context ?? '');
  const avoid = uniqueStrings(value.avoid ?? []);
  const filters = normalizeFilters(value.filters);
  const retrieval = normalizeRetrieval(value.retrieval);
  const retrievalText = [
    need,
    phrases.join(' '),
    context,
  ].filter(Boolean).join('\n');

  return {
    requestId: `kn_${stableHash({
      need,
      phrases,
      context,
      avoid,
      filters,
      retrieval,
      limit: value.limit ?? null,
    }).slice(7, 19)}`,
    retrievalText,
    need,
    phrases,
    context,
    avoid,
    filters,
    retrieval,
    limit: value.limit,
    profile: Boolean(value.profile),
  };
}

export function hintText(hints: QueryHints | undefined): string {
  if (!hints) {
    return '';
  }

  return [
    ...(hints.terms ?? []),
    ...(hints.aliases ?? []),
  ].join(' ');
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function normalizeFilters(filters: KnowledgeNeedFilters | undefined): KnowledgeNeedFilters {
  return {
    targetIds: uniqueStrings(filters?.targetIds ?? []),
    sourceTypes: uniqueStrings(filters?.sourceTypes ?? []),
  };
}

function normalizeRetrieval(retrieval: KnowledgeNeedRetrieval | undefined): KnowledgeNeedRetrieval {
  return {
    passes: retrieval?.passes ? [...new Set(retrieval.passes)] : undefined,
    minScore: retrieval?.minScore,
    cutoff: retrieval?.cutoff,
  };
}
