import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import { DkbError } from '@dkb/protocol/errors.js';
import { registryPackagePath } from '@dkb/protocol/identity.js';
import { loadDkbPackage, loadLibrary } from '@dkb/protocol/manifest.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '@dkb/protocol/progress.js';
import type { DkbLockArtifact, DkbLockManifest, DkbPackageReceipt, DkbSigningKeyRecord, LoadedDkb } from '@dkb/protocol/types.js';
import { validateDkbArtifactManifest } from '@dkb/library/artifacts.js';
import { hashPortablePackageTree } from '@dkb/library/packageTree.js';
import {
  DKB_PACKAGE_RECEIPT_PATH,
  packageReceiptPayloadForLock,
  parsePackageReceipt,
  verifyPackageReceipt,
} from '@dkb/library/signing.js';
import { readLibraryState } from '@dkb/library/state.js';
import { extractDkbPackageArchive } from '@dkb/registry-client/archive.js';
import { DkbRegistryClient } from '@dkb/registry-client/client.js';
import { ensureRuntimeState, importCompiledDkbArtifactIntoRuntime } from './state.js';

export interface DkbInstallCandidate {
  packageId: string;
  version: string;
  archiveHash?: string;
  packageTreeHash?: string;
}

export interface DkbAlreadyInstalledResult {
  status: 'already_installed';
  packageId: string;
  version: string;
  runtimeRoot: string;
  packagePath: string;
}

export interface DkbPackageVerification {
  ok: boolean;
  packageId: string;
  version: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface DkbRegistryInstallResult {
  status: 'installed';
  packageId: string;
  version: string;
  runtimeRoot: string;
  packagePath: string;
  verification: DkbPackageVerification;
  catalog: { recordCount: number; packageCount: number };
  warning?: string;
}

export async function installDkbFromRegistry(options: {
  registryUrl: string;
  registryToken?: string;
  packageId: string;
  version?: string;
  runtimeRoot?: string;
  force?: boolean;
  progress?: DkbProgressReporter;
}): Promise<DkbRegistryInstallResult | DkbAlreadyInstalledResult> {
  const runtime = await ensureRuntimeState(options.runtimeRoot);
  const client = new DkbRegistryClient({ baseUrl: options.registryUrl, token: options.registryToken });
  const release = await client.packageRelease(options.packageId, options.version);
  const existing = await preflightDkbInstall({
    runtimeRoot: runtime.stateRoot,
    candidate: release,
    force: options.force,
  });
  if (existing) return existing;

  const downloadRoot = await fs.mkdtemp(path.join(runtime.stateDir, 'tmp-registry-download-'));
  const archivePath = path.join(downloadRoot, `${encodeURIComponent(options.packageId)}.dkbpkg`);

  try {
    await client.writePackageArchive(options.packageId, archivePath, release.version, { progress: options.progress });
    const publicKeys = await client.publicKeys() as { keys: DkbSigningKeyRecord[] };
    return await installDkbArchiveIntoRuntime({
      archivePath,
      trustedKeys: publicKeys.keys,
      runtimeRoot: runtime.stateRoot,
      expectedArchiveHash: release.archiveHash,
      force: options.force,
      progress: options.progress,
    });
  } finally {
    await fs.rm(downloadRoot, { recursive: true, force: true });
  }
}

export async function preflightDkbInstall(options: {
  runtimeRoot?: string;
  candidate: DkbInstallCandidate;
  force?: boolean;
}): Promise<DkbAlreadyInstalledResult | null> {
  const runtime = await ensureRuntimeState(options.runtimeRoot);
  const installedRoots = await installedPackageRoots(runtime.stateRoot, options.candidate.packageId);
  if (installedRoots.length === 0) return null;

  const installedRoot = installedRoots[0]!;
  let installedDkb: LoadedDkb;
  try {
    installedDkb = await loadDkbPackage(installedRoot, options.candidate.packageId);
  } catch (error) {
    if (options.force) return null;
    throw new DkbError(
      `Runtime contains an unreadable installation of ${options.candidate.packageId} at ${installedRoot}: `
      + `${error instanceof Error ? error.message : String(error)}. Use --force to repair it.`,
    );
  }

  const installedVersion = installedDkb.manifest.version;
  const lockEntry = (await readLibraryState(runtime.stateRoot)).entries[options.candidate.packageId];
  if (!lockEntry) {
    if (options.force) return null;
    throw new DkbError(
      `Runtime contains an incomplete installation of ${options.candidate.packageId}@${installedVersion} at ${installedRoot}. `
      + 'Use --force to repair it.',
    );
  }

  if (installedVersion === options.candidate.version) {
    const digestChanged = Boolean(
      options.candidate.packageTreeHash
      && lockEntry.digest
      && options.candidate.packageTreeHash !== lockEntry.digest,
    );
    const archiveChanged = Boolean(
      !options.candidate.packageTreeHash
      && options.candidate.archiveHash
      && lockEntry.digest
      && options.candidate.archiveHash !== lockEntry.digest,
    );
    if (digestChanged || archiveChanged) {
      throw new DkbError(
        `Registry release ${options.candidate.packageId}@${options.candidate.version} no longer matches the installed release digest. `
        + 'Published versions must be immutable; publish a new version instead.',
      );
    }
    if (!options.force) {
      return {
        status: 'already_installed',
        packageId: options.candidate.packageId,
        version: options.candidate.version,
        runtimeRoot: runtime.stateRoot,
        packagePath: installedRoot,
      };
    }
    return null;
  }

  if (!options.force) {
    throw new DkbError(
      `${options.candidate.packageId}@${installedVersion} is already installed. `
      + `Use --force to replace it with ${options.candidate.packageId}@${options.candidate.version}.`,
    );
  }
  return null;
}

export async function installDkbArchiveIntoRuntime(options: {
  archivePath: string;
  runtimeRoot?: string;
  trustedKeys: DkbSigningKeyRecord[];
  expectedArchiveHash?: string;
  force?: boolean;
  progress?: DkbProgressReporter;
}): Promise<DkbRegistryInstallResult> {
  const runtime = await ensureRuntimeState(options.runtimeRoot);
  const installParent = await fs.mkdtemp(path.join(runtime.stateDir, 'tmp-install-'));
  const extractedRoot = path.join(installParent, 'package');

  try {
    const archiveHash = await hashArchiveFile(options.archivePath, options.progress);
    if (options.expectedArchiveHash && archiveHash !== options.expectedArchiveHash) {
      throw new DkbError(`Package archive hash mismatch: expected ${options.expectedArchiveHash}, got ${archiveHash}.`);
    }
    await extractDkbPackageArchive(options.archivePath, extractedRoot, { progress: options.progress });
    const { receipt, verification } = await verifyExtractedPackage(extractedRoot, options.trustedKeys, options.progress);
    if (!verification.ok) {
      throw new DkbError(`Registry package verification failed: ${verification.packageId}@${verification.version}`);
    }

    const imported = await importCompiledDkbArtifactIntoRuntime({
      sourcePath: extractedRoot,
      id: verification.packageId,
      force: options.force,
      progress: options.progress,
      registryReceipt: receipt,
      archiveHash,
    }, runtime.stateRoot);

    return {
      status: 'installed',
      packageId: verification.packageId,
      version: verification.version,
      runtimeRoot: imported.libraryPath,
      packagePath: imported.packagePath,
      verification,
      catalog: imported.catalog,
      ...(imported.warning ? { warning: imported.warning } : {}),
    };
  } finally {
    await fs.rm(installParent, { recursive: true, force: true });
  }
}

export async function verifyDkbArchiveFile(options: {
  archivePath: string;
  trustedKeys: DkbSigningKeyRecord[];
  expectedArchiveHash?: string;
  progress?: DkbProgressReporter;
}): Promise<DkbPackageVerification> {
  const verifyParent = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-verify-'));
  const extractedRoot = path.join(verifyParent, 'package');

  try {
    const archiveHash = await hashArchiveFile(options.archivePath, options.progress);
    if (options.expectedArchiveHash && archiveHash !== options.expectedArchiveHash) {
      throw new DkbError(`Package archive hash mismatch: expected ${options.expectedArchiveHash}, got ${archiveHash}.`);
    }
    await extractDkbPackageArchive(options.archivePath, extractedRoot, { progress: options.progress });
    return (await verifyExtractedPackage(extractedRoot, options.trustedKeys, options.progress)).verification;
  } finally {
    await fs.rm(verifyParent, { recursive: true, force: true });
  }
}

async function verifyExtractedPackage(
  root: string,
  trustedKeys: DkbSigningKeyRecord[],
  progress?: DkbProgressReporter,
): Promise<{ receipt: DkbPackageReceipt; verification: DkbPackageVerification }> {
  progress?.(progressStart({ phase: 'verify-package', label: 'Verify package contents and signatures', total: 0, unit: 'steps' }));
  const receiptPath = path.join(root, DKB_PACKAGE_RECEIPT_PATH);
  const receipt = parsePackageReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')), receiptPath);
  const packageIds = Object.keys(receipt.payload.lock.packages);
  if (packageIds.length !== 1) {
    throw new DkbError(`Registry package receipt must contain exactly one DKB package, found ${packageIds.length}.`);
  }
  const packageId = packageIds[0]!;
  const version = receipt.payload.lock.packages[packageId]?.version ?? receipt.package.version;
  const payloadMatchesLock = stableHash(packageReceiptPayloadForLock(receipt.payload.lock, receipt.payload.packageTreeHash)) === receipt.payloadHash;
  const sourceTree = receipt.payload.packageTreeHash ? await hashPortablePackageTree(root) : null;
  const packageTreeMatches = !receipt.payload.packageTreeHash || sourceTree?.hash === receipt.payload.packageTreeHash;
  const artifact = await validateDkbArtifactManifest(root, { progress });
  const artifactChecks = await verifyLockArtifacts(root, receipt.payload.lock);
  const signatures = await verifyPackageReceipt(receipt, ({ role, signature }) => {
    const key = trustedKeys.find((candidate) => candidate.id === signature.keyId && candidate.subjectType === role);
    return key && key.status !== 'revoked' ? key.publicKeyPem : null;
  });
  const dkb = await loadDkbPackage(root, packageId);
  const identityMatches = receipt.package.id === packageId
    && dkb.manifest.id === packageId
    && receipt.package.version === version
    && dkb.manifest.version === version;
  const checks = [
    { name: 'payload_matches_lock', ok: payloadMatchesLock, detail: payloadMatchesLock ? 'receipt payload matches lock' : 'receipt payload differs from lock' },
    { name: 'package_tree_hash', ok: packageTreeMatches, detail: packageTreeMatches ? 'package tree hash matches receipt' : `expected ${receipt.payload.packageTreeHash}, got ${sourceTree?.hash}` },
    { name: 'package_identity', ok: identityMatches, detail: identityMatches ? `${packageId}@${version} matches manifest and receipt` : 'manifest, lock, and receipt identity differ' },
    { name: 'artifact_manifest', ok: artifact.ok, detail: artifact.ok ? 'compiled artifact manifest verifies' : 'compiled artifact manifest verification failed' },
    ...artifactChecks,
    ...signatures.checks,
  ];
  progress?.(progressFinish({ phase: 'verify-package', label: 'Verify package contents and signatures', total: checks.length, unit: 'steps' }));

  return {
    receipt,
    verification: { ok: checks.every((check) => check.ok), packageId, version, checks },
  };
}

async function verifyLockArtifacts(root: string, lock: DkbLockManifest) {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  for (const [name, artifact] of Object.entries(lock.artifacts) as Array<[string, DkbLockArtifact | undefined]>) {
    if (!artifact || artifact.status !== 'built') continue;
    const target = containedPath(root, artifact.path);
    const actual = await hashPath(target);
    checks.push({
      name: `artifact.${name}`,
      ok: actual === artifact.hash,
      detail: actual === artifact.hash ? `${name} hash matches lockfile` : `expected ${artifact.hash}, got ${actual ?? 'missing'}`,
    });
  }
  if (lock.compiled?.path && lock.compiled.artifactHash) {
    const target = containedPath(root, lock.compiled.path);
    const actual = await hashPath(target);
    checks.push({
      name: 'artifact.compiled',
      ok: actual === lock.compiled.artifactHash,
      detail: actual === lock.compiled.artifactHash
        ? 'compiled artifact hash matches lockfile'
        : `expected ${lock.compiled.artifactHash}, got ${actual ?? 'missing'}`,
    });
  }
  return checks;
}

async function installedPackageRoots(stateRoot: string, packageId: string): Promise<string[]> {
  const roots = new Set<string>();
  try {
    const library = await loadLibrary(stateRoot);
    for (const dkb of [...library.collections.flatMap((collection) => collection.dkbs), ...library.dkbs]) {
      if (dkb.manifest.id === packageId) roots.add(path.resolve(dkb.root));
    }
  } catch {
    // A bounded vendor check below also detects interrupted installations.
  }
  const candidate = registryPackagePath(stateRoot, packageId);
  if (await exists(path.join(candidate, 'dkb.json'))) roots.add(path.resolve(candidate));
  return [...roots];
}

async function hashArchiveFile(target: string, progress?: DkbProgressReporter): Promise<string> {
  const resolved = path.resolve(target);
  const total = (await fs.stat(resolved)).size;
  const hash = createHash('sha256');
  let completed = 0;
  progress?.(progressStart({ phase: 'verify-archive', label: 'Verify archive', total, unit: 'bytes' }));
  for await (const chunk of createReadStream(resolved)) {
    hash.update(chunk);
    completed += chunk.length;
    progress?.(progressUpdate({ phase: 'verify-archive', label: 'Verify archive', value: completed, total, unit: 'bytes' }));
  }
  progress?.(progressFinish({ phase: 'verify-archive', label: 'Verify archive', total, unit: 'bytes' }));
  return `sha256:${hash.digest('hex')}`;
}

async function hashPath(target: string): Promise<string | null> {
  try {
    const stat = await fs.stat(target);
    if (stat.isFile()) return `sha256:${await hashFile(target)}`;
    if (!stat.isDirectory()) return null;
    const files = await recursiveFiles(target);
    const entries = [];
    for (const file of files) {
      entries.push({ path: path.relative(target, file).replace(/\\/gu, '/'), hash: `sha256:${await hashFile(file)}` });
    }
    return stableHash(entries);
  } catch {
    return null;
  }
}

async function recursiveFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return recursiveFiles(target);
    return entry.isFile() ? [target] : [];
  }));
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}

function containedPath(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new DkbError(`Package file escapes package root: ${relative}`);
  }
  return target;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
