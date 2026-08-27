import type { DkbRecord } from '@dkb/protocol/types.js';

export const defaultMinimumScore = 2;
export const defaultResultProbabilityCutoff = 0.035;

export interface ScoredRecord extends DkbRecord {
  score: number;
  matchedTokens: number;
  queryTokenCount: number;
}

export function scoreRecord(record: DkbRecord, queryTokens: string[]): ScoredRecord {
  const titleTokenVariants = tokenVariantSet(tokenize(record.title, { keepStopwords: true }));
  const aliasTokenVariants = tokenVariantSet(tokenize((record.aliases ?? []).join(' '), { keepStopwords: true }));
  const entityTokenVariants = tokenVariantSet(tokenize(record.entities.join(' '), { keepStopwords: true }));
  const topicTokenVariants = tokenVariantSet(tokenize(record.topics.join(' '), { keepStopwords: true }));
  const keywordTokenVariants = tokenVariantSet(tokenize((record.keywords ?? []).join(' '), { keepStopwords: true }));
  const contentTokenVariants = tokenVariantSet(tokenize(record.content, { keepStopwords: true }));
  const queryVariants = queryTokens.map(tokenVariants);
  let score = 0;
  let matchedTokens = 0;

  for (const variants of queryVariants) {
    const titleScore = fieldMatchScore(titleTokenVariants, variants, 3);
    const aliasScore = fieldMatchScore(aliasTokenVariants, variants, 2.5);
    const entityScore = fieldMatchScore(entityTokenVariants, variants, 2);
    const keywordScore = fieldMatchScore(keywordTokenVariants, variants, 2);
    const topicScore = fieldMatchScore(topicTokenVariants, variants, 1.5);
    const contentScore = fieldMatchScore(contentTokenVariants, variants, 1);

    if (titleScore + aliasScore + entityScore + keywordScore + topicScore + contentScore > 0) {
      matchedTokens += 1;
    }

    score += titleScore + aliasScore + entityScore + keywordScore + topicScore + contentScore;
  }

  return {
    ...record,
    score: Math.round(score),
    matchedTokens,
    queryTokenCount: queryTokens.length,
  };
}

export function hasSufficientQueryCoverage(hit: { matchedTokens?: number }, queryTokens: string[]): boolean {
  const uniqueQueryTokenCount = new Set(queryTokens).size;

  if (uniqueQueryTokenCount >= 4) {
    return (hit.matchedTokens ?? 0) >= 2;
  }

  return (hit.matchedTokens ?? 0) >= 1;
}

export function applyScoreProbabilityCutoff<T extends { score: number }>(
  hits: T[],
  cutoff = defaultResultProbabilityCutoff,
): T[] {
  if (hits.length <= 1 || cutoff <= 0) {
    return hits;
  }

  const maxScore = Math.max(...hits.map((hit) => hit.score));
  const temperature = Math.max(1, Math.min(8, maxScore / 4));
  const relativeFloor = maxScore * 0.25;
  const weights = hits.map((hit) => Math.exp((hit.score - maxScore) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  return hits.filter((hit, index) => index === 0 || hit.score >= relativeFloor || weights[index] / total >= cutoff);
}

export function tokenize(value: string, options: { keepStopwords?: boolean } = {}): string[] {
  const tokens = (value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [])
    .flatMap((token) => token.includes('-') ? [token, ...token.split('-')] : [token]);

  if (options.keepStopwords) {
    return tokens;
  }

  return tokens.filter((token) => token.length > 2 && !stopwords.has(token));
}

function tokenVariantSet(tokens: string[]): Set<string> {
  const variants = new Set<string>();

  for (const token of tokens) {
    for (const variant of tokenVariants(token)) {
      variants.add(variant);
    }
  }

  return variants;
}

function fieldMatchScore(candidates: Set<string>, expected: Set<string>, weight: number): number {
  return intersects(expected, candidates) ? weight : 0;
}

function tokenVariants(token: string): Set<string> {
  const variants = new Set([token]);

  if (token.length > 4 && token.endsWith('ies')) {
    variants.add(`${token.slice(0, -3)}y`);
  }

  if (token.length > 4 && token.endsWith('ves')) {
    variants.add(token.slice(0, -1));
  }

  if (token.length > 4 && token.endsWith('es')) {
    variants.add(token.slice(0, -2));
  }

  if (token.length > 3 && token.endsWith('s')) {
    variants.add(token.slice(0, -1));
  }

  if (token.length > 5 && token.endsWith('ing')) {
    variants.add(token.slice(0, -3));
  }

  if (token.length > 4 && token.endsWith('ed')) {
    variants.add(token.slice(0, -2));
  }

  return variants;
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }

  return false;
}

const stopwords = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'about',
  'after',
  'before',
  'can',
  'could',
  'dkbr',
  'for',
  'from',
  'how',
  'in',
  'into',
  'is',
  'it',
  'must',
  'of',
  'on',
  'or',
  'please',
  'record',
  'records',
  'mention',
  'mentions',
  'mentioned',
  'should',
  'that',
  'the',
  'then',
  'these',
  'this',
  'those',
  'through',
  'to',
  'what',
  'where',
  'which',
  'with',
  'would',
]);
