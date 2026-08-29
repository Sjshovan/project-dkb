import type {
  DkbEvidence,
  DkbEvidenceSufficiency,
  DkbReadResult,
} from '@sjshovan/dkb-protocol/types.js';
import { tokenize } from './evidenceModel.js';

export function evaluateEvidenceSufficiency(result: DkbReadResult, needText: string): DkbEvidenceSufficiency {
  const evidence = result.queries.flatMap((query) => query.evidence);

  if (evidence.length === 0) {
    return {
      status: 'blocked',
      confidence: 0,
      matchedNeed: false,
      expanded: false,
      reason: 'no_evidence',
      passes: 1,
    };
  }

  const tokens = tokenize(needText).filter((token) => token.length > 2 && !SUFFICIENCY_STOPWORDS.has(token));

  if (tokens.length === 0) {
    return {
      status: result.status,
      confidence: 1,
      matchedNeed: true,
      expanded: false,
      reason: 'no_need',
      passes: 1,
    };
  }

  const evidenceTokens = new Set(tokenize(evidence.map(evidenceToText).join(' ')));
  const matchedCount = tokens.filter((token) => evidenceTokens.has(token)).length;
  const confidence = Math.round(Math.max(0, Math.min(1, matchedCount / tokens.length)) * 10000) / 10000;
  const matchedNeed = confidence >= 0.5;

  return {
    status: confidence >= 0.75 && result.status === 'complete' ? 'complete' : 'partial',
    confidence,
    matchedNeed,
    expanded: false,
    reason: matchedNeed ? 'matched_need' : 'weak_match',
    passes: 1,
  };
}

function evidenceToText(evidence: DkbEvidence): string {
  const label = evidence.label ? `${evidence.label} ` : '';
  if (typeof evidence.text === 'string') return `${label}${evidence.text}`;
  if (evidence.rows) return `${label}${JSON.stringify(evidence.rows)}`;
  if (evidence.value !== undefined) return `${label}${String(evidence.value)}`;
  return evidence.label;
}

const SUFFICIENCY_STOPWORDS = new Set([
  'what', 'which', 'where', 'when', 'who', 'how', 'does', 'find', 'show', 'tell',
  'about', 'record', 'records', 'mention', 'mentions', 'that', 'this', 'with', 'from', 'the',
]);
