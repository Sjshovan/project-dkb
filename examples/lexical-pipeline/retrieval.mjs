import { defineRetrievalProvider } from '@sjshovan/dkb-pipeline/sdk.js';
import { evidenceIdsForRetrievalScope, validateIndexHits } from '@sjshovan/dkb-pipeline/validation.js';

/** @param {string} providerId */
export function lexicalRetrieval(providerId) {
  return defineRetrievalProvider({
    kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'none' },
    openRuntime({ index, evidence }) {
      if (!index) throw new Error('The lexical Pipeline requires its selected index');
      const known = new Set(evidence.records.map((record) => record.evidenceId));
      let closed = false;
      return {
        providerId, protocol: 'dkb.evidence.v1',
        async search({ query, limit, scope, signal }) {
          if (closed) throw new Error('Lexical retrieval is closed');
          if (!evidence.records.length) return { hits: [], trace: { channel: 'lexical', candidates: 0 } };
          const allowed = evidenceIdsForRetrievalScope(evidence.records, scope);
          // Index contracts return IDs only. DKB retains canonical text/provenance.
          // Request enough IDs for a complete scope filter, not a guessed over-fetch.
          const result = await index.search(query, evidence.records.length, signal);
          const candidates = validateIndexHits(result.hits, known, evidence.records.length, providerId);
          return {
            hits: candidates.filter((hit) => allowed.has(hit.id)).slice(0, limit)
              .map((hit) => ({ evidenceId: hit.id, score: hit.score, channels: ['lexical'] })),
            trace: { ...result.trace, channel: 'lexical', candidates: candidates.length },
          };
        },
        close() { closed = true; },
      };
    },
  });
}
