import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const required = [
  'README.md',
  'docs/cli-ux.md',
  'docs/operations.md',
  'docs/security.md',
  'docs/chatgpt-mcp.md',
  'docs/private-releases.md',
  'docs/developer-preview.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'deploy/README.md',
];
const retainedCommandReferences = [
  { pattern: /\bdkb compile\b/iu, command: 'dkb compile' },
  { pattern: /\bdkb add\b/iu, command: 'dkb add' },
  { pattern: /\bdkb registry login\b/iu, command: 'dkb registry login' },
];
const files = [path.join(root, 'README.md'), ...await markdownFiles(path.join(root, 'docs'))];
const errors = [];

for (const target of files) {
  const source = await fs.readFile(target, 'utf8');
  const relative = path.relative(root, target).replace(/\\/g, '/');

  for (const link of markdownLinks(source)) {
    if (/^[a-z]+:/iu.test(link) || link.startsWith('#')) continue;
    const pathPart = decodeURIComponent(link.split('#')[0] ?? '');
    if (!pathPart) continue;
    const resolved = path.resolve(path.dirname(target), pathPart);
    if (!(await exists(resolved))) errors.push(`${relative} has missing link ${link}`);
  }

}

for (const relative of required) {
  if (!(await exists(path.join(root, relative)))) errors.push(`missing required guide ${relative}`);
}

const commandContract = await fs.readFile(path.join(root, 'docs', 'cli-ux.md'), 'utf8');
for (const retained of retainedCommandReferences) {
  if (!retained.pattern.test(commandContract)) {
    errors.push(`docs/cli-ux.md must document retained command ${retained.command}`);
  }
}

if (errors.length > 0) throw new Error(`Documentation check failed:\n- ${errors.join('\n- ')}`);
console.log(`Documentation links and command references OK (${files.length} files).`);

async function markdownFiles(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await markdownFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.md')) output.push(target);
  }
  return output;
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
