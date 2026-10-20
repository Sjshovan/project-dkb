import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compileComposeProject, compileRetrievalFromEvidence } from './compilerCore.js';
import { assertProviderExecutionsSettled, type ProviderExecutionFactory } from './providerExecution.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import {
  DKB_SOURCE_INVENTORY_FORMAT,
  DKB_SOURCE_INVENTORY_MEDIA_TYPE,
  type DkbSourceInventory,
} from '@sjshovan/dkb-protocol/registryCatalog.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { loadDkb } from '@sjshovan/dkb-protocol/manifest.js';
import { manifestPath } from '@sjshovan/dkb-protocol/paths.js';
import { DKB_ARTIFACT_MANIFEST_FILENAME } from '@sjshovan/dkb-protocol/artifacts.js';
import { validateEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { validateEvidenceBuildLock } from '@sjshovan/dkb-protocol/builds.js';
import {
  DKB_RETRIEVAL_BUILD_PROFILE_LOCK,
  validatePackageBuildGraph,
} from '@sjshovan/dkb-library/builds.js';
import { DKB_PACKAGE_RECEIPT_PATH } from '@sjshovan/dkb-library/signing.js';
import { createDkbPackageArchive, DKB_PACKAGE_EXTENSION, extractDkbPackageArchive } from '@sjshovan/dkb-library/archive.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { summarizeCompilerDeliveryStatistics } from './buildStatistics.js';
import { createCompilerWorkDirectory } from './workRoot.js';
import { resolveRegistryCompilerTarget } from './registryTargets.js';
import { assertCompilerBuildCurrent, readCompilerBuildIdentity } from './compilerCapabilities.js';
import type { RegistryCompileExecution } from './registryJobControl.js';

export interface RegistryCompileRequest {
  jobId: string;
  request: {
    execution?: RegistryCompileExecution;
    expectedCompilerBuildDigest?: string;
    package?: {
      id?: string;
      name?: string;
      version?: string;
      publisherId?: string;
      registryId?: string;
    };
    target?: string;
    stage?: 'pipeline' | 'retrieval';
    evidenceProfileDigest?: string;
    retrievalProfileDigest?: string;
    compatibilityDigest?: string;
    providerBuildDigest?: string;
  };
  sourceArchive: {
    fileName?: string;
    hash?: string;
    contents: string;
  };
  evidenceArchive?: {
    fileName?: string;
    hash?: string;
    contents: string;
  };
}

export interface CompiledRegistryPackageDelivery {
  payload: Record<string, unknown>;
  archivePath: string;
  archiveSize: number;
}

export async function compileRegistryPackage(
  input: RegistryCompileRequest,
  options: {
    distribution: DkbDistribution;
    contextRoot: string;
    signal?: AbortSignal;
    execution?: ProviderExecutionFactory;
    deliver?: (compiled: CompiledRegistryPackageDelivery) => Promise<void>;
  },
): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  await assertCompilerBuildCurrent();
  const compilerIdentity = await readCompilerBuildIdentity();
  if (input.request.expectedCompilerBuildDigest !== compilerIdentity.buildDigest) {
    throw new DkbError('Registry compiler installation changed after queueing; request a new build with the current compiler identity.', 'compiler_build_drift');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(input.jobId)) {
    throw new DkbError('jobId may contain only letters, numbers, dots, dashes, and underscores');
  }

  const sourceArchive = Buffer.from(input.sourceArchive.contents, 'base64');
  const expectedHash = input.sourceArchive.hash;
  const actualHash = `sha256:${createHash('sha256').update(sourceArchive).digest('hex')}`;
  if (expectedHash && expectedHash !== actualHash) {
    throw new DkbError(`Source archive hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  }

  const scratch = await createCompilerWorkDirectory(`dkb-registry-compile-${input.jobId}-`);
  // Uploaded display names never select a filesystem destination.
  const uploadPath = path.join(scratch, 'source.dkbpkg');
  const evidenceUploadPath = path.join(scratch, 'evidence.dkbevidence');
  const evidenceExtractedRoot = path.join(scratch, 'evidence');
  const extractedRoot = path.join(scratch, 'source');
  const requestedPackageId = input.request.package?.id;
  const buildRoot = path.join(scratch, safeId(requestedPackageId ?? 'build'));
  const archivePath = path.join(scratch, 'compiled.dkbpkg');
  let retainScratch = false;
  try {
    await options.execution?.registerWorkspace(scratch);
    const selectedTarget = await resolveRegistryCompilerTarget({
      distribution: options.distribution,
      contextRoot: options.contextRoot,
      target: input.request.target,
      expected: {
        ...(input.request.evidenceProfileDigest ? { evidenceProfileDigest: input.request.evidenceProfileDigest } : {}),
        ...(input.request.retrievalProfileDigest ? { retrievalProfileDigest: input.request.retrievalProfileDigest } : {}),
        ...(input.request.compatibilityDigest ? { compatibilityDigest: input.request.compatibilityDigest } : {}),
        ...(input.request.providerBuildDigest ? { providerBuildDigest: input.request.providerBuildDigest } : {}),
      },
    });
    const target = selectedTarget.name;
    options.signal?.throwIfAborted();
    await fs.writeFile(uploadPath, sourceArchive);
    await extractDkbPackageArchive(uploadPath, extractedRoot);
    await copyDkbSourceOnly(extractedRoot, buildRoot);
    const dkb = await loadDkb(buildRoot);
    const packageId = input.request.package?.id ?? dkb.manifest.id;
    const version = input.request.package?.version ?? dkb.manifest.version;
    const publisherId = input.request.package?.publisherId ?? parseDkbIdentity(dkb.manifest.id).namespace;

    assertRegistryPackageManifest(dkb, packageId, version, publisherId);
    const sourceTree = await inspectPackageTree(buildRoot);
    const sourceTreeHash = sourceTree.hash;
    const sourceInventory: DkbSourceInventory = {
      format: DKB_SOURCE_INVENTORY_FORMAT,
      package: { id: packageId, version },
      entries: sourceTree.entries,
    };
    const sourceInventoryContents = Buffer.from(`${JSON.stringify(sourceInventory, null, 2)}\n`, 'utf8');
    const stage = input.request.stage ?? 'pipeline';
    const compiled = stage === 'retrieval'
      ? await compileRetrievalStage(
          input,
          actualHash,
          buildRoot,
          evidenceUploadPath,
          evidenceExtractedRoot,
          target,
          packageId,
          version,
          options,
        )
      : await compileComposeProject(buildRoot, {
          distribution: options.distribution,
          force: true,
          target,
          contextRoot: options.contextRoot,
          sourceDigest: actualHash,
          signal: options.signal,
          execution: options.execution,
        });
    options.signal?.throwIfAborted();
    await assertProviderExecutionsSettled(options.execution);
    const graph = await validatePackageBuildGraph(buildRoot);
    await fs.rm(manifestPath(buildRoot, 'dkb-release.json'), { force: true });
    const packageTreeHash = (await inspectPackageTree(buildRoot)).hash;
    await createDkbPackageArchive(buildRoot, archivePath);

    const artifactManifestPath = path.join(graph.retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME);
    const artifactManifest = await fs.readFile(artifactManifestPath);
    const archiveHash = `sha256:${await hashFile(archivePath)}`;
    const archiveSize = (await fs.stat(archivePath)).size;
    const archiveFileName = packageArchiveFileName(packageId, version);
    const payload: Record<string, unknown> = {
      compiler: {
        id: 'dkb.registry.package',
        installedBuildDigest: compilerIdentity.buildDigest,
        target: selectedTarget.name,
        buildDigest: selectedTarget.buildDigest,
        compatibilityDigest: selectedTarget.compatibilityDigest,
        profileDigest: selectedTarget.retrievalProfileDigest,
        providers: selectedTarget.providers,
      },
      build: {
        target,
        evidenceProfileDigest: graph.evidence.evidenceProfileDigest,
        evidenceDigest: graph.evidence.evidenceDigest,
        retrievalProfileDigest: graph.retrieval.retrievalProfileDigest,
        compatibilityDigest: graph.retrieval.compatibilityDigest,
        retrievalBuildDigest: graph.retrieval.retrievalBuildDigest,
      },
      lock: compiled.lock,
      sourceTreeHash,
      sourceInventory: {
        fileName: 'source.inventory.v1.json',
        format: DKB_SOURCE_INVENTORY_FORMAT,
        mediaType: DKB_SOURCE_INVENTORY_MEDIA_TYPE,
        hash: `sha256:${createHash('sha256').update(sourceInventoryContents).digest('hex')}`,
        count: sourceInventory.entries.length,
        bytes: sourceInventoryContents.byteLength,
        contents: sourceInventoryContents.toString('base64'),
      },
      packageTreeHash,
      archive: {
        fileName: archiveFileName,
        hash: archiveHash,
        bytes: archiveSize,
      },
      artifactManifest: {
        fileName: DKB_ARTIFACT_MANIFEST_FILENAME,
        hash: `sha256:${createHash('sha256').update(artifactManifest).digest('hex')}`,
        contents: artifactManifest.toString('base64'),
      },
      logs: Buffer.from(JSON.stringify({
        event: 'dkb.registry.compile.completed',
        stage,
        jobId: input.jobId,
        packageId,
        version,
        recordCount: compiled.recordCount,
      }, null, 2)).toString('base64'),
      recordCount: compiled.recordCount,
      buildStatistics: compiled.profile?.statistics
        ? summarizeCompilerDeliveryStatistics({
            corpus: compiled.profile.statistics.corpus,
            storage: compiled.profile.statistics.storage,
            timingsMs: compiled.profile.timingsMs,
          })
        : undefined,
    };

    await assertCompilerBuildCurrent();
    options.signal?.throwIfAborted();
    await assertProviderExecutionsSettled(options.execution);
    if (options.deliver) {
      await options.deliver({ payload, archivePath, archiveSize });
      return payload;
    }
    const archive = await fs.readFile(archivePath);
    options.signal?.throwIfAborted();
    return {
      ...payload,
      archive: {
        fileName: archiveFileName,
        hash: archiveHash,
        contents: archive.toString('base64'),
      },
    };
  } catch (error) {
    retainScratch = error instanceof DkbError && error.code === 'compile_termination_unconfirmed';
    throw error;
  } finally {
    // Recovery state remains authoritative even if another cleanup error masked the worker error.
    const pending = options.execution ? await options.execution.hasPending().catch(() => true) : false;
    if (!retainScratch && !pending) await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function compileRetrievalStage(
  input: RegistryCompileRequest,
  sourceDigest: string,
  buildRoot: string,
  evidenceUploadPath: string,
  evidenceExtractedRoot: string,
  target: string,
  packageId: string,
  version: string,
  options: { distribution: DkbDistribution; contextRoot: string; signal?: AbortSignal },
) {
  if (!input.evidenceArchive) throw new DkbError('Retrieval-only compilation requires evidenceArchive');
  const bytes = Buffer.from(input.evidenceArchive.contents, 'base64');
  const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (input.evidenceArchive.hash && input.evidenceArchive.hash !== actualHash) {
    throw new DkbError(`Evidence archive hash mismatch: expected ${input.evidenceArchive.hash}, got ${actualHash}`);
  }
  await fs.writeFile(evidenceUploadPath, bytes);
  await extractDkbPackageArchive(evidenceUploadPath, evidenceExtractedRoot);
  const evidencePath = path.join(evidenceExtractedRoot, 'evidence.ir.json');
  const lockPath = path.join(evidenceExtractedRoot, 'evidence.lock.json');
  const evidence = validateEvidenceIr(JSON.parse(await fs.readFile(evidencePath, 'utf8')), evidencePath);
  const lock = validateEvidenceBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
  if (lock.package.id !== packageId
    || lock.package.version !== version
    || lock.package.sourceDigest !== sourceDigest
    || lock.evidenceProfileDigest !== evidence.evidenceProfileDigest
    || lock.evidenceDigest !== evidence.evidenceDigest
    || lock.recordCount !== evidence.evidence.length
    || lock.chunkCount !== evidence.chunks.length) {
    throw new DkbError(`Evidence archive does not match ${packageId}@${version}`);
  }

  return compileRetrievalFromEvidence(buildRoot, evidence, {
    distribution: options.distribution,
    target,
    contextRoot: options.contextRoot,
    sourceDigest,
    evidenceLock: lock,
    signal: options.signal,
  });
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}

async function copyDkbSourceOnly(sourceRoot: string, targetRoot: string): Promise<void> {
  const stat = await fs.stat(sourceRoot);
  if (!stat.isDirectory()) throw new DkbError(`Registry compile source must be a DKB directory: ${sourceRoot}`);
  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (candidate) => !isDkbSystemArtifactPath(sourceRoot, candidate)
      && !isSensitiveSourceInventoryPath(path.relative(sourceRoot, candidate).replace(/\\/g, '/')),
  });
}

function assertRegistryPackageManifest(
  dkb: Awaited<ReturnType<typeof loadDkb>>,
  packageId: string,
  version: string,
  publisherId: string,
): void {
  const identity = parseDkbIdentity(dkb.manifest.id);
  if (packageId !== dkb.manifest.id) {
    throw new DkbError(`Registry compile identity mismatch: requested ${packageId}, source declares ${dkb.manifest.id}`);
  }
  if (publisherId !== identity.namespace) throw new DkbError(`Publisher ${publisherId} does not own ${dkb.manifest.id}`);
  if (version !== dkb.manifest.version) {
    throw new DkbError(`Registry compile version mismatch: requested ${version}, source declares ${dkb.manifest.version}`);
  }
}

async function inspectPackageTree(root: string): Promise<{
  hash: string;
  entries: Array<{ path: string; bytes: number; hash: string }>;
}> {
  const files = (await listFiles(root, root))
    .map((file) => path.relative(root, file).replace(/\\/g, '/'))
    .sort(comparePortablePaths);
  const allEntries = await Promise.all(files.map(async (relative) => {
    const contents = await fs.readFile(path.join(root, relative));
    return {
      path: relative,
      bytes: contents.byteLength,
      hash: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
    };
  }));
  return {
    hash: stableHash(allEntries.map(({ path: entryPath, hash }) => ({ path: entryPath, hash }))),
    entries: allEntries.filter((entry) => !isSensitiveSourceInventoryPath(entry.path)),
  };
}

async function listFiles(root: string, sourceRoot?: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (sourceRoot && (isDkbSystemArtifactPath(sourceRoot, target)
      || isSensitiveSourceInventoryPath(path.relative(sourceRoot, target).replace(/\\/g, '/')))) return [];
    if (entry.isDirectory()) return listFiles(target, sourceRoot);
    return entry.isFile() ? [target] : [];
  }));
  return nested.flat().sort(comparePortablePaths);
}

function comparePortablePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left.replace(/\\/g, '/'), 'utf8'), Buffer.from(right.replace(/\\/g, '/'), 'utf8'));
}

function isSensitiveSourceInventoryPath(relative: string): boolean {
  const parts = relative.split('/').filter(Boolean);
  if (parts.some((part) => ['.git', '.hg', '.svn', '.idea', '.vscode', 'node_modules', 'vendor', 'dist', 'coverage', '__pycache__', '.pytest_cache'].includes(part))) {
    return true;
  }
  const name = (parts.at(-1) ?? '').toLowerCase();
  return name === '.env'
    || name.startsWith('.env.')
    || name === '.npmrc'
    || name === '.pypirc'
    || name === 'credentials.json'
    || name === 'secrets.json'
    || /\.(?:key|pem|p12|pfx)$/u.test(name);
}

function packageArchiveFileName(packageId: string, version: string): string {
  return `${safeId(packageId)}-${safeId(version)}${DKB_PACKAGE_EXTENSION}`;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'package';
}

function isDkbSystemArtifactPath(sourceRoot: string, candidate: string): boolean {
  const relative = path.relative(sourceRoot, candidate);
  if (!relative) return false;
  const parts = relative.split(path.sep);
  const name = path.basename(candidate);
  return parts.includes('.dkb')
    || name === 'dkb-lock.json'
    || name === DKB_RETRIEVAL_BUILD_PROFILE_LOCK
    || name === 'dkb-release.json'
    || name === DKB_PACKAGE_RECEIPT_PATH;
}
