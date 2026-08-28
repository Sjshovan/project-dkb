import path from 'node:path';
import fs from 'node:fs/promises';
import { watch } from 'chokidar';
import { loadCompose } from '@sjshovan/dkb-protocol/manifest.js';
import { resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import { compileComposeProject } from '@sjshovan/dkb-compiler/compile.js';
import { invalidateQueryContext } from '@sjshovan/dkb-runtime/indexes/queryContext.js';

export interface WatchComposeOptions {
  once?: boolean;
  onEvent?: (event: Record<string, unknown>) => void;
}

export async function watchComposeProject(root: string, options: WatchComposeOptions = {}) {
  const resolvedRoot = path.resolve(root);
  const library = await loadCompose(resolvedRoot);
  const allDkbs = [
    ...library.collections.flatMap((collection) => collection.dkbs),
    ...library.dkbs,
  ];
  const editableDkbRoots = allDkbs
    .filter((dkb) => !isInside(path.join(resolvedRoot, 'vendor'), path.resolve(dkb.root)))
    .map((dkb) => path.resolve(dkb.root));
  const hasLibraryManifest = await hasLibraryProjectManifest(resolvedRoot);
  const watchPaths = [
    ...(hasLibraryManifest ? [resolvedRoot] : []),
    ...allDkbs.filter((dkb) => editableDkbRoots.includes(path.resolve(dkb.root))).flatMap((dkb) => {
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
    ignored: (target) => isIgnoredLibraryWatchPath(resolvedRoot, target, editableDkbRoots),
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

function isIgnoredLibraryWatchPath(root: string, target: string, editableDkbRoots: string[]): boolean {
  const resolved = path.resolve(target);

  if (editableDkbRoots.some((packageRoot) => isInside(packageRoot, resolved))) {
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

async function hasLibraryProjectManifest(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dkb.json'), 'utf8')) as { type?: unknown };

    return manifest.type === 'library';
  } catch {
    return false;
  }
}
