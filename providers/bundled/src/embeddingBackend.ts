import { createHash } from 'node:crypto';
import { tokenize } from './scoring.js';

export const DEFAULT_EMBEDDING_MODEL = 'dkb-local-hash-v1';
export const DEFAULT_VECTOR_DIMENSIONS = 384;

export type EmbeddingVector = number[];

export interface EmbedderBackendDescription {
  model: string;
  dimensions: number;
  status: 'ready' | 'fallback' | 'unavailable';
  reason?: string;
}

export interface EmbedderBackend {
  describe(): EmbedderBackendDescription;
  embedText(text: string): Promise<EmbeddingVector>;
  embedBatch(texts: string[]): Promise<EmbeddingVector[]>;
}

export function embedderBackendForEnvironment(): EmbedderBackend {
  return new HashEmbeddingBackend();
}

export class HashEmbeddingBackend implements EmbedderBackend {
  describe(): EmbedderBackendDescription {
    return {
      model: DEFAULT_EMBEDDING_MODEL,
      dimensions: DEFAULT_VECTOR_DIMENSIONS,
      status: 'fallback',
      reason: 'Deterministic local hash embeddings are active until an audit-clean embedded semantic model is selected.',
    };
  }

  async embedText(text: string): Promise<EmbeddingVector> {
    return embedTextSync(text);
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    return texts.map((text) => embedTextSync(text));
  }
}

export function cosine(left: EmbeddingVector, right: EmbeddingVector): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;

  for (let index = 0; index < length; index += 1) {
    sum += left[index] * right[index];
  }

  return sum;
}

function embedTextSync(text: string): EmbeddingVector {
  const vector = new Array<number>(DEFAULT_VECTOR_DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  const features = [
    ...tokens.map((token) => ({ value: `tok:${token}`, weight: 1 })),
    ...ngrams(tokens, 2).map((token) => ({ value: `bi:${token}`, weight: 1.35 })),
    ...ngrams(tokens, 3).map((token) => ({ value: `tri:${token}`, weight: 1.65 })),
  ];

  for (const feature of features) {
    const hash = createHash('sha256').update(feature.value).digest();
    const index = hash.readUInt32BE(0) % DEFAULT_VECTOR_DIMENSIONS;
    const sign = hash[4] % 2 === 0 ? 1 : -1;

    vector[index] += feature.weight * sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function ngrams(tokens: string[], size: number): string[] {
  const values: string[] = [];

  for (let index = 0; index <= tokens.length - size; index += 1) {
    values.push(tokens.slice(index, index + size).join(' '));
  }

  return values;
}
