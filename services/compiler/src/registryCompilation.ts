import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compileComposeProject, compileRetrievalFromEvidence } from './compilerCore.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
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
import { resolveContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { summarizeCompilerDeliveryStatistics } from './buildStatistics.js';
import { createCompilerWorkDirectory } from './workRoot.js';

export interface RegistryCompileRequest {
  jobId: string;
  request: {
    package?: {
      id?: string;
      name?: string;
      version?: string;
      publisherId?: string;
      registryId?: string;
    };
    target?: string;
    stage?: 'pipeline' | 'retrieval';
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
    deliver?: (compiled: CompiledRegistryPackageDelivery) => Promise<void>;
  },
): Promise<Record<string, unknown>> {
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
  const uploadPath = path.join(scratch, input.sourceArchive.fileName ?? 'source.dkbpkg');
  const evidenceUploadPath = path.join(scratch, input.evidenceArchive?.fileName ?? 'evidence.dkbevidence');
  const evidenceExtractedRoot = path.join(scratch, 'evidence');
  const extractedRoot = path.join(scratch, 'source');
  const requestedPackageId = input.request.package?.id;
  const buildRoot = path.join(scratch, safeId(requestedPackageId ?? 'build'));
  const archivePath = path.join(scratch, 'compiled.dkbpkg');
  const contextConfig = await resolveContextConfig(options.contextRoot, { defaults: options.distribution.defaults });
  const target = input.request.target ?? contextConfig.activeTarget;
  if (target !== contextConfig.activeTarget) {
    throw new DkbError(`Registry compiler accepts only its active target "${contextConfig.activeTarget}", not "${target}"`);
  }
  try {
    await fs.writeFile(uploadPath, sourceArchive);
    await extractDkbPackageArchive(uploadPath, extractedRoot);
    await copyDkbSourceOnly(extractedRoot, buildRoot);
    const dkb = await loadDkb(buildRoot);
    const packageId = input.request.package?.id ?? dkb.manifest.id;
    const version = input.request.package?.version ?? dkb.manifest.version;
    const publisherId = input.request.package?.publisherId ?? parseDkbIdentity(dkb.manifest.id).namespace;

    assertRegistryPackageManifest(dkb, packageId, version, publisherId);
    const sourceTreeHash = await hashPackageTree(buildRoot);
    const stage = input.request.stage ?? 'pipeline';
    const compiled = stage === 'retrieval'
      ? await compileRetrievalStage(
          input,
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
          mode: 'package',
          target,
          contextRoot: options.contextRoot,
        });
    const graph = await validatePackageBuildGraph(buildRoot);
    await fs.rm(manifestPath(buildRoot, 'dkb-release.json'), { force: true });
    const packageTreeHash = await hashPackageTree(buildRoot);
    await createDkbPackageArchive(buildRoot, archivePath);

    const artifactManifestPath = path.join(graph.retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME);
    const artifactManifest = await fs.readFile(artifactManifestPath);
    const archiveHash = `sha256:${await hashFile(archivePath)}`;
    const archiveSize = (await fs.stat(archivePath)).size;
    const archiveFileName = packageArchiveFileName(packageId, version);
    const payload: Record<string, unknown> = {
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

    if (options.deliver) {
      await options.deliver({ payload, archivePath, archiveSize });
      return payload;
    }
    const archive = await fs.readFile(archivePath);
    return {
      ...payload,
      archive: {
        fileName: archiveFileName,
        hash: archiveHash,
        contents: archive.toString('base64'),
      },
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function compileRetrievalStage(
  input: RegistryCompileRequest,
  buildRoot: string,
  evidenceUploadPath: string,
  evidenceExtractedRoot: string,
  target: string,
  packageId: string,
  version: string,
  options: { distribution: DkbDistribution; contextRoot: string },
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
    filter: (candidate) => !isDkbSystemArtifactPath(sourceRoot, candidate),
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

async function hashPackageTree(root: string): Promise<string> {
  const files = (await listFiles(root, root))
    .map((file) => path.relative(root, file).replace(/\\/g, '/'))
    .sort((left, right) => left.localeCompare(right));
  const entries = await Promise.all(files.map(async (relative) => ({
    path: relative,
    hash: `sha256:${createHash('sha256').update(await fs.readFile(path.join(root, relative))).digest('hex')}`,
  })));
  return stableHash(entries);
}

async function listFiles(root: string, sourceRoot?: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (sourceRoot && isDkbSystemArtifactPath(sourceRoot, target)) return [];
    if (entry.isDirectory()) return listFiles(target, sourceRoot);
    return entry.isFile() ? [target] : [];
  }));
  return nested.flat().sort((left, right) => left.localeCompare(right));
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
