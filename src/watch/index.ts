import path from 'node:path';
import fs from 'node:fs/promises';
import { watch } from 'chokidar';
import { loadCompose } from '../protocol/manifest.js';
import { resolveFrom } from '../protocol/paths.js';
import { compileComposeProject } from '../compiler/compile.js';
import { invalidateQueryContext } from '../indexes/queryContext.js';

export interface WatchComposeOptions {
  once?: boolean;
  onEvent?: (event: Record<string, unknown>) => void;
}

export async function watchComposeProject(root: string, options: WatchComposeOptions = {}) {
  const resolvedRoot = path.resolve(root);
  const registry = await loadCompose(resolvedRoot);
  const allDkbs = [
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ];
  const explicitPackageRoots = allDkbs
    .filter((dkb) => dkb.manifest.meta?.sourceOrigin !== 'registry-local')
    .map((dkb) => path.resolve(dkb.root));
  const hasRegistryManifest = await hasRegistryProjectManifest(resolvedRoot);
  const watchPaths = [
    ...(hasRegistryManifest ? [resolvedRoot] : []),
    ...allDkbs.flatMap((dkb) => {
      const storePaths = (dkb.manifest.stores ?? []).flatMap((store) => {
        const included = store.meta?.includePaths;

        if (Array.isArray(included)) {
          return included
            .filter((item): item is string => typeof item === 'string')
            .map((item) => resolveFrom(dkb.root, item));
        }

        return store.path ? [resolveFrom(dkb.root, store.path)] : [];
      });

      return [
        dkb.packagePath ?? resolveFrom(dkb.root, 'dkb.json'),
        ...storePaths,
      ];
    }),
  ];
  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    ignored: (target) => isIgnoredRegistryWatchPath(resolvedRoot, target, explicitPackageRoots),
    awaitWriteFinish: {
      stabilityThreshold: 250,
      pollInterval: 100,
    },
  });
  let running = false;

  const rebuild = async (eventName: string, changedPath: string) => {
    if (running) {
      return;
    }

    running = true;
    const startedAt = performance.now();

    try {
      const result = await compileComposeProject(resolvedRoot);
      invalidateQueryContext(resolvedRoot);

      options.onEvent?.({
        event: eventName,
        changedPath,
        status: 'rebuilt',
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        recordCount: result.recordCount,
      });
    } catch (error) {
      options.onEvent?.({
        event: eventName,
        changedPath,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;

      if (options.once) {
        await watcher.close();
      }
    }
  };

  watcher.on('all', (eventName, changedPath) => {
    void rebuild(eventName, changedPath);
  });

  return watcher;
}

function isIgnoredRegistryWatchPath(root: string, target: string, explicitPackageRoots: string[]): boolean {
  const resolved = path.resolve(target);

  if (explicitPackageRoots.some((packageRoot) => isInside(packageRoot, resolved))) {
    return false;
  }

  const relative = path.relative(root, resolved);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  const parts = relative.split(path.sep).filter(Boolean);
  const first = parts[0] ?? '';

  return first === '.dkb'
    || first === '.git'
    || first === '.idea'
    || first === 'node_modules'
    || first === 'dist'
    || first === 'archives'
    || first === 'vendor'
    || first.startsWith('.');
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function hasRegistryProjectManifest(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dkb.json'), 'utf8')) as { type?: unknown; dependencies?: unknown };

    return manifest.type === 'registry'
      || (manifest.dependencies !== undefined && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies));
  } catch {
    return false;
  }
}
