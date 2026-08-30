import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const workspaceRoots = ['apps', 'services', 'packages', 'providers'];
const packages = [];

for (const workspaceRoot of workspaceRoots) {
  const parent = path.join(root, workspaceRoot);
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);

  for (const entry of entries.filter((item) => item.isDirectory())) {
    const packageRoot = path.join(parent, entry.name);
    const packagePath = path.join(packageRoot, 'package.json');
    const manifest = await readJson(packagePath);
    if (!manifest?.name) continue;
    packages.push({
      name: manifest.name,
      version: manifest.version,
      root: path.relative(root, packageRoot).replace(/\\/g, '/'),
      manifest,
    });
  }
}

const names = new Set(packages.map((item) => item.name));
const graph = Object.fromEntries(packages
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((item) => [item.name, internalDependencies(item.manifest).filter((name) => names.has(name)).sort()]));

assertAcyclic(graph);
assertBoundaries(graph);

const document = {
  format: 'dkb.workspace-graph.v1',
  packages: packages.map((item) => ({ name: item.name, version: item.version, root: item.root })),
  dependencies: graph,
};
const json = `${JSON.stringify(document, null, 2)}\n`;
const markdown = renderMarkdown(document);
const jsonPath = path.join(root, 'docs/architecture/workspace-dependency-graph.json');
const markdownPath = path.join(root, 'docs/architecture/workspace-dependency-graph.md');

if (process.argv.includes('--check')) {
  await assertCurrent(jsonPath, json);
  await assertCurrent(markdownPath, markdown);
} else {
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, json, 'utf8');
  await fs.writeFile(markdownPath, markdown, 'utf8');
}

function internalDependencies(manifest) {
  return [...new Set(Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  }))];
}

function assertAcyclic(graph) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (name, trail) => {
    if (visiting.has(name)) throw new Error(`Workspace dependency cycle: ${[...trail, name].join(' -> ')}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph[name] ?? []) visit(dependency, [...trail, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(graph)) visit(name, []);
}

function assertBoundaries(graph) {
  const allowed = {
    '@sjshovan/dkb-protocol': [],
    '@sjshovan/dkb-pipeline': ['@sjshovan/dkb-protocol'],
    '@sjshovan/dkb-evidence-docling-llamaindex': ['@sjshovan/dkb-pipeline', '@sjshovan/dkb-protocol'],
    '@sjshovan/dkb-embedding-fastembed': ['@sjshovan/dkb-pipeline', '@sjshovan/dkb-protocol'],
    '@sjshovan/dkb-embedding-tei': ['@sjshovan/dkb-pipeline', '@sjshovan/dkb-protocol'],
    '@sjshovan/dkb-index-faiss': ['@sjshovan/dkb-pipeline', '@sjshovan/dkb-protocol'],
    '@sjshovan/dkb-index-meilisearch': ['@sjshovan/dkb-pipeline', '@sjshovan/dkb-protocol'],
    '@sjshovan/dkb-retrieval-hybrid': ['@sjshovan/dkb-pipeline'],
    '@sjshovan/dkb-distribution-default': ['@sjshovan/dkb-embedding-fastembed', '@sjshovan/dkb-embedding-tei', '@sjshovan/dkb-evidence-docling-llamaindex', '@sjshovan/dkb-index-faiss', '@sjshovan/dkb-index-meilisearch', '@sjshovan/dkb-pipeline', '@sjshovan/dkb-retrieval-hybrid'],
    '@sjshovan/dkb-library': ['@sjshovan/dkb-protocol'],
    '@sjshovan/dkb-registry-client': ['@sjshovan/dkb-library', '@sjshovan/dkb-protocol'],
    '@sjshovan/dkb-compiler': ['@sjshovan/dkb-distribution-default', '@sjshovan/dkb-library', '@sjshovan/dkb-pipeline', '@sjshovan/dkb-protocol', '@sjshovan/dkb-registry-client'],
    '@sjshovan/dkb-runtime': ['@sjshovan/dkb-distribution-default', '@sjshovan/dkb-library', '@sjshovan/dkb-pipeline', '@sjshovan/dkb-protocol', '@sjshovan/dkb-registry-client'],
    '@sjshovan/dkb-console': ['@sjshovan/dkb-protocol'],
    '@sjshovan/dkb-cli': ['@sjshovan/dkb-compiler', '@sjshovan/dkb-console', '@sjshovan/dkb-distribution-default', '@sjshovan/dkb-library', '@sjshovan/dkb-pipeline', '@sjshovan/dkb-protocol', '@sjshovan/dkb-registry-client', '@sjshovan/dkb-runtime'],
  };

  for (const [name, dependencies] of Object.entries(graph)) {
    const permitted = new Set(allowed[name] ?? []);
    const forbidden = dependencies.filter((dependency) => !permitted.has(dependency));
    if (forbidden.length > 0) throw new Error(`${name} has forbidden workspace dependencies: ${forbidden.join(', ')}`);
  }
}

function renderMarkdown(document) {
  const rows = document.packages.map((item) => {
    const dependencies = document.dependencies[item.name];
    return `| \`${item.name}\` | \`${item.version}\` | \`${item.root}\` | ${dependencies.length ? dependencies.map((name) => `\`${name}\``).join(', ') : 'none'} |`;
  });
  return `# Workspace Dependency Graph\n\nGenerated by \`npm run graph:write\`. Do not edit by hand.\n\n| Workspace | Version | Root | Internal dependencies |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`;
}

async function assertCurrent(target, expected) {
  const actual = await fs.readFile(target, 'utf8').catch(() => null);
  if (actual !== expected) throw new Error(`${path.relative(root, target)} is stale. Run npm run graph:write.`);
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, 'utf8'));
}
