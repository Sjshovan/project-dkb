import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const required = [
  'AGENTS.md',
  'apps/cli/AGENTS.md',
  'services/runtime/AGENTS.md',
  'services/compiler/AGENTS.md',
  'packages/protocol/AGENTS.md',
  'packages/library/AGENTS.md',
  'packages/pipeline/AGENTS.md',
  'packages/distribution-default/AGENTS.md',
  'packages/registry-client/AGENTS.md',
  'providers/evidence-docling-llamaindex/AGENTS.md',
  'providers/embedding-fastembed/AGENTS.md',
  'providers/embedding-tei/AGENTS.md',
  'providers/index-faiss/AGENTS.md',
  'providers/index-meilisearch/AGENTS.md',
  'providers/retrieval-hybrid/AGENTS.md',
  'deploy/AGENTS.md',
  'tests/AGENTS.md',
];
const stalePaths = ['src/runtime/', 'src/compiler/', 'src/indexes/', 'src/read/', 'src/router/', 'src/cli/'];
const errors = [];

for (const relative of required) {
  const target = path.join(root, relative);
  const source = await fs.readFile(target, 'utf8').catch(() => null);
  if (source === null) {
    errors.push(`missing ${relative}`);
    continue;
  }
  if (relative !== 'AGENTS.md' && wordCount(source) > 300) errors.push(`${relative} exceeds 300 words`);
  for (const stale of stalePaths) {
    if (source.includes(stale)) errors.push(`${relative} contains stale path ${stale}`);
  }
  for (const link of markdownLinks(source)) {
    if (/^[a-z]+:/i.test(link) || link.startsWith('#')) continue;
    const resolved = path.resolve(path.dirname(target), link.split('#')[0]);
    if (!(await exists(resolved))) errors.push(`${relative} has missing link ${link}`);
  }
}

if (errors.length > 0) throw new Error(`AGENTS guidance check failed:\n- ${errors.join('\n- ')}`);
console.log(`AGENTS guidance OK (${required.length} ownership boundaries).`);

function wordCount(source) {
  return source.replace(/[`#*|()[\]]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function markdownLinks(source) {
  return [...source.matchAll(/\[[^\]]*]\(([^)]+)\)/g)].map((match) => match[1]);
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
