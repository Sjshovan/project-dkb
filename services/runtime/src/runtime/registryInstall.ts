import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import {
  validateInstallPlan,
  type DkbInstallPlan,
} from '@sjshovan/dkb-protocol/builds.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { registryPackagePath } from '@sjshovan/dkb-protocol/identity.js';
import { loadDkbPackage, loadLibrary } from '@sjshovan/dkb-protocol/manifest.js';
import { evidenceBuildPath, retrievalBuildPath } from '@sjshovan/dkb-protocol/paths.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import type { DkbLockManifest, DkbPackageReceipt, DkbSigningKeyRecord, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import {
  mergeStoredPackageBuildsWithinMutation,
  selectStoredPackageBuild,
  validateStoredPackageBuild,
  validateCompiledPackage,
} from '@sjshovan/dkb-library/builds.js';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { hashPortablePackageTree } from '@sjshovan/dkb-library/packageTree.js';
import {
  DKB_INSTALL_PLAN_RECEIPT_PATH,
  DKB_INSTALL_PLAN_RECEIPTS_DIR,
  DKB_PACKAGE_RECEIPT_PATH,
  installPlanReceiptPath,
  packageReceiptPayloadMatchesLock,
  parsePackageReceipt,
  parsePersistedPackageReceipt,
  verifyLayerReceipt,
  verifyPackageReceipt,
} from '@sjshovan/dkb-library/signing.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { extractDkbPackageArchive } from '@sjshovan/dkb-library/archive.js';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import { normalizeRegistryUrl } from '@sjshovan/dkb-registry-client/config.js';
import {
  ensureRuntimeState,
  importCompiledDkbArtifactIntoLibrary,
  importCompiledDkbArtifactIntoLibraryWithinMutation,
  importCompiledDkbArtifactIntoRuntime,
} from './state.js';
import type { DkbRuntimeContext } from './context.js';
import type { DkbRuntimeActivation } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { parseRegistryTrustedKeys, pinRegistryTrustedKeys, readPinnedRegistryKeys } from './registryTrust.js';
export { parseRegistryTrustedKeys } from './registryTrust.js';

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
  libraryRoot: string;
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
  libraryRoot: string;
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
  target?: string;
  libraryRoot: string;
  force?: boolean;
  progress?: DkbProgressReporter;
}): Promise<DkbRegistryInstallResult | DkbAlreadyInstalledResult> {
  const libraryRoot = path.resolve(options.libraryRoot);
  await loadLibrary(libraryRoot);
  const client = new DkbRegistryClient({ baseUrl: options.registryUrl, token: options.registryToken });
  const release = await client.packageRelease(options.packageId, options.version);

  // Installing the same immutable release without selecting another target is
  // a package-lifecycle no-op. Only take this fast path when the Registry
  // release exposes the exact package-tree digest and the authoritative
  // Library ledger already records that same Registry DKB/version/digest.
  // Targeted installs must continue through the signed plan so a missing build
  // chain can be acquired and verified.
  if (!options.force && !options.target && release.packageTreeHash) {
    const installed = (await readLibraryState(libraryRoot)).entries[release.packageId];
    if (installed?.kind === 'dkb'
      && installed.source === 'registry'
      && installed.status === 'installed'
      && installed.version === release.version
      && installed.digest === release.packageTreeHash) {
      const existing = await preflightDkbInstall({
        libraryRoot,
        candidate: {
          packageId: release.packageId,
          version: release.version,
          packageTreeHash: release.packageTreeHash,
        },
        registryUrl: client.baseUrl,
      });
      if (existing) return existing;
    }
  }

  const plan = await client.installPlan(options.packageId, release.version, options.target);
  const trustedKeys = parseRegistryTrustedKeys(await client.publicKeys());
  const verified = await verifySignedInstallPlan(plan, trustedKeys);
  const packageTreeHash = requiredSignedPackageTreeHash(verified);
  const existing = await preflightDkbInstall({
    libraryRoot,
    candidate: {
      packageId: release.packageId,
      version: release.version,
      packageTreeHash,
    },
    registryUrl: client.baseUrl,
    force: options.force,
  });
  if (existing) {
    await verifyInstalledSourceForPlan(existing.packagePath, verified, trustedKeys);
    await ensureExistingSignedBuildChain({
      client,
      plan,
      trustedKeys,
      libraryRoot,
      registryUrl: client.baseUrl,
      packageRoot: existing.packagePath,
      progress: options.progress,
    });
    return existing;
  }

  const downloadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-download-'));

  try {
    for (const artifact of plan.artifacts) {
      const extension = artifact.kind === 'source' ? '.dkbpkg' : artifact.kind === 'evidence' ? '.dkbevidence' : '.dkbbuild';
      await client.writeInstallLayer(artifact, path.join(downloadRoot, `${artifact.kind}${extension}`), { progress: options.progress });
    }
    return await installDkbPlanIntoLibrary({
      plan,
      layerRoot: downloadRoot,
      trustedKeys,
      libraryRoot,
      registryUrl: client.baseUrl,
      force: options.force,
      progress: options.progress,
    });
  } finally {
    await fs.rm(downloadRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installDkbFromRuntimeGrant(options: {
  runtime: DkbRuntimeContext;
  registryUrl: string;
  registryTransportUrl?: string;
  installGrant: string;
  plan: DkbInstallPlan;
  runtimeRoot?: string;
  force?: boolean;
  progress?: DkbProgressReporter;
}): Promise<DkbRegistryInstallResult | DkbAlreadyInstalledResult> {
  const plan = validateInstallPlan(options.plan, 'Runtime Registry install plan');
  const runtime = await ensureRuntimeState(options.runtimeRoot);
  const client = new DkbRegistryClient({
    baseUrl: options.registryTransportUrl ?? options.registryUrl,
    installGrant: options.installGrant,
    token: '',
  });
  const trustedKeys = parseRegistryTrustedKeys(await client.publicKeys());
  const verified = await verifySignedInstallPlan(plan, trustedKeys);
  const packageTreeHash = requiredSignedPackageTreeHash(verified);
  const existing = await preflightDkbInstall({
    libraryRoot: runtime.libraryRoot,
    registryUrl: options.registryUrl,
    candidate: {
      packageId: plan.package.id,
      version: plan.package.version,
      packageTreeHash,
    },
    force: options.force,
  });
  if (existing) {
    await verifyInstalledSourceForPlan(existing.packagePath, verified, trustedKeys);
    await ensureExistingSignedBuildChain({
      client,
      plan,
      trustedKeys,
      libraryRoot: runtime.libraryRoot,
      registryUrl: options.registryUrl,
      packageRoot: existing.packagePath,
      progress: options.progress,
    });
    return existing;
  }
  const downloadRoot = await fs.mkdtemp(path.join(runtime.stateDir, 'tmp-registry-grant-download-'));
  try {
    for (const artifact of plan.artifacts) {
      const extension = artifact.kind === 'source' ? '.dkbpkg' : artifact.kind === 'evidence' ? '.dkbevidence' : '.dkbbuild';
      await client.writeInstallLayer(artifact, path.join(downloadRoot, `${artifact.kind}${extension}`), { progress: options.progress });
    }
    return await installDkbPlanIntoRuntime({
      runtime: options.runtime,
      plan,
      layerRoot: downloadRoot,
      trustedKeys,
      runtimeRoot: runtime.stateRoot,
      registryUrl: normalizeRegistryUrl(options.registryUrl),
      force: options.force,
      progress: options.progress,
    });
  } finally {
    await fs.rm(downloadRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensureExistingSignedBuildChain(options: {
  client: DkbRegistryClient;
  plan: DkbInstallPlan;
  trustedKeys: DkbSigningKeyRecord[];
  libraryRoot: string;
  registryUrl: string;
  packageRoot: string;
  progress?: DkbProgressReporter;
}): Promise<void> {
  try {
    const graph = await selectStoredPackageBuild({
      root: options.packageRoot,
      target: options.plan.target,
      evidenceProfileDigest: options.plan.evidenceProfileDigest,
      retrievalProfileDigest: options.plan.retrievalProfileDigest,
      compatibilityDigest: options.plan.compatibilityDigest,
    });
    await verifyStoredSignedBuildChain({
      packageRoot: options.packageRoot,
      graph,
      target: options.plan.target,
      trustedKeys: options.trustedKeys,
    });
    await pinRegistryTrustedKeys({ libraryRoot: options.libraryRoot, registryUrl: options.registryUrl, keys: options.trustedKeys });
    return;
  } catch {
    // The exact signed child chain is absent or untrusted; authenticate downloads and attach it below.
  }

  const downloadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-build-chain-'));
  try {
    await options.client.writeInstallLayer(
      options.plan.artifacts[1],
      path.join(downloadRoot, 'evidence.dkbevidence'),
      { progress: options.progress },
    );
    await options.client.writeInstallLayer(
      options.plan.artifacts[2],
      path.join(downloadRoot, 'retrieval.dkbbuild'),
      { progress: options.progress },
    );
    await attachSignedBuildChain({
      plan: options.plan,
      layerRoot: downloadRoot,
      libraryRoot: options.libraryRoot,
      registryUrl: options.registryUrl,
      packageRoot: options.packageRoot,
      trustedKeys: options.trustedKeys,
      progress: options.progress,
    });
  } finally {
    await fs.rm(downloadRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installDkbPlanIntoRuntime(options: {
  runtime: DkbRuntimeContext;
  plan: DkbInstallPlan;
  layerRoot: string;
  runtimeRoot?: string;
  trustedKeys: DkbSigningKeyRecord[];
  registryUrl: string;
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
    await pinRegistryTrustedKeys({ libraryRoot: runtime.libraryRoot, registryUrl: options.registryUrl, keys: options.trustedKeys });
    const imported = await importCompiledDkbArtifactIntoRuntime({
      runtime: options.runtime,
      sourcePath: extractedRoot,
      id: materialized.verification.packageId,
      force: options.force,
      progress: options.progress,
      registryReceipt: materialized.receipt,
      registryUrl: options.registryUrl,
      archiveHash: materialized.installDigest,
    }, runtime.stateRoot);

    return {
      status: 'installed',
      packageId: materialized.verification.packageId,
      version: materialized.verification.version,
      libraryRoot: imported.libraryPath,
      packagePath: imported.packagePath,
      verification: materialized.verification,
      catalog: imported.catalog,
      ...(imported.warning ? { warning: imported.warning } : {}),
    };
  } finally {
    await fs.rm(installParent, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installDkbPlanIntoLibrary(options: {
  plan: DkbInstallPlan;
  layerRoot: string;
  libraryRoot: string;
  trustedKeys: DkbSigningKeyRecord[];
  registryUrl: string;
  force?: boolean;
  progress?: DkbProgressReporter;
}): Promise<DkbRegistryInstallResult> {
  return installDkbPlanIntoLibraryInternal(options, false);
}

/** Install one signed layer chain inside an existing Library mutation transaction. */
export async function installDkbPlanIntoLibraryWithinMutation(options: Parameters<typeof installDkbPlanIntoLibrary>[0]): Promise<DkbRegistryInstallResult> {
  return installDkbPlanIntoLibraryInternal(options, true);
}

async function installDkbPlanIntoLibraryInternal(
  options: Parameters<typeof installDkbPlanIntoLibrary>[0],
  mutationLockHeld: boolean,
): Promise<DkbRegistryInstallResult> {
  const libraryRoot = path.resolve(options.libraryRoot);
  await loadLibrary(libraryRoot);
  const installParent = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-layer-install-'));
  const extractedRoot = path.join(installParent, 'package');

  try {
    const materialized = await materializeDkbInstallPlan({
      plan: options.plan,
      layerRoot: options.layerRoot,
      destinationRoot: extractedRoot,
      trustedKeys: options.trustedKeys,
      progress: options.progress,
    });
    await pinRegistryTrustedKeys({ libraryRoot, registryUrl: options.registryUrl, keys: options.trustedKeys, mutationLockHeld });
    const importPackage = mutationLockHeld
      ? importCompiledDkbArtifactIntoLibraryWithinMutation
      : importCompiledDkbArtifactIntoLibrary;
    const imported = await importPackage({
      sourcePath: extractedRoot,
      id: materialized.verification.packageId,
      force: options.force,
      progress: options.progress,
      registryReceipt: materialized.receipt,
      registryUrl: options.registryUrl,
      archiveHash: materialized.installDigest,
    }, libraryRoot);
    const recordCount = imported.validation.graph?.evidence.recordCount ?? 0;
    return {
      status: 'installed',
      packageId: materialized.verification.packageId,
      version: materialized.verification.version,
      libraryRoot,
      packagePath: imported.packagePath,
      verification: materialized.verification,
      catalog: { recordCount, packageCount: 1 },
    };
  } finally {
    await fs.rm(installParent, { recursive: true, force: true }).catch(() => undefined);
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
  const verified = await verifySignedInstallPlan(options.plan, options.trustedKeys);
  const { plan, sourceReceipt } = verified;
  const [source, evidence, retrieval] = plan.artifacts;
  const sourcePath = path.join(options.layerRoot, 'source.dkbpkg');
  const evidencePath = path.join(options.layerRoot, 'evidence.dkbevidence');
  const retrievalPath = path.join(options.layerRoot, 'retrieval.dkbbuild');

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
  const evidenceTarget = evidenceBuildPath(destinationRoot, plan.evidenceProfileDigest, plan.evidenceDigest);
  const retrievalTarget = retrievalBuildPath(destinationRoot, plan.retrievalProfileDigest, plan.retrievalBuildDigest);
  await extractDkbPackageArchive(evidencePath, evidenceTarget, { progress: options.progress });
  await extractDkbPackageArchive(retrievalPath, retrievalTarget, { progress: options.progress });
  await fs.writeFile(path.join(destinationRoot, DKB_PACKAGE_RECEIPT_PATH), `${JSON.stringify(sourceReceipt, null, 2)}\n`, 'utf8');
  const installReceiptPath = path.join(destinationRoot, ...DKB_INSTALL_PLAN_RECEIPT_PATH.split('/'));
  await fs.mkdir(path.dirname(installReceiptPath), { recursive: true });
  await fs.writeFile(installReceiptPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
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
  const graph = await selectStoredPackageBuild({
    root: destinationRoot,
    target: plan.target,
    evidenceProfileDigest: plan.evidenceProfileDigest,
    retrievalProfileDigest: plan.retrievalProfileDigest,
    compatibilityDigest: plan.compatibilityDigest,
  });
  assertBuildGraphMatchesPlan(graph, plan);

  return {
    root: destinationRoot,
    receipt,
    verification,
    installDigest: stableHash({ source: source.digest, evidence: evidence.digest, retrieval: retrieval.digest }),
  };
}

interface AttachSignedBuildChainWithinMutationOptions {
  plan: DkbInstallPlan;
  layerRoot: string;
  packageRoot: string;
  trustedKeys: DkbSigningKeyRecord[];
  libraryRoot?: string;
  registryUrl?: string;
  progress?: DkbProgressReporter;
}

export async function attachSignedBuildChain(options: AttachSignedBuildChainWithinMutationOptions & {
  libraryRoot: string;
}): Promise<Awaited<ReturnType<typeof selectStoredPackageBuild>>> {
  const libraryRoot = path.resolve(options.libraryRoot);
  const packageRoot = path.resolve(options.packageRoot);
  assertPackageWithinLibrary(libraryRoot, packageRoot);
  return withDkbFileLock(libraryRoot, 'library-mutation', () => attachSignedBuildChainWithinMutation({
    ...options,
    packageRoot,
  }));
}

/** Attach an exact signed build chain while the caller owns the Library mutation lock. */
export async function attachSignedBuildChainWithinMutation(
  options: AttachSignedBuildChainWithinMutationOptions,
): Promise<Awaited<ReturnType<typeof selectStoredPackageBuild>>> {
  const verified = await verifySignedInstallPlan(options.plan, options.trustedKeys);
  const plan = verified.plan;
  const packageRoot = path.resolve(options.packageRoot);
  await verifyInstalledSourceForPlan(packageRoot, verified, options.trustedKeys);
  if (options.registryUrl) {
    if (!options.libraryRoot) throw new DkbError('Pinning Registry build trust requires its owning Library root');
    await pinRegistryTrustedKeys({ libraryRoot: options.libraryRoot, registryUrl: options.registryUrl, keys: options.trustedKeys, mutationLockHeld: true });
  }

  const evidenceArchive = path.join(options.layerRoot, 'evidence.dkbevidence');
  const retrievalArchive = path.join(options.layerRoot, 'retrieval.dkbbuild');
  const [, evidence, retrieval] = plan.artifacts;
  const archiveDigests = await Promise.all([
    hashArchiveFile(evidenceArchive, options.progress),
    hashArchiveFile(retrievalArchive, options.progress),
  ]);
  const expectedDigests = [evidence.digest, retrieval.digest];
  const mismatchedArchive = archiveDigests.findIndex((digest, index) => digest !== expectedDigests[index]);
  if (mismatchedArchive >= 0) {
    const kind = plan.artifacts[mismatchedArchive + 1]!.kind;
    throw new DkbError(
      `Registry ${kind} layer hash mismatch: expected ${expectedDigests[mismatchedArchive]}, got ${archiveDigests[mismatchedArchive]}.`,
    );
  }

  const candidateRoot = await fs.mkdtemp(path.join(path.dirname(packageRoot), '.dkb-build-chain-candidate-'));
  try {
    await extractDkbPackageArchive(
      evidenceArchive,
      evidenceBuildPath(candidateRoot, plan.evidenceProfileDigest, plan.evidenceDigest),
      { progress: options.progress },
    );
    await extractDkbPackageArchive(
      retrievalArchive,
      retrievalBuildPath(candidateRoot, plan.retrievalProfileDigest, plan.retrievalBuildDigest),
      { progress: options.progress },
    );
    const candidate = await selectStoredPackageBuild({
      root: candidateRoot,
      target: plan.target,
      evidenceProfileDigest: plan.evidenceProfileDigest,
      retrievalProfileDigest: plan.retrievalProfileDigest,
      compatibilityDigest: plan.compatibilityDigest,
    });
    assertBuildGraphMatchesPlan(candidate, plan);

    return await withDkbFileLock(packageRoot, 'build-promotion', async () => {
      await verifyInstalledSourceForPlan(packageRoot, verified, options.trustedKeys);
      const promoted = await mergeStoredPackageBuildsWithinMutation(candidateRoot, packageRoot);
      const receiptPath = installPlanReceiptPath(packageRoot, stableHash(plan));
      let receiptCreated = false;
      try {
        receiptCreated = await writeImmutableJson(receiptPath, plan, 'Stored install-plan receipt');
        const graph = await selectStoredPackageBuild({
          root: packageRoot,
          target: plan.target,
          evidenceProfileDigest: plan.evidenceProfileDigest,
          retrievalProfileDigest: plan.retrievalProfileDigest,
          compatibilityDigest: plan.compatibilityDigest,
        });
        assertBuildGraphMatchesPlan(graph, plan);
        return graph;
      } catch (error) {
        await Promise.all(promoted.copied.map((target) => fs.rm(target, { recursive: true, force: true })));
        if (receiptCreated) await fs.rm(receiptPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  } finally {
    await fs.rm(candidateRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Verify that a retained Registry build is backed by its exact signed install-plan chain. */
export async function verifyStoredSignedBuildChain(options: {
  packageRoot: string;
  graph: Awaited<ReturnType<typeof selectStoredPackageBuild>>;
  target: string;
  trustedKeys: DkbSigningKeyRecord[];
}): Promise<Awaited<ReturnType<typeof selectStoredPackageBuild>>> {
  const packageRoot = path.resolve(options.packageRoot);
  const primaryReceiptPath = path.join(packageRoot, ...DKB_INSTALL_PLAN_RECEIPT_PATH.split('/'));
  const receiptRoot = path.join(packageRoot, ...DKB_INSTALL_PLAN_RECEIPTS_DIR.split('/'));
  const attachedReceipts = await fs.readdir(receiptRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw error;
  });
  const candidates = [
    primaryReceiptPath,
    ...attachedReceipts
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => path.join(receiptRoot, file)),
  ];
  let lastError: unknown;
  for (const receiptPath of candidates) {
    try {
      const value = JSON.parse(await fs.readFile(receiptPath, 'utf8')) as unknown;
      const verified = await verifySignedInstallPlan(
        validateInstallPlan(value, `Stored Registry install plan at ${receiptPath}`),
        options.trustedKeys,
      );
      await verifyInstalledSourceForPlan(packageRoot, verified, options.trustedKeys);
      assertBuildGraphMatchesPlan(options.graph, verified.plan);
      return options.graph;
    } catch (error) {
      lastError = error;
    }
  }
  throw new DkbError(
    `No exact signed Registry install-plan receipt verifies retained build ${options.graph.retrieval.retrievalBuildDigest}`
    + (lastError instanceof Error ? `: ${lastError.message}` : '.'),
  );
}

/** Revalidate an installed Registry build offline using origin-pinned, last-known trust. */
export async function verifyRetainedRegistryBuild(options: {
  libraryRoot: string;
  registryUrl: string;
  packageRoot: string;
  graph: Awaited<ReturnType<typeof selectStoredPackageBuild>>;
  target: string;
}): Promise<Awaited<ReturnType<typeof selectStoredPackageBuild>>> {
  const graph = await validateStoredPackageBuild(options.packageRoot, options.graph.selection);
  const entry = (await readLibraryState(options.libraryRoot)).entries[graph.evidence.package.id];
  if (!entry || entry.source !== 'registry' || entry.status !== 'installed'
    || entry.version !== graph.evidence.package.version || !entry.registryUrl
    || normalizeRegistryUrl(entry.registryUrl) !== normalizeRegistryUrl(options.registryUrl)
    || path.resolve(options.libraryRoot, entry.path) !== path.resolve(options.packageRoot)) {
    throw new DkbError('Retained Registry build does not match its authoritative Library origin and installed release.', 'registry_build_untrusted');
  }
  try {
    const trustedKeys = await readPinnedRegistryKeys(options.libraryRoot, entry.registryUrl);
    await verifyStoredSignedBuildChain({ ...options, graph, trustedKeys });
    const source = parsePersistedPackageReceipt(JSON.parse(await fs.readFile(path.join(options.packageRoot, DKB_PACKAGE_RECEIPT_PATH), 'utf8')), 'Retained Registry source receipt');
    if (!entry.digest || entry.digest !== source.payload.packageTreeHash) {
      throw new DkbError('Retained Registry source receipt differs from the installed release digest.');
    }
    return graph;
  } catch (error) {
    throw new DkbError(
      `Cannot trust retained ${entry.identity}@${entry.version}: ${error instanceof Error ? error.message : String(error)} `
      + `Recover with: dkb install ${entry.identity} --version ${entry.version} --target ${options.target} --url "${entry.registryUrl}" --library "${path.resolve(options.libraryRoot)}".`,
      error instanceof DkbError && error.code.startsWith('registry_') ? error.code : 'registry_build_untrusted',
    );
  }
}

/** Cold admission checks Registry trust; no request may fetch or bootstrap keys. */
export async function verifyRuntimeRegistryBuilds(libraryRoot: string, activation: DkbRuntimeActivation): Promise<void> {
  const state = await readLibraryState(libraryRoot);
  for (const [id, selection] of Object.entries(activation.packages)) {
    const entry = state.entries[id];
    if (!entry || entry.source !== 'registry') continue;
    if (!entry.registryUrl) throw new DkbError(`Registry DKB ${id} has no pinned origin. Reinstall it from its Registry.`, 'registry_build_untrusted');
    const packageRoot = path.resolve(libraryRoot, entry.path);
    const graph = await validateStoredPackageBuild(packageRoot, selection);
    await verifyRetainedRegistryBuild({ libraryRoot, registryUrl: entry.registryUrl, packageRoot, graph, target: activation.target });
  }
}

/** Authenticate a complete Registry layer plan and bind it to the installed source before downloading children. */
export async function verifySignedInstallPlanForInstalledSource(options: {
  plan: DkbInstallPlan;
  packageRoot: string;
  trustedKeys: DkbSigningKeyRecord[];
}): Promise<DkbInstallPlan> {
  const verified = await verifySignedInstallPlan(options.plan, options.trustedKeys);
  await verifyInstalledSourceForPlan(path.resolve(options.packageRoot), verified, options.trustedKeys);
  return verified.plan;
}

interface VerifiedInstallPlan {
  plan: DkbInstallPlan;
  sourceReceipt: DkbPackageReceipt;
}

async function verifySignedInstallPlan(
  input: DkbInstallPlan,
  trustedKeys: DkbSigningKeyRecord[],
): Promise<VerifiedInstallPlan> {
  const plan = validateInstallPlan(input);
  const resolver = signingKeyResolver(trustedKeys);
  const [source, evidence, retrieval] = plan.artifacts;
  const sourceReceipt = parsePersistedPackageReceipt(source.receipt, 'Install plan source receipt');
  const [sourceVerification, evidenceVerification, retrievalVerification, planVerification] = await Promise.all([
    verifyPackageReceipt(sourceReceipt, resolver),
    verifyLayerReceipt(evidence.receipt, resolver, 'Install plan Evidence receipt'),
    verifyLayerReceipt(retrieval.receipt, resolver, 'Install plan Retrieval receipt'),
    verifyLayerReceipt(plan.receipt, resolver, 'Install plan receipt'),
  ]);
  const planPayload = { ...plan } as Record<string, unknown>;
  delete planPayload.receipt;
  const receiptChecks = [
    sourceVerification.ok,
    evidenceVerification.ok,
    retrievalVerification.ok,
    planVerification.ok,
    sourceReceipt.package.publisherId === sourceReceipt.publisher.accountId,
    sourceReceipt.package.registryId === undefined || sourceReceipt.package.registryId === sourceReceipt.registry.registryId,
    stableHash(sourceReceipt) === source.receiptHash,
    evidenceVerification.receiptHash === evidence.receiptHash,
    retrievalVerification.receiptHash === retrieval.receiptHash,
    evidenceVerification.receipt.type === 'dkb.evidence.receipt',
    retrievalVerification.receipt.type === 'dkb.retrieval.receipt',
    planVerification.receipt.type === 'dkb.install-plan.receipt',
    evidenceVerification.receipt.parentReceiptHash === source.receiptHash,
    retrievalVerification.receipt.parentReceiptHash === evidence.receiptHash,
    evidenceVerification.receipt.payload.sourceReceiptHash === source.receiptHash,
    retrievalVerification.receipt.payload.evidenceReceiptHash === evidence.receiptHash,
    canonicalJson(planVerification.receipt.payload) === canonicalJson(planPayload),
    sourceReceipt.package.id === plan.package.id,
    sourceReceipt.package.version === plan.package.version,
    source.digest === plan.package.sourceDigest,
    evidenceVerification.receipt.package.id === plan.package.id,
    evidenceVerification.receipt.package.version === plan.package.version,
    evidenceVerification.receipt.package.sourceHash === plan.package.sourceDigest,
    retrievalVerification.receipt.package.id === plan.package.id,
    retrievalVerification.receipt.package.version === plan.package.version,
    retrievalVerification.receipt.package.sourceHash === plan.package.sourceDigest,
    planVerification.receipt.package.id === plan.package.id,
    planVerification.receipt.package.version === plan.package.version,
    planVerification.receipt.package.sourceHash === plan.package.sourceDigest,
    evidenceVerification.receipt.publisher.accountId === sourceReceipt.publisher.accountId,
    retrievalVerification.receipt.publisher.accountId === sourceReceipt.publisher.accountId,
    planVerification.receipt.publisher.accountId === sourceReceipt.publisher.accountId,
    evidenceVerification.receipt.registry.registryId === sourceReceipt.registry.registryId,
    retrievalVerification.receipt.registry.registryId === sourceReceipt.registry.registryId,
    planVerification.receipt.registry.registryId === sourceReceipt.registry.registryId,
    evidenceVerification.receipt.payload.evidenceProfileDigest === plan.evidenceProfileDigest,
    evidenceVerification.receipt.payload.evidenceDigest === plan.evidenceDigest,
    retrievalVerification.receipt.payload.target === plan.target,
    retrievalVerification.receipt.payload.evidenceProfileDigest === plan.evidenceProfileDigest,
    retrievalVerification.receipt.payload.evidenceDigest === plan.evidenceDigest,
    retrievalVerification.receipt.payload.retrievalProfileDigest === plan.retrievalProfileDigest,
    retrievalVerification.receipt.payload.retrievalBuildDigest === plan.retrievalBuildDigest,
    retrievalVerification.receipt.payload.compatibilityDigest === plan.compatibilityDigest,
  ];
  if (receiptChecks.some((check) => !check)) {
    throw new DkbError('Registry install plan receipt chain or build identity is invalid');
  }
  requiredSignedPackageTreeHash({ plan, sourceReceipt });
  return { plan, sourceReceipt };
}

function requiredSignedPackageTreeHash(verified: VerifiedInstallPlan): string {
  const packageTreeHash = verified.sourceReceipt.payload.packageTreeHash;
  if (!packageTreeHash) {
    throw new DkbError('Signed Registry source receipt does not bind an immutable package tree.');
  }
  return packageTreeHash;
}

async function verifyInstalledSourceForPlan(
  packageRoot: string,
  verified: VerifiedInstallPlan,
  trustedKeys: DkbSigningKeyRecord[],
): Promise<void> {
  const receiptPath = path.join(packageRoot, DKB_PACKAGE_RECEIPT_PATH);
  const installedReceipt = parsePersistedPackageReceipt(
    JSON.parse(await fs.readFile(receiptPath, 'utf8')) as unknown,
    receiptPath,
  );
  if (!verified.sourceReceipt.payload.packageTreeHash) {
    throw new DkbError('Signed Registry source receipt does not bind an immutable package tree.');
  }
  const [signatureVerification, dkb, sourceTree] = await Promise.all([
    verifyPackageReceipt(installedReceipt, signingKeyResolver(trustedKeys)),
    loadDkbPackage(packageRoot, verified.plan.package.id),
    hashPortablePackageTree(packageRoot),
  ]);
  const exactSource = signatureVerification.ok
    && packageReceiptPayloadMatchesLock(installedReceipt)
    && stableHash(installedReceipt) === verified.plan.artifacts[0].receiptHash
    && stableHash(installedReceipt) === stableHash(verified.sourceReceipt)
    && installedReceipt.package.id === verified.plan.package.id
    && installedReceipt.package.version === verified.plan.package.version
    && dkb.manifest.id === verified.plan.package.id
    && dkb.manifest.version === verified.plan.package.version
    && sourceTree.hash === verified.sourceReceipt.payload.packageTreeHash;
  if (!exactSource) {
    throw new DkbError(
      `Installed Registry source ${verified.plan.package.id}@${verified.plan.package.version} `
      + 'does not match the signed source parent of the requested build chain.',
    );
  }
}

function signingKeyResolver(trustedKeys: DkbSigningKeyRecord[]) {
  return ({ role, signature }: { role: 'publisher' | 'registry'; signature: { keyId: string } }) => {
    const subjectId = role === 'publisher'
      ? (signature as { accountId?: string }).accountId
      : (signature as { registryId?: string }).registryId;
    const key = trustedKeys.find((candidate) => candidate.id === signature.keyId
      && candidate.subjectType === role
      && candidate.subjectId === subjectId);
    return key && (key.status === 'active' || key.status === 'rotated') ? key.publicKeyPem : null;
  };
}

function assertPackageWithinLibrary(libraryRoot: string, packageRoot: string): void {
  const relative = path.relative(libraryRoot, packageRoot);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new DkbError(`Installed package path must be contained by its Library: ${packageRoot}`);
  }
}

function assertBuildGraphMatchesPlan(
  graph: Awaited<ReturnType<typeof selectStoredPackageBuild>>,
  plan: DkbInstallPlan,
): void {
  if (graph.profile.profile.target !== plan.target
    || graph.evidence.package.id !== plan.package.id
    || graph.evidence.package.version !== plan.package.version
    || graph.evidence.package.sourceDigest !== plan.package.sourceDigest
    || graph.evidence.evidenceProfileDigest !== plan.evidenceProfileDigest
    || graph.evidence.evidenceDigest !== plan.evidenceDigest
    || graph.retrieval.package.id !== plan.package.id
    || graph.retrieval.package.version !== plan.package.version
    || graph.retrieval.evidenceProfileDigest !== plan.evidenceProfileDigest
    || graph.retrieval.evidenceDigest !== plan.evidenceDigest
    || graph.retrieval.retrievalProfileDigest !== plan.retrievalProfileDigest
    || graph.retrieval.compatibilityDigest !== plan.compatibilityDigest
    || graph.retrieval.retrievalBuildDigest !== plan.retrievalBuildDigest) {
    throw new DkbError('Downloaded build layers do not match the exact signed Registry install plan.');
  }
}

async function writeImmutableJson(target: string, value: unknown, label: string): Promise<boolean> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.stage-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.link(temporary, target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
      if (stableHash(current) !== stableHash(value)) throw new DkbError(`${label} collision at ${target}`);
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DkbError(`${label} staging collision at ${temporary}`);
    }
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function preflightDkbInstall(options: {
  libraryRoot: string;
  candidate: DkbInstallCandidate;
  registryUrl?: string;
  force?: boolean;
}): Promise<DkbAlreadyInstalledResult | null> {
  const libraryRoot = path.resolve(options.libraryRoot);
  await loadLibrary(libraryRoot);
  const installedRoots = await installedPackageRoots(libraryRoot, options.candidate.packageId);
  if (installedRoots.length === 0) return null;

  const installedRoot = installedRoots[0]!;
  let installedDkb: LoadedDkb;
  try {
    installedDkb = await loadDkbPackage(installedRoot, options.candidate.packageId);
  } catch (error) {
    if (options.force) return null;
    throw new DkbError(
      `Library contains an unreadable installation of ${options.candidate.packageId} at ${installedRoot}: `
      + `${error instanceof Error ? error.message : String(error)}. Use --force to repair it.`,
    );
  }

  const installedVersion = installedDkb.manifest.version;
  const lockEntry = (await readLibraryState(libraryRoot)).entries[options.candidate.packageId];
  if (!lockEntry) {
    if (options.force) return null;
    throw new DkbError(
      `Library contains an incomplete installation of ${options.candidate.packageId}@${installedVersion} at ${installedRoot}. `
      + 'Use --force to repair it.',
    );
  }

  if (options.registryUrl && lockEntry.source === 'registry' && lockEntry.registryUrl
    && normalizeRegistryUrl(lockEntry.registryUrl) !== normalizeRegistryUrl(options.registryUrl)) {
    const incomingDigest = options.candidate.packageTreeHash ?? options.candidate.archiveHash;
    if (!incomingDigest || !lockEntry.digest || incomingDigest !== lockEntry.digest) {
      throw new DkbError(
        `Registry origin conflict for ${options.candidate.packageId}: the installed release came from ${lockEntry.registryUrl}, `
        + `but the requested signed release came from ${normalizeRegistryUrl(options.registryUrl)} with a different digest. `
        + `Uninstall ${options.candidate.packageId} before changing its Registry origin.`,
      );
    }
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
        libraryRoot,
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
  registryUrl: string;
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
      registryUrl: options.registryUrl,
      archiveHash,
    }, runtime.stateRoot);

    return {
      status: 'installed',
      packageId: verification.packageId,
      version: verification.version,
      libraryRoot: imported.libraryPath,
      packagePath: imported.packagePath,
      verification,
      catalog: imported.catalog,
      ...(imported.warning ? { warning: imported.warning } : {}),
    };
  } finally {
    await fs.rm(installParent, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installDkbArchiveIntoLibrary(options: {
  archivePath: string;
  libraryRoot: string;
  trustedKeys: DkbSigningKeyRecord[];
  registryUrl: string;
  expectedArchiveHash?: string;
  force?: boolean;
  progress?: DkbProgressReporter;
}): Promise<DkbRegistryInstallResult> {
  const libraryRoot = path.resolve(options.libraryRoot);
  await loadLibrary(libraryRoot);
  const installParent = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-install-'));
  const extractedRoot = path.join(installParent, 'package');

  try {
    const archiveHash = await hashArchiveFile(options.archivePath, options.progress);
    if (options.expectedArchiveHash && archiveHash !== options.expectedArchiveHash) {
      throw new DkbError(`Package archive hash mismatch: expected ${options.expectedArchiveHash}, got ${archiveHash}.`);
    }
    await extractDkbPackageArchive(options.archivePath, extractedRoot, { progress: options.progress });
    const { receipt, verification } = await verifyExtractedPackage(extractedRoot, options.trustedKeys, options.progress);
    if (!verification.ok) throw new DkbError(`Registry package verification failed: ${verification.packageId}@${verification.version}`);
    const imported = await importCompiledDkbArtifactIntoLibrary({
      sourcePath: extractedRoot,
      id: verification.packageId,
      force: options.force,
      progress: options.progress,
      registryReceipt: receipt,
      registryUrl: options.registryUrl,
      archiveHash,
    }, libraryRoot);
    return {
      status: 'installed',
      packageId: verification.packageId,
      version: verification.version,
      libraryRoot,
      packagePath: imported.packagePath,
      verification,
      catalog: {
        recordCount: imported.validation.graph?.evidence.recordCount ?? 0,
        packageCount: 1,
      },
    };
  } finally {
    await fs.rm(installParent, { recursive: true, force: true }).catch(() => undefined);
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
    await fs.rm(verifyParent, { recursive: true, force: true }).catch(() => undefined);
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
  const receiptValue = JSON.parse(await fs.readFile(receiptPath, 'utf8')) as unknown;
  const receipt = options.verifyReceiptArtifacts === false
    ? parsePersistedPackageReceipt(receiptValue, receiptPath)
    : parsePackageReceipt(receiptValue, receiptPath);
  const packageId = receipt.package.id;
  const version = receipt.package.version;
  const payloadMatchesLock = packageReceiptPayloadMatchesLock(receipt);
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
  const signatures = await verifyPackageReceipt(receipt, signingKeyResolver(trustedKeys));
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
