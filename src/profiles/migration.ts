import fs from 'node:fs/promises';
import path from 'node:path';
import { compileComposeProject } from '../compiler/compile.js';
import { DkbError } from '../protocol/errors.js';
import { loadLibrary } from '../protocol/manifest.js';
import { DKB_ARTIFACTS_DIR } from '../protocol/paths.js';
import {
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
  maybeReadRetrievalProfileLock,
  readRetrievalProfileLock,
  resolveLibraryRetrievalProfile,
  supportedRetrievalModels,
} from './retrievalProfile.js';

export interface DkbProfileMigrationPlan {
  root: string;
  current: {
    model: string | null;
    dimensions: number | null;
    profileDigest: string | null;
  };
  target: {
    model: string;
    dimensions: number;
  };
  packages: Array<{ id: string; version: string; root: string }>;
  requiresRecompile: boolean;
  supportedModels: Array<{ model: string; dimensions: number }>;
}

export async function planRetrievalProfileMigration(root: string, model: string): Promise<DkbProfileMigrationPlan> {
  const resolvedRoot = path.resolve(root);
  const library = await loadLibrary(resolvedRoot);
  const desired = resolveLibraryRetrievalProfile(library, model);
  const current = await maybeReadRetrievalProfileLock(resolvedRoot);
  const packages = uniquePackages(library.dkbs
    .concat(library.collections.flatMap((collection) => collection.dkbs)))
    .map((dkb) => ({ id: dkb.manifest.id, version: dkb.manifest.version, root: dkb.root }));

  return {
    root: resolvedRoot,
    current: {
      model: current?.profile.embedding.model ?? null,
      dimensions: current?.profile.embedding.dimensions ?? null,
      profileDigest: current?.profileDigest ?? null,
    },
    target: {
      model: desired.embedding.model,
      dimensions: desired.embedding.dimensions,
    },
    packages,
    requiresRecompile: !current
      || current.profile.embedding.model !== desired.embedding.model
      || current.profile.embedding.dimensions !== desired.embedding.dimensions,
    supportedModels: supportedRetrievalModels(),
  };
}

export async function migrateRetrievalProfile(
  root: string,
  model: string,
  options: { confirmed: boolean },
): Promise<{
  status: 'migrated' | 'unchanged';
  plan: DkbProfileMigrationPlan;
  profileDigest: string | null;
  recordCount?: number;
}> {
  if (!options.confirmed) {
    throw new DkbError('Profile migration recompiles every package. Re-run with --yes after reviewing dkb profile plan.');
  }

  const plan = await planRetrievalProfileMigration(root, model);

  if (!plan.requiresRecompile) {
    return {
      status: 'unchanged',
      plan,
      profileDigest: plan.current.profileDigest,
    };
  }
  if (plan.packages.length === 0) {
    throw new DkbError(`No DKB packages were found under ${plan.root}`);
  }

  const stageParent = await fs.mkdtemp(path.join(path.dirname(plan.root), `.${path.basename(plan.root)}-profile-`));
  const stageRoot = path.join(stageParent, 'root');

  try {
    await copyCanonicalSourceTree(plan.root, stageRoot);
    await writeTargetProfileToManifest(stageRoot, plan.target.model, plan.target.dimensions);

    const compiled = await compileComposeProject(stageRoot, {
      force: true,
      compiler: 'llamaindex',
      artifactProfile: plan.packages.length === 1 ? 'faiss-package' : 'full',
      model: plan.target.model,
    });
    const stagedProfile = await readRetrievalProfileLock(stageRoot);

    if (stagedProfile.profile.embedding.model !== plan.target.model
      || stagedProfile.profile.embedding.dimensions !== plan.target.dimensions) {
      throw new DkbError('Staged profile does not match the requested migration target');
    }

    if (process.env.DKB_TEST_ABORT_PROFILE_MIGRATION_AFTER_COMPILE === '1') {
      throw new DkbError('Aborted profile migration after staged compile');
    }

    await promoteProfileMigration(plan.root, stageRoot);

    return {
      status: 'migrated',
      plan,
      profileDigest: stagedProfile.profileDigest,
      recordCount: compiled.recordCount,
    };
  } finally {
    await fs.rm(stageParent, { recursive: true, force: true });
  }
}

async function copyCanonicalSourceTree(sourceRoot: string, stageRoot: string): Promise<void> {
  await fs.mkdir(stageRoot, { recursive: true });
  await fs.cp(sourceRoot, stageRoot, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (source) => {
      const relative = path.relative(sourceRoot, source).replace(/\\/g, '/');

      if (!relative) {
        return true;
      }

      const segments = relative.split('/');
      const name = segments.at(-1) ?? '';

      return !segments.includes('.git')
        && !segments.includes('.dkb')
        && !segments.includes('.codex-remote-attachments')
        && !segments.includes('__pycache__')
        && name !== 'dkb-lock.json'
        && name !== 'dkb-release.json'
        && name !== DKB_RETRIEVAL_PROFILE_LOCK_PATH
        && !name.endsWith('.dkbpkg')
        && !name.endsWith('.pyc');
    },
  });
}

async function writeTargetProfileToManifest(root: string, model: string, dimensions: number): Promise<void> {
  const target = path.join(root, 'dkb.json');
  const manifest = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;

  manifest.retrievalProfile = {
    compiler: 'llamaindex',
    embedding: {
      adapter: 'fastembed',
      model,
      dimensions,
    },
  };

  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function promoteProfileMigration(root: string, stageRoot: string): Promise<void> {
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const entries = [
    { relative: 'dkb.json', directory: false },
    { relative: DKB_RETRIEVAL_PROFILE_LOCK_PATH, directory: false },
    { relative: DKB_ARTIFACTS_DIR, directory: true },
  ];
  const promoted: Array<{ target: string; backup: string; directory: boolean }> = [];

  try {
    for (const entry of entries) {
      const source = path.join(stageRoot, entry.relative);
      const target = path.join(root, entry.relative);
      const backup = `${target}.profile-backup-${stamp}`;

      await fs.mkdir(path.dirname(target), { recursive: true });
      await moveIfExists(target, backup);
      promoted.push({ target, backup, directory: entry.directory });
      await fs.rename(source, target);
    }

    for (const entry of promoted) {
      await fs.rm(entry.backup, { recursive: entry.directory, force: true });
    }
  } catch (error) {
    for (const entry of promoted.reverse()) {
      await fs.rm(entry.target, { recursive: entry.directory, force: true });
      await moveIfExists(entry.backup, entry.target);
    }
    throw error;
  }
}

async function moveIfExists(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';

    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

function uniquePackages<T extends { root: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [path.resolve(value.root), value])).values()]
    .sort((left, right) => left.root.localeCompare(right.root));
}
