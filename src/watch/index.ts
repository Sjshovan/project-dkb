import path from 'node:path';
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
  const watchPaths = [
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ].flatMap((dkb) => {
    return [
      dkb.packagePath ?? resolveFrom(dkb.root, 'dkb.json'),
      ...(dkb.manifest.stores ?? []).flatMap((store) => store.path ? [resolveFrom(dkb.root, store.path)] : []),
    ];
  });
  const watcher = watch(watchPaths, {
    ignoreInitial: true,
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
