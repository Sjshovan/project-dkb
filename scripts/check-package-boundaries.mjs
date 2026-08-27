import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const workspaceRoots = await discoverWorkspaces();
const errors = [];
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
      }
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
      if (manifest?.name) result.push({ root: workspaceRoot, manifest });
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
