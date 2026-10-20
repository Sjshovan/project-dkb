import { readFileSync } from 'node:fs';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

const pins = JSON.parse(readFileSync(new URL('../python/model-pins.json', import.meta.url), 'utf8')) as Record<string, { repository: string; revision: string }>;

export function fastEmbedModelPin(model: string, options: { modelRepository?: unknown; modelRevision?: unknown } = {}): { repository: string; revision: string } {
  const repository = options.modelRepository ?? pins[model]?.repository;
  const revision = options.modelRevision ?? (repository === pins[model]?.repository ? pins[model]?.revision : undefined);
  if (typeof repository !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(repository)
    || typeof revision !== 'string' || !/^[a-f0-9]{40}$/u.test(revision)) {
    throw new DkbError(`FastEmbed ${model} requires modelRepository and an exact 40-character modelRevision commit. Mutable model labels or branches cannot identify a retrieval space.`);
  }
  return { repository, revision };
}
