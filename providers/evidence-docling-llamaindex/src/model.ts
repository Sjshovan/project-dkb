import { readFileSync } from 'node:fs';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

const pins = JSON.parse(readFileSync(new URL('../python/model-pins.json', import.meta.url), 'utf8')) as Record<string, string>;

export function tokenizerRevision(model: string, revision?: unknown): string {
  const resolved = revision ?? pins[model];
  if (typeof resolved !== 'string' || !/^[a-f0-9]{40}$/u.test(resolved)) {
    throw new DkbError(`Evidence tokenizer ${model} requires tokenizerRevision as an exact 40-character model commit, not a mutable branch or model label.`);
  }
  return resolved;
}
