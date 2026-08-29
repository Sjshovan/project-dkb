import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { type DkbInstallPlan } from '@sjshovan/dkb-protocol/builds.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { registryPackagePath } from '@sjshovan/dkb-protocol/identity.js';
import { loadDkbPackage, loadLibrary } from '@sjshovan/dkb-protocol/manifest.js';
import { evidenceBuildPath, retrievalBuildPath } from '@sjshovan/dkb-protocol/paths.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import type { DkbLockManifest, DkbPackageReceipt, DkbSigningKeyRecord, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import { validateCompiledPackage } from '@sjshovan/dkb-library/builds.js';
import { hashPortablePackageTree } from '@sjshovan/dkb-library/packageTree.js';
import {
  DKB_PACKAGE_RECEIPT_PATH,
  packageReceiptPayloadForLock,
  parsePackageReceipt,
  verifyLayerReceipt,
  verifyPackageReceipt,
} from '@sjshovan/dkb-library/signing.js';
import { activateStoredPackageBuild } from '@sjshovan/dkb-library/builds.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { extractDkbPackageArchive } from '@sjshovan/dkb-library/archive.js';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import { ensureRuntimeState, importCompiledDkbArtifactIntoRuntime } from './state.js';
import type { DkbRuntimeContext } from './context.js';

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
  runtime: DkbRuntimeContext;
  registryUrl: string;
  registryToken?: string;
  packageId: string;
  version?: string;
  target?: string;
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

  try {
    const plan = await client.installPlan(options.packageId, release.version, options.target);
    const publicKeys = await client.publicKeys() as { keys: DkbSigningKeyRecord[] };
    for (const artifact of plan.artifacts) {
      const extension = artifact.kind === 'source' ? '.dkbpkg' : artifact.kind === 'evidence' ? '.dkbevidence' : '.dkbbuild';
      await client.writeInstallLayer(artifact, path.join(downloadRoot, `${artifact.kind}${extension}`), { progress: options.progress });
    }
    return await installDkbPlanIntoRuntime({
      runtime: options.runtime,
      plan,
      layerRoot: downloadRoot,
      trustedKeys: publicKeys.keys,
      runtimeRoot: runtime.stateRoot,
      force: options.force,
      progress: options.progress,
    });
  } finally {
    await fs.rm(downloadRoot, { recursive: true, force: true });
  }
}

export async function installDkbPlanIntoRuntime(options: {
  runtime: DkbRuntimeContext;
  plan: DkbInstallPlan;
  layerRoot: string;
  runtimeRoot?: string;
  trustedKeys: DkbSigningKeyRecord[];
  force?: boolean;
  progress?: DkbProgressReporter;
}): Promise<DkbRegistryInstallResult> {
  const runtime = await ensureRuntimeState(options.runtimeRoot);
  const installParent = await fs.mkdtemp(path.join(runtime.stateDir, 'tmp-layer-install-'));
  const extractedRoot = path.join(installParent, 'package');

  try {
    const materialized = await materializeDkbInstallPlan({
      plan: options.plan,
      layerRoot: options.layerRoot,
      destinationRoot: extractedRoot,
      trustedKeys: options.trustedKeys,
      progress: options.progress,
    });
    const imported = await importCompiledDkbArtifactIntoRuntime({
      runtime: options.runtime,
      sourcePath: extractedRoot,
      id: materialized.verification.packageId,
      force: options.force,
      progress: options.progress,
      registryReceipt: materialized.receipt,
      archiveHash: materialized.installDigest,
    }, runtime.stateRoot);

    return {
      status: 'installed',
      packageId: materialized.verification.packageId,
      version: materialized.verification.version,
      runtimeRoot: imported.libraryPath,
      packagePath: imported.packagePath,
      verification: materialized.verification,
      catalog: imported.catalog,
      ...(imported.warning ? { warning: imported.warning } : {}),
    };
  } finally {
    await fs.rm(installParent, { recursive: true, force: true });
  }
}

export async function materializeDkbInstallPlan(options: {
  plan: DkbInstallPlan;
  layerRoot: string;
  destinationRoot: string;
  trustedKeys: DkbSigningKeyRecord[];
  progress?: DkbProgressReporter;
}): Promise<{
  root: string;
  receipt: DkbPackageReceipt;
  verification: DkbPackageVerification;
  installDigest: string;
}> {
  const destinationRoot = path.resolve(options.destinationRoot);
  const resolver = ({ role, signature }: { role: 'publisher' | 'registry'; signature: { keyId: string } }) => {
    const key = options.trustedKeys.find((candidate) => candidate.id === signature.keyId && candidate.subjectType === role);
    return key && key.status !== 'revoked' ? key.publicKeyPem : null;
  };
  const [source, evidence, retrieval] = options.plan.artifacts;
  const sourcePath = path.join(options.layerRoot, 'source.dkbpkg');
  const evidencePath = path.join(options.layerRoot, 'evidence.dkbevidence');
  const retrievalPath = path.join(options.layerRoot, 'retrieval.dkbbuild');
  const sourceReceipt = parsePackageReceipt(source.receipt, 'Install plan source receipt');
  const sourceVerification = await verifyPackageReceipt(sourceReceipt, resolver);
  const evidenceVerification = await verifyLayerReceipt(evidence.receipt, resolver, 'Install plan Evidence receipt');
  const retrievalVerification = await verifyLayerReceipt(retrieval.receipt, resolver, 'Install plan Retrieval receipt');
  const planVerification = await verifyLayerReceipt(options.plan.receipt, resolver, 'Install plan receipt');
  const planPayload = { ...options.plan } as Record<string, unknown>;
  delete planPayload.receipt;
  const receiptChecks = [
    sourceVerification.ok,
    evidenceVerification.ok,
    retrievalVerification.ok,
    planVerification.ok,
    stableHash(source.receipt) === source.receiptHash,
    evidenceVerification.receiptHash === evidence.receiptHash,
    retrievalVerification.receiptHash === retrieval.receiptHash,
    evidenceVerification.receipt.parentReceiptHash === source.receiptHash,
    retrievalVerification.receipt.parentReceiptHash === evidence.receiptHash,
    canonicalJson(planVerification.receipt.payload) === canonicalJson(planPayload),
    sourceReceipt.package.id === options.plan.package.id,
    sourceReceipt.package.version === options.plan.package.version,
    source.digest === options.plan.package.sourceDigest,
    evidenceVerification.receipt.package.id === options.plan.package.id,
    evidenceVerification.receipt.package.version === options.plan.package.version,
    retrievalVerification.receipt.package.id === options.plan.package.id,
    retrievalVerification.receipt.package.version === options.plan.package.version,
    evidenceVerification.receipt.payload.evidenceProfileDigest === options.plan.evidenceProfileDigest,
    evidenceVerification.receipt.payload.evidenceDigest === options.plan.evidenceDigest,
    retrievalVerification.receipt.payload.target === options.plan.target,
    retrievalVerification.receipt.payload.evidenceProfileDigest === options.plan.evidenceProfileDigest,
    retrievalVerification.receipt.payload.evidenceDigest === options.plan.evidenceDigest,
    retrievalVerification.receipt.payload.retrievalProfileDigest === options.plan.retrievalProfileDigest,
    retrievalVerification.receipt.payload.retrievalBuildDigest === options.plan.retrievalBuildDigest,
    retrievalVerification.receipt.payload.compatibilityDigest === options.plan.compatibilityDigest,
  ];
  if (receiptChecks.some((check) => !check)) throw new DkbError('Registry install plan receipt chain or build identity is invalid');

  const archiveDigests = await Promise.all([
    hashArchiveFile(sourcePath),
    hashArchiveFile(evidencePath),
    hashArchiveFile(retrievalPath),
  ]);
  const expectedDigests = [source.digest, evidence.digest, retrieval.digest];
  const mismatchedArchive = archiveDigests.findIndex((digest, index) => digest !== expectedDigests[index]);
  if (mismatchedArchive >= 0) {
    const kind = options.plan.artifacts[mismatchedArchive]!.kind;
    throw new DkbError(
      `Registry ${kind} layer hash mismatch: expected ${expectedDigests[mismatchedArchive]}, got ${archiveDigests[mismatchedArchive]}.`,
    );
  }

  await fs.rm(destinationRoot, { recursive: true, force: true });
  await extractDkbPackageArchive(sourcePath, destinationRoot, { progress: options.progress });
  await fs.rm(path.join(destinationRoot, '.dkb'), { recursive: true, force: true });
  await Promise.all([
    fs.rm(path.join(destinationRoot, 'dkb-profile.lock.json'), { force: true }),
    fs.rm(path.join(destinationRoot, 'dkb-release.json'), { force: true }),
    fs.rm(path.join(destinationRoot, DKB_PACKAGE_RECEIPT_PATH), { force: true }),
  ]);
  const evidenceTarget = evidenceBuildPath(destinationRoot, options.plan.evidenceProfileDigest, options.plan.evidenceDigest);
  const retrievalTarget = retrievalBuildPath(destinationRoot, options.plan.retrievalProfileDigest, options.plan.retrievalBuildDigest);
  await extractDkbPackageArchive(evidencePath, evidenceTarget, { progress: options.progress });
  await extractDkbPackageArchive(retrievalPath, retrievalTarget, { progress: options.progress });
  await fs.writeFile(path.join(destinationRoot, DKB_PACKAGE_RECEIPT_PATH), `${JSON.stringify(sourceReceipt, null, 2)}\n`, 'utf8');
  await activateStoredPackageBuild({
    root: destinationRoot,
    target: options.plan.target,
    evidenceProfileDigest: options.plan.evidenceProfileDigest,
    retrievalProfileDigest: options.plan.retrievalProfileDigest,
    compatibilityDigest: options.plan.compatibilityDigest,
  });
  const { receipt, verification } = await verifyExtractedPackage(
    destinationRoot,
    options.trustedKeys,
    options.progress,
    { verifyReceiptArtifacts: false },
  );
  if (!verification.ok) {
    const failed = verification.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.detail}`)
      .join('; ');
    throw new DkbError(
      `Registry layered package verification failed: ${verification.packageId}@${verification.version}`
      + (failed ? ` (${failed})` : ''),
    );
  }

  return {
    root: destinationRoot,
    receipt,
    verification,
    installDigest: stableHash({ source: source.digest, evidence: evidence.digest, retrieval: retrieval.digest }),
  };
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
  runtime: DkbRuntimeContext;
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
      runtime: options.runtime,
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
  options: { verifyReceiptArtifacts?: boolean } = {},
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
  const artifact = await validateCompiledPackage(root);
  // A portable source receipt may have been published with a Registry-default
  // compiled chain. Layered installs authenticate the selected Evidence and
  // Retrieval Builds through their own signed child receipts, so applying the
  // source receipt's artifact hashes to another valid retrieval space would
  // incorrectly reject it. The active artifact manifest is still verified
  // below, and materialization validates the exact signed build graph.
  const artifactChecks = options.verifyReceiptArtifacts === false
    ? []
    : await verifyLockArtifacts(root, receipt.payload.lock);
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
  const verification = await validateCompiledPackage(root);
  const graph = verification.graph;
  if (!graph) return verification.checks;
  const runtimeDigest = stableHash(graph.runtime);
  return [
    {
      name: 'build.evidence',
      ok: lock.builds.evidence.digest === graph.evidence.evidenceDigest
        && lock.builds.evidence.profileDigest === graph.evidence.evidenceProfileDigest,
      detail: `${graph.evidence.evidenceProfileDigest}/${graph.evidence.evidenceDigest}`,
    },
    {
      name: 'build.retrieval',
      ok: lock.builds.retrieval.digest === graph.retrieval.retrievalBuildDigest
        && lock.builds.retrieval.profileDigest === graph.retrieval.retrievalProfileDigest
        && lock.builds.retrieval.compatibilityDigest === graph.retrieval.compatibilityDigest,
      detail: `${graph.retrieval.retrievalProfileDigest}/${graph.retrieval.retrievalBuildDigest}`,
    },
    {
      name: 'build.runtime',
      ok: lock.builds.runtime.target === graph.runtime.target
        && lock.builds.runtime.digest === runtimeDigest,
      detail: `${graph.runtime.target}/${runtimeDigest}`,
    },
  ];
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
