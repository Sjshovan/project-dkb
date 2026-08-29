import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const workspaceRoots = await discoverWorkspaces();
const errors = [];
const workspaceByName = new Map(workspaceRoots.map((workspace) => [workspace.manifest.name, workspace]));
const providerPackageNames = new Set(workspaceRoots
  .filter((workspace) => workspace.kind === 'providers')
  .map((workspace) => workspace.manifest.name));
const retiredProductPaths = [
  'apps/cli/src/registry/packageRegistry.ts',
  'apps/cli/src/registry/server.ts',
  'apps/cli/src/mcp/server.ts',
  'apps/cli/src/mcp/tools.ts',
];

for (const retiredPath of retiredProductPaths) {
  if (await exists(path.join(root, retiredPath))) errors.push(`${retiredPath} is a retired product path`);
}

for (const workspace of workspaceRoots) {
  for (const exportPath of Object.keys(workspace.manifest.exports ?? {})) {
    if (exportPath.includes('*')) errors.push(`${relativePath(path.join(workspace.root, 'package.json'))} exposes wildcard export ${exportPath}`);
  }

  const files = await listTypeScript(path.join(workspace.root, 'src'));
  const dependencies = new Set(Object.keys({
    ...(workspace.manifest.dependencies ?? {}),
    ...(workspace.manifest.optionalDependencies ?? {}),
    ...(workspace.manifest.peerDependencies ?? {}),
  }));

  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), specifier);
        const relative = path.relative(workspace.root, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          errors.push(`${relativePath(file)} crosses its workspace with ${specifier}`);
        }
      } else if (!specifier.startsWith('node:')) {
        const packageName = dependencyName(specifier);
        if (packageName !== workspace.manifest.name && !dependencies.has(packageName)) {
          errors.push(`${relativePath(file)} imports undeclared dependency ${packageName}`);
        }
        const dependencyWorkspace = workspaceByName.get(packageName);
        if (dependencyWorkspace && packageName !== workspace.manifest.name) {
          const subpath = specifier.slice(packageName.length);
          const exportPath = subpath ? `.${subpath}` : '.';
          if (!Object.hasOwn(dependencyWorkspace.manifest.exports ?? {}, exportPath)) {
            errors.push(`${relativePath(file)} imports unexported workspace path ${specifier}`);
          }
        }
        if (workspace.kind === 'providers' && packageName.startsWith('@sjshovan/dkb-') && providerPackageNames.has(packageName)) {
          errors.push(`${relativePath(file)} imports provider package ${packageName}; providers may collaborate only through Pipeline contracts`);
        }
      }
    }
  }
}

const genericCoreRoots = [
  'packages/protocol/src',
  'packages/pipeline/src',
  'packages/library/src',
  'services/compiler/src',
  'services/runtime/src',
  'apps/cli/src/stack',
];
const concreteProviderPattern = /docling|llamaindex|fastembed|faiss|meilisearch|retrieval-hybrid|providers-bundled|@dkb\/(?:evidence|embedding|index|retrieval)-/iu;
const legacyArtifactPattern = /\.dkb[\\/]artifacts|source\.index(?:\.graph|\.vector\.json)?|nativeResult/iu;

for (const genericRoot of genericCoreRoots) {
  for (const file of await sourceFiles(path.join(root, genericRoot))) {
    const source = await fs.readFile(file, 'utf8');
    if (concreteProviderPattern.test(source)) errors.push(`${relativePath(file)} contains a concrete provider identifier`);
    if (legacyArtifactPattern.test(source)) errors.push(`${relativePath(file)} contains a retired artifact path or reader`);
  }
}

const pipelineTypes = await fs.readFile(path.join(root, 'packages/pipeline/src/types.ts'), 'utf8');
const evidenceRecordContract = pipelineTypes.match(/export interface DkbPipelineRecord\s*\{([\s\S]*?)\n\}/u)?.[1] ?? '';
if (/\b(?:embedding|vector|vectors)\s*\??\s*:/u.test(evidenceRecordContract)) {
  errors.push('packages/pipeline/src/types.ts allows retrieval vectors on the provider-neutral Evidence record contract');
}

const approvedDistributionImports = new Set([
  'apps/cli/src/cli/index.ts',
  'services/compiler/src/compile.ts',
  'services/compiler/src/server.ts',
  'services/runtime/src/defaultComposition.ts',
]);
for (const sourceRoot of ['apps/cli/src', 'services/compiler/src', 'services/runtime/src']) {
  for (const file of await listTypeScript(path.join(root, sourceRoot))) {
    const source = await fs.readFile(file, 'utf8');
    if (source.includes('@sjshovan/dkb-distribution-default') && !approvedDistributionImports.has(relativePath(file))) {
      errors.push(`${relativePath(file)} imports the default distribution outside an approved composition root`);
    }
  }
}

for (const sourceRoot of ['apps', 'services', 'packages', 'providers']) {
  for (const file of await sourceFiles(path.join(root, sourceRoot))) {
    const relative = relativePath(file);
    if (relative === 'apps/cli/src/cli/commandLifecycle.ts') continue;
    const source = await fs.readFile(file, 'utf8');
    if (/\b(?:TODO|FIXME|HACK)\b|not (?:yet )?implemented/iu.test(source)) {
      errors.push(`${relative} contains deferred-work language outside the structured capability boundary`);
    }
  }
}

if (errors.length > 0) throw new Error(`Package boundary check failed:\n- ${errors.join('\n- ')}`);
console.log(`Package boundaries OK (${workspaceRoots.length} workspaces).`);

async function discoverWorkspaces() {
  const result = [];
  for (const parentName of ['apps', 'services', 'packages', 'providers']) {
    const parent = path.join(root, parentName);
    for (const entry of await fs.readdir(parent, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const workspaceRoot = path.join(parent, entry.name);
      const manifest = await fs.readFile(path.join(workspaceRoot, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (manifest?.name) result.push({ root: workspaceRoot, manifest, kind: parentName });
    }
  }
  return result;
}

async function listTypeScript(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScript(target);
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
  }));
  return nested.flat();
}

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', 'graphify-out'].includes(entry.name)) return sourceFiles(target);
    return entry.isFile() && /\.(?:ts|mjs|py)$/u.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

function importSpecifiers(source) {
  const matches = [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ];
  return matches.map((match) => match[1]);
}

function relativePath(target) {
  return path.relative(root, target).replace(/\\/g, '/');
}

function dependencyName(specifier) {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
