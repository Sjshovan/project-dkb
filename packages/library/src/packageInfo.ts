import { registryCollectionDigest } from '@sjshovan/dkb-protocol/registryCollections.js';
import fs from 'node:fs/promises';
import { allLibraryReads, withLibraryReadFence } from './readFence.js';
import path from 'node:path';
import {
  validateEvidenceBuildLock,
  validateInstallPlan,
  validateRetrievalBuildLock,
} from '@sjshovan/dkb-protocol/builds.js';
import {
  DKB_ARTIFACT_MANIFEST_FILENAME,
  validateArtifactManifest,
} from '@sjshovan/dkb-protocol/artifacts.js';
import { canonicalJson, stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_EVIDENCE_CATALOG_FILENAME } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import {
  DKB_INSTALLED_ENTRY_DETAIL_FORMAT,
  DKB_PACKAGE_CONTENTS_FORMAT,
  DKB_PACKAGE_PREVIEW_FORMAT,
  DKB_PACKAGE_VERIFICATION_FORMAT,
  type DkbInspectionCheck,
  type DkbInspectionStatus,
  type DkbInstalledBuildSummary,
  type DkbInstalledEntryDetail,
  type DkbPackageContents,
  type DkbPackagePreview,
  type DkbPackageVerification,
  type DkbReceiptSignerSummary,
} from '@sjshovan/dkb-protocol/packageInspection.js';
import { resolveContainedPath } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbSigningKeyRecord, DkbSourceManifest } from '@sjshovan/dkb-protocol/types.js';
import {
  DKB_EVIDENCE_BUILD_LOCK,
  DKB_EVIDENCE_BUILD_IR,
  DKB_RETRIEVAL_BUILD_ARTIFACTS,
  DKB_RETRIEVAL_BUILD_LOCK,
  DKB_RETRIEVAL_BUILD_PROFILE_LOCK,
  listPackageBuilds,
  readRetrievalBuildProfile,
  validateStoredPackageBuild,
  verifyKnowledgeBuilds,
} from './builds.js';
import { readEvidenceCatalog } from './evidenceCatalog.js';
import {
  DKB_INSTALL_PLAN_RECEIPT_PATH,
  DKB_INSTALL_PLAN_RECEIPTS_DIR,
  DKB_PACKAGE_RECEIPT_PATH,
  parsePersistedPackageReceipt,
  verifyLayerReceipt,
  verifyPackageReceipt,
} from './signing.js';
import {
  hashPortablePackageTree,
  listPortablePackageDirectory,
  previewPortablePackageFile,
  summarizePortablePackageTree,
} from './packageTree.js';
import { readLibraryState, type DkbLibraryStateEntry } from './state.js';

export { inspectInstalledEvidence } from './packageEvidence.js';

async function inspectInstalledPackageSnapshot(
  libraryRoot: string,
  identity: string,
): Promise<DkbInstalledEntryDetail> {
  const context = await installedEntryContext(libraryRoot, identity);
  const { root, entry, packageRoot } = context;
  const manifest = await loadManifest(packageRoot).catch(() => null);
  const checks: DkbInspectionCheck[] = [{
    id: 'library.ledger',
    label: 'Library ledger',
    status: entry.status === 'installed' ? 'passed' : 'failed',
    message: entry.status === 'installed'
      ? 'The applied-state ledger points to an installed entry.'
      : 'The Library ledger entry exists, but its package files are missing.',
    ...(entry.status === 'broken' ? { recovery: reinstallCommand(root, entry) } : {}),
  }, {
    id: 'package.manifest',
    label: 'Package manifest',
    status: manifest ? 'passed' : 'failed',
    message: manifest ? `Loaded ${manifest.type} manifest ${manifest.name}.` : 'dkb.json is missing or invalid.',
    ...(!manifest ? { recovery: reinstallCommand(root, entry) } : {}),
  }];
  const sourceSummary = await summarizePortablePackageTree(packageRoot).catch(() => ({ files: 0, bytes: 0 }));
  const buildResult = entry.kind === 'dkb'
    ? await inspectDkbBuilds(packageRoot, root, entry)
    : { builds: [] as DkbInstalledBuildSummary[], catalog: null, graph: null, profile: null, check: notApplicableBuildCheck() };
  checks.push(buildResult.check);
  const receiptResult = entry.kind === 'dkb'
    ? await inspectReceipt(root, packageRoot, entry)
    : collectionReceiptStatus();
  checks.push(receiptResult.check, receiptResult.installChainCheck);
  const members = manifest?.type === 'collection'
    ? collectionMembers(manifest, entry.identity, await readLibraryState(root))
    : [];
  if (members.some((member) => member.status === 'missing' || member.status === 'broken')) {
    checks.push({
      id: 'collection.members',
      label: 'Collection members',
      status: 'failed',
      message: 'One or more Collection members are missing or broken.',
      recovery: reinstallCommand(root, entry),
    });
  } else if (manifest?.type === 'collection') {
    checks.push({
      id: 'collection.members',
      label: 'Collection members',
      status: 'passed',
      message: `${members.length} resolved member${members.length === 1 ? '' : 's'} are present.`,
    });
  }
  const recovery = unique(checks.map((check) => check.recovery).filter((value): value is string => Boolean(value)));
  return {
    format: DKB_INSTALLED_ENTRY_DETAIL_FORMAT,
    libraryRoot: root,
    identity: entry.identity,
    kind: entry.kind,
    source: entry.source,
    status: entry.status,
    path: packageRoot,
    ...(entry.version ? { version: entry.version } : {}),
    ...(entry.revision ? { revision: entry.revision } : {}),
    ...(entry.digest ? { digest: entry.digest } : {}),
    ...(entry.registryUrl ? { registryUrl: entry.registryUrl } : {}),
    installedAt: entry.installedAt,
    requiredBy: [...entry.requiredBy],
    manifest: manifestSummary(manifest),
    sourceSummary: {
      ...sourceSummary,
      searchableSources: buildResult.catalog?.assets.length ?? 0,
      evidenceRecords: buildResult.catalog?.records.length ?? 0,
    },
    builds: buildResult.builds,
    provenance: {
      ...(receiptResult.receipt?.payload.packageTreeHash ? { packageTreeHash: receiptResult.receipt.payload.packageTreeHash } : {}),
      ...(receiptResult.receipt?.payloadHash ? { payloadHash: receiptResult.receipt.payloadHash } : {}),
      ...(buildResult.graph?.evidence.package.sourceDigest ? { sourceDigest: buildResult.graph.evidence.package.sourceDigest } : {}),
      ...(receiptResult.receipt ? { publisher: publisherSummary(receiptResult.receipt.publisher), registry: registrySummary(receiptResult.receipt.registry) } : {}),
      receiptStatus: receiptResult.status,
      installChainStatus: receiptResult.installChainStatus,
    },
    members,
    integrity: { status: inspectionStatus(checks), checks, recovery },
  };
}

async function listInstalledPackageContentsSnapshot(input: {
  libraryRoot: string;
  identity: string;
  directory?: string;
  cursor?: string;
  limit?: number;
}): Promise<DkbPackageContents> {
  const { root, entry, packageRoot } = await installedEntryContext(input.libraryRoot, input.identity);
  const listing = await listPortablePackageDirectory({ root: packageRoot, directory: input.directory, cursor: input.cursor, limit: input.limit });
  const evidence = entry.kind === 'dkb' ? await activeEvidenceMap(packageRoot) : new Map<string, EvidenceFileSummary>();

  return {
    format: DKB_PACKAGE_CONTENTS_FORMAT,
    libraryRoot: root,
    identity: entry.identity,
    directory: listing.directory,
    entries: listing.entries.map((item) => {
      const source = item.kind === 'file' ? evidence.get(normalizeSourcePath(item.path)) : undefined;
      return {
        ...item,
        searchable: Boolean(source),
        ...(source?.sourceId ? { sourceId: source.sourceId } : {}),
        ...(source?.sourceHash ? { sourceHash: source.sourceHash } : {}),
        evidenceRecords: source?.records ?? 0,
      };
    }),
    ...(listing.nextCursor ? { nextCursor: listing.nextCursor } : {}),
  };
}

async function previewInstalledPackageFileSnapshot(input: {
  libraryRoot: string;
  identity: string;
  file: string;
}): Promise<DkbPackagePreview> {
  const { root, entry, packageRoot } = await installedEntryContext(input.libraryRoot, input.identity);
  const preview = await previewPortablePackageFile({ root: packageRoot, file: input.file });
  const evidence = entry.kind === 'dkb' ? await activeEvidenceMap(packageRoot) : new Map<string, EvidenceFileSummary>();
  const source = evidence.get(normalizeSourcePath(preview.path));

  return {
    format: DKB_PACKAGE_PREVIEW_FORMAT,
    libraryRoot: root,
    identity: entry.identity,
    ...preview,
    ...(source?.sourceId ? { sourceId: source.sourceId } : {}),
    ...(source?.sourceHash ? { sourceHash: source.sourceHash } : {}),
    evidenceRecords: source?.records ?? 0,
  };
}

async function verifyInstalledPackageSnapshot(input: {
  libraryRoot: string;
  identity: string;
  trustedKeys?: DkbSigningKeyRecord[];
  keyWarning?: string;
}): Promise<DkbPackageVerification> {
  const { root, entry, packageRoot } = await installedEntryContext(input.libraryRoot, input.identity);
  const checks: DkbInspectionCheck[] = [];
  let receipt: ReturnType<typeof parsePersistedPackageReceipt> | null = null;

  let manifest: DkbSourceManifest | null = null;
  try {
    manifest = await loadManifest(packageRoot);
    checks.push(check('package.manifest', 'Package manifest', 'passed', `${manifest.name} matches an installed ${manifest.type}.`));
  } catch (error) {
    checks.push(check('package.manifest', 'Package manifest', 'failed', errorMessage(error), reinstallCommand(root, entry)));
  }

  if (entry.kind === 'dkb') {
    try {
      const verification = await verifyKnowledgeBuilds(packageRoot);
      if (!verification.ok) {
        throw new DkbError(verification.checks.filter((item) => !item.ok).map((item) => item.detail).join('; '));
      }
      checks.push(check(
        'build.graph',
        'Stored build graph',
        'passed',
        `${verification.checks.length} immutable Retrieval Build${verification.checks.length === 1 ? '' : 's'} verified.`,
      ));
    } catch (error) {
      checks.push(check('build.graph', 'Stored build graph', 'failed', errorMessage(error), rebuildOrReinstallCommand(root, packageRoot, entry)));
    }
  } else {
    checks.push(check('build.graph', 'Stored build graph', 'not_applicable', 'Collections resolve member DKB builds and do not own retrieval artifacts.'));
    checks.push(await verifyCollectionSnapshot(root, entry, manifest));
  }

  if (entry.kind === 'collection') {
    checks.push(check(
      'package.receipt', 'Package receipt', 'not_applicable',
      'Collections are verified as immutable revision snapshots; signed DKB source/build receipts belong to their member packages.',
    ));
  } else if (entry.source === 'registry') {
    try {
      const receiptPath = path.join(packageRoot, DKB_PACKAGE_RECEIPT_PATH);
      receipt = parsePersistedPackageReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')), receiptPath);
      const tree = await hashPortablePackageTree(packageRoot);
      const treeMatches = Boolean(receipt.payload.packageTreeHash) && receipt.payload.packageTreeHash === tree.hash;
      checks.push(check(
        'package.tree', 'Portable package tree', treeMatches ? 'passed' : 'failed',
        treeMatches
          ? `${tree.files.length} files match ${tree.hash}.`
          : receipt.payload.packageTreeHash
            ? `Expected ${receipt.payload.packageTreeHash}, got ${tree.hash}.`
            : 'Signed Registry source receipt does not bind an immutable package tree.',
        treeMatches ? undefined : reinstallCommand(root, entry),
      ));
    } catch (error) {
      checks.push(check('package.receipt', 'Package receipt', 'failed', errorMessage(error), reinstallCommand(root, entry)));
    }
  } else {
    checks.push(check('package.receipt', 'Package receipt', 'not_applicable', 'Editable local knowledge is not a signed Registry release.'));
  }

  if (receipt && input.trustedKeys?.length) {
    const resolver = trustedKeyResolver(input.trustedKeys);
    const source = await verifyPackageReceipt(receipt, resolver);
    for (const item of source.checks) {
      checks.push(check(`signature.source.${item.name}`, `Source receipt: ${humanLabel(item.name)}`, item.ok ? 'passed' : 'failed', item.detail, item.ok ? undefined : reinstallCommand(root, entry)));
    }
    await verifyStoredInstallChain(packageRoot, receipt, resolver, checks, entry, root);
  } else if (receipt) {
    checks.push(check(
      'signature.keys', 'Registry signing keys', 'warning',
      input.keyWarning ?? 'Signing keys were not available, so recorded signatures were not rechecked.',
      entry.registryUrl ? `dkb registry status --url "${entry.registryUrl}"` : undefined,
    ));
  }

  const recovery = unique(checks.map((item) => item.recovery).filter((value): value is string => Boolean(value)));
  const status = checks.some((item) => item.status === 'failed')
    ? 'failed'
    : checks.some((item) => item.status === 'warning') ? 'warnings' : 'passed';
  return { format: DKB_PACKAGE_VERIFICATION_FORMAT, libraryRoot: root, identity: entry.identity, status, checkedAt: new Date().toISOString(), checks, recovery };
}

async function installedEntryContext(libraryRoot: string, identity: string) {
  const root = path.resolve(libraryRoot);
  const normalizedIdentity = parseDkbIdentity(identity, 'Installed package identity').identity;
  const state = await readLibraryState(root);
  const entry = state.entries[normalizedIdentity];
  if (!entry) throw new DkbError(`${normalizedIdentity} is not installed in ${root}. Run dkb list to see installed knowledge or dkb install ${normalizedIdentity}.`);
  return { root, entry, packageRoot: resolveContainedPath(root, entry.path, `Installed entry ${normalizedIdentity} path`) };
}

async function inspectDkbBuilds(
  packageRoot: string,
  libraryRoot: string,
  entry: DkbLibraryStateEntry,
) {
  try {
    const [verification, listed] = await allLibraryReads([verifyKnowledgeBuilds(packageRoot), listPackageBuilds(packageRoot)]);
    if (!verification.ok) {
      throw new DkbError(verification.checks.filter((item) => !item.ok).map((item) => item.detail).join('; '));
    }
    const graph = await representativeStoredPackageGraph(packageRoot, listed);
    const catalog = readEvidenceCatalog(graph.evidencePath);
    const builds: DkbInstalledBuildSummary[] = [];
    const retrievalDetails = await allLibraryReads(listed.retrieval.map(async (item) => {
      const lockPath = path.join(item.path, DKB_RETRIEVAL_BUILD_LOCK);
      const manifestPath = path.join(item.path, DKB_ARTIFACT_MANIFEST_FILENAME);
      const [lock, profile, manifest, bytes] = await allLibraryReads([
        fs.readFile(lockPath, 'utf8').then((value) => validateRetrievalBuildLock(JSON.parse(value), lockPath)),
        readRetrievalBuildProfile(item.path),
        fs.readFile(manifestPath, 'utf8').then((value) => validateArtifactManifest(JSON.parse(value), manifestPath)),
        directoryBytes(item.path),
      ]);
      return { item, lock, profile, manifest, bytes };
    }));
    const evidenceProfiles = new Map(retrievalDetails.map(({ profile }) => [profile.profile.evidence.profileDigest, profile.profile.evidence]));
    for (const item of listed.evidence) {
      const lockPath = path.join(item.path, DKB_EVIDENCE_BUILD_LOCK);
      const lock = validateEvidenceBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
      const evidenceProfile = evidenceProfiles.get(item.profileDigest);
      builds.push({
        kind: 'evidence', profileDigest: item.profileDigest, buildDigest: item.evidenceDigest,
        bytes: await directoryBytes(item.path), generatedAt: lock.generatedAt, recordCount: lock.recordCount, chunkCount: lock.chunkCount,
        providers: evidenceProfile?.providers.map(({ id, version, kind }) => ({ id, version, kind })) ?? [],
        processors: evidenceProfile?.processors.map(({ id, version, stage }) => ({ id, version, stage })) ?? [],
        files: await allLibraryReads([
          installedBuildFile(item.path, DKB_EVIDENCE_BUILD_IR, 'evidence_ir'),
          installedBuildFile(item.path, DKB_EVIDENCE_CATALOG_FILENAME, 'evidence_catalog'),
          installedBuildFile(item.path, DKB_EVIDENCE_BUILD_LOCK, 'build_lock'),
        ]),
      });
    }
    for (const { item, lock, profile, manifest, bytes } of retrievalDetails) {
      builds.push({
        kind: 'retrieval', profileDigest: item.profileDigest, buildDigest: item.buildDigest,
        bytes, generatedAt: lock.generatedAt, compatibilityDigest: lock.compatibilityDigest,
        evidenceDigest: lock.evidenceDigest,
        target: profile.profile.target,
        providers: profile.profile.retrieval.providers.map(({ id, version, kind }) => ({ id, version, kind })),
        processors: [],
        ...(profile.profile.embedding ? { embedding: {
          provider: profile.profile.embedding.provider,
          space: profile.profile.embedding.space,
          ...(profile.profile.embedding.modelRevision ? { modelRevision: profile.profile.embedding.modelRevision } : {}),
          dimensions: profile.profile.embedding.dimensions,
          metric: profile.profile.embedding.metric,
          normalized: profile.profile.embedding.normalized,
          queryMode: profile.profile.embedding.queryMode,
          documentMode: profile.profile.embedding.documentMode,
        } } : {}),
        index: { ...profile.profile.index },
        retrieval: {
          provider: profile.profile.retrieval.provider,
          protocol: profile.profile.retrieval.protocol,
        },
        files: [
          await installedBuildFile(item.path, DKB_RETRIEVAL_BUILD_LOCK, 'build_lock'),
          await installedBuildFile(item.path, DKB_RETRIEVAL_BUILD_PROFILE_LOCK, 'profile_lock'),
          await installedBuildFile(item.path, DKB_ARTIFACT_MANIFEST_FILENAME, 'artifact_manifest'),
          ...manifest.files.map((file) => ({
            path: path.posix.join(DKB_RETRIEVAL_BUILD_ARTIFACTS, file.path),
            bytes: file.size,
            role: 'retrieval_artifact' as const,
            hash: file.hash,
          })),
        ],
      });
    }
    const profile = await readRetrievalBuildProfile(graph.retrievalPath);
    return {
      builds, catalog, graph, profile,
      check: check('build.graph', 'Stored build graph', 'passed', `${catalog.assets.length} sources and ${catalog.records.length} Evidence records are stored in ${graph.retrieval.compatibilityDigest}.`),
    };
  } catch (error) {
    return {
      builds: [] as DkbInstalledBuildSummary[], catalog: null, graph: null, profile: null,
      check: check('build.graph', 'Stored build graph', 'failed', errorMessage(error), rebuildOrReinstallCommand(libraryRoot, packageRoot, entry)),
    };
  }
}

async function installedBuildFile(
  buildRoot: string,
  relativePath: string,
  role: DkbInstalledBuildSummary['files'][number]['role'],
): Promise<DkbInstalledBuildSummary['files'][number]> {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  const target = resolveContainedPath(buildRoot, normalizedPath, 'Stored build file');
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new DkbError(`Stored build file is not a regular file: ${normalizedPath}`);
  return { path: normalizedPath, bytes: stat.size, role };
}

async function inspectReceipt(libraryRoot: string, packageRoot: string, entry: DkbLibraryStateEntry) {
  if (entry.source !== 'registry') {
    return {
      receipt: null, status: 'not_applicable' as const, installChainStatus: 'not_applicable' as const,
      check: check('package.receipt', 'Package receipt', 'not_applicable', 'Editable local knowledge is not a signed Registry release.'),
      installChainCheck: check('install.receipts', 'Installed build receipts', 'not_applicable', 'Editable local knowledge uses locally compiled builds.'),
    };
  }
  let receipt: ReturnType<typeof parsePersistedPackageReceipt> | null = null;
  let status: 'present' | 'missing' | 'invalid' = 'missing';
  let receiptMessage = 'The signed package receipt is missing.';
  try {
    const receiptPath = path.join(packageRoot, DKB_PACKAGE_RECEIPT_PATH);
    receipt = parsePersistedPackageReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')), receiptPath);
    status = 'present';
    receiptMessage = `Signed source receipt ${receipt.payloadHash} is present.`;
  } catch (error) {
    status = missingFileError(error) ? 'missing' : 'invalid';
    receiptMessage = errorMessage(error);
  }
  let installChainStatus: 'present' | 'missing' | 'invalid' = 'missing';
  let chainMessage = 'This install predates persisted build receipt chains; reinstall to record its exact signed install plan.';
  try {
    const planPath = path.join(packageRoot, ...DKB_INSTALL_PLAN_RECEIPT_PATH.split('/'));
    validateInstallPlan(JSON.parse(await fs.readFile(planPath, 'utf8')), planPath);
    installChainStatus = 'present';
    chainMessage = 'The signed source, Evidence, Retrieval, and install-plan receipts are present.';
  } catch (error) {
    installChainStatus = missingFileError(error) ? 'missing' : 'invalid';
    if (installChainStatus === 'invalid') chainMessage = errorMessage(error);
  }
  return {
    receipt, status, installChainStatus,
    check: check('package.receipt', 'Package receipt', status === 'present' ? 'passed' : 'failed', receiptMessage, status === 'present' ? undefined : reinstallCommand(libraryRoot, entry)),
    installChainCheck: check('install.receipts', 'Installed build receipts', installChainStatus === 'present' ? 'passed' : 'warning', chainMessage, installChainStatus === 'present' ? undefined : reinstallCommand(libraryRoot, entry)),
  };
}

function collectionReceiptStatus() {
  return {
    receipt: null,
    status: 'not_applicable' as const,
    installChainStatus: 'not_applicable' as const,
    check: check(
      'package.receipt', 'Package receipt', 'not_applicable',
      'Collections are immutable revision snapshots; their member DKBs own signed source and build receipts.',
    ),
    installChainCheck: check(
      'install.receipts', 'Installed build receipts', 'not_applicable',
      'Collection members are verified through their own exact install receipt chains.',
    ),
  };
}

async function verifyCollectionSnapshot(
  libraryRoot: string,
  entry: DkbLibraryStateEntry,
  manifest: DkbSourceManifest | null,
): Promise<DkbInspectionCheck> {
  const recovery = reinstallCommand(libraryRoot, entry);
  if (!manifest || manifest.type !== 'collection') {
    return check('collection.snapshot', 'Collection snapshot', 'failed', 'The installed Collection manifest is missing or invalid.', recovery);
  }
  const revision = manifest.meta?.revision;
  const recordedDigest = manifest.meta?.digest;
  if (!Number.isInteger(revision) || typeof recordedDigest !== 'string' || !manifest.members) {
    return check('collection.snapshot', 'Collection snapshot', 'failed', 'The Collection revision, digest, or member snapshot is invalid.', recovery);
  }
  const state = await readLibraryState(libraryRoot);
  const members = [] as Array<{ id: string; version: string; digest: string }>;
  for (const [identity, selector] of Object.entries(manifest.members)) {
    const member = state.entries[identity];
    if (!member || member.kind !== 'dkb' || member.status !== 'installed'
      || member.version !== selector || typeof member.digest !== 'string') {
      return check(
        'collection.snapshot', 'Collection snapshot', 'failed',
        `${identity}@${String(selector)} does not match an installed member with its immutable release digest.`,
        recovery,
      );
    }
    members.push({ id: identity, version: member.version, digest: member.digest });
  }
  const snapshot = {
    type: 'collection' as const,
    id: entry.identity,
    name: manifest.displayName ?? manifest.name,
    revision: revision as number,
    members,
  };
  const computedDigest = registryCollectionDigest(snapshot);
  const valid = computedDigest === recordedDigest
    && recordedDigest === entry.digest
    && revision === entry.revision;
  return check(
    'collection.snapshot', 'Collection snapshot', valid ? 'passed' : 'failed',
    valid
      ? `Revision r${revision} and ${members.length} exact member release${members.length === 1 ? '' : 's'} match ${computedDigest}.`
      : `Collection snapshot digest mismatch: expected ${String(entry.digest)}, recorded ${recordedDigest}, computed ${computedDigest}.`,
    valid ? undefined : recovery,
  );
}

async function activeEvidenceMap(packageRoot: string): Promise<Map<string, EvidenceFileSummary>> {
  try {
    const listed = await listPackageBuilds(packageRoot);
    const graph = await representativeStoredPackageGraph(packageRoot, listed);
    const catalog = readEvidenceCatalog(graph.evidencePath);
    const records = new Map<string, number>();
    for (const record of catalog.records) records.set(record.assetId, (records.get(record.assetId) ?? 0) + 1);
    return new Map(catalog.assets.flatMap((asset) => {
      const sourcePath = sourcePathFor(asset.locator, asset.id);
      return sourcePath ? [[normalizeSourcePath(sourcePath), { sourceId: asset.id, sourceHash: asset.sourceHash, records: records.get(asset.id) ?? 0 }]] : [];
    }));
  } catch {
    return new Map();
  }
}

async function verifyStoredInstallChain(
  packageRoot: string,
  sourceReceipt: ReturnType<typeof parsePersistedPackageReceipt>,
  resolver: Parameters<typeof verifyPackageReceipt>[1],
  checks: DkbInspectionCheck[],
  entry: DkbLibraryStateEntry,
  libraryRoot: string,
): Promise<void> {
  try {
    const planPath = path.join(packageRoot, ...DKB_INSTALL_PLAN_RECEIPT_PATH.split('/'));
    const plan = validateInstallPlan(JSON.parse(await fs.readFile(planPath, 'utf8')), planPath);
    const [source, evidence, retrieval] = plan.artifacts;
    const evidenceResult = await verifyLayerReceipt(evidence.receipt, resolver, 'Stored Evidence receipt');
    const retrievalResult = await verifyLayerReceipt(retrieval.receipt, resolver, 'Stored Retrieval receipt');
    const planResult = await verifyLayerReceipt(plan.receipt, resolver, 'Stored install-plan receipt');
    const planPayload = { ...plan } as Record<string, unknown>;
    delete planPayload.receipt;
    const graph = await validateStoredPackageBuild(packageRoot, {
      version: plan.package.version,
      evidenceProfileDigest: plan.evidenceProfileDigest,
      evidenceDigest: plan.evidenceDigest,
      retrievalProfileDigest: plan.retrievalProfileDigest,
      retrievalBuildDigest: plan.retrievalBuildDigest,
    });
    const identities = [
      stableHash(sourceReceipt) === source.receiptHash,
      stableHash(source.receipt) === source.receiptHash,
      evidenceResult.receiptHash === evidence.receiptHash,
      retrievalResult.receiptHash === retrieval.receiptHash,
      evidenceResult.receipt.type === 'dkb.evidence.receipt',
      retrievalResult.receipt.type === 'dkb.retrieval.receipt',
      planResult.receipt.type === 'dkb.install-plan.receipt',
      evidenceResult.receipt.parentReceiptHash === source.receiptHash,
      retrievalResult.receipt.parentReceiptHash === evidence.receiptHash,
      evidenceResult.receipt.payload.sourceReceiptHash === source.receiptHash,
      retrievalResult.receipt.payload.evidenceReceiptHash === evidence.receiptHash,
      canonicalJson(planResult.receipt.payload) === canonicalJson(planPayload),
      plan.package.id === entry.identity,
      plan.package.version === entry.version,
      sourceReceipt.package.id === plan.package.id,
      sourceReceipt.package.version === plan.package.version,
      sourceReceipt.package.publisherId === sourceReceipt.publisher.accountId,
      sourceReceipt.package.registryId === undefined || sourceReceipt.package.registryId === sourceReceipt.registry.registryId,
      Boolean(sourceReceipt.payload.packageTreeHash),
      source.digest === plan.package.sourceDigest,
      evidenceResult.receipt.package.id === plan.package.id,
      evidenceResult.receipt.package.version === plan.package.version,
      evidenceResult.receipt.package.sourceHash === plan.package.sourceDigest,
      retrievalResult.receipt.package.id === plan.package.id,
      retrievalResult.receipt.package.version === plan.package.version,
      retrievalResult.receipt.package.sourceHash === plan.package.sourceDigest,
      planResult.receipt.package.id === plan.package.id,
      planResult.receipt.package.version === plan.package.version,
      planResult.receipt.package.sourceHash === plan.package.sourceDigest,
      evidenceResult.receipt.publisher.accountId === sourceReceipt.publisher.accountId,
      retrievalResult.receipt.publisher.accountId === sourceReceipt.publisher.accountId,
      planResult.receipt.publisher.accountId === sourceReceipt.publisher.accountId,
      evidenceResult.receipt.registry.registryId === sourceReceipt.registry.registryId,
      retrievalResult.receipt.registry.registryId === sourceReceipt.registry.registryId,
      planResult.receipt.registry.registryId === sourceReceipt.registry.registryId,
      evidenceResult.receipt.payload.evidenceProfileDigest === plan.evidenceProfileDigest,
      evidenceResult.receipt.payload.evidenceDigest === plan.evidenceDigest,
      retrievalResult.receipt.payload.target === plan.target,
      retrievalResult.receipt.payload.evidenceProfileDigest === plan.evidenceProfileDigest,
      retrievalResult.receipt.payload.evidenceDigest === plan.evidenceDigest,
      retrievalResult.receipt.payload.retrievalProfileDigest === plan.retrievalProfileDigest,
      retrievalResult.receipt.payload.compatibilityDigest === plan.compatibilityDigest,
      retrievalResult.receipt.payload.retrievalBuildDigest === plan.retrievalBuildDigest,
      graph.evidence.package.sourceDigest === plan.package.sourceDigest,
      plan.evidenceDigest === graph.evidence.evidenceDigest,
      plan.retrievalBuildDigest === graph.retrieval.retrievalBuildDigest,
      plan.compatibilityDigest === graph.retrieval.compatibilityDigest,
    ];
    const ok = identities.every(Boolean) && evidenceResult.ok && retrievalResult.ok && planResult.ok;
    checks.push(check(
      'install.receipt-chain', 'Installed receipt chain', ok ? 'passed' : 'failed',
      ok ? 'Source, Evidence, Retrieval, and install-plan receipts verify against the exact installed build graph.' : 'The stored install receipt chain does not match the exact installed build graph.',
      ok ? undefined : reinstallCommand(libraryRoot, entry),
    ));
    await verifyAttachedInstallPlanReceipts(packageRoot, plan, sourceReceipt, resolver, checks, entry, libraryRoot);
    await verifyAttachedRetrievalReceipts(packageRoot, plan, resolver, checks, entry, libraryRoot);
  } catch (error) {
    checks.push(check('install.receipt-chain', 'Installed receipt chain', missingFileError(error) ? 'warning' : 'failed', errorMessage(error), reinstallCommand(libraryRoot, entry)));
  }
}

async function verifyAttachedInstallPlanReceipts(
  packageRoot: string,
  installedPlan: ReturnType<typeof validateInstallPlan>,
  sourceReceipt: ReturnType<typeof parsePersistedPackageReceipt>,
  resolver: Parameters<typeof verifyPackageReceipt>[1],
  checks: DkbInspectionCheck[],
  entry: DkbLibraryStateEntry,
  libraryRoot: string,
): Promise<void> {
  const receiptRoot = path.join(packageRoot, ...DKB_INSTALL_PLAN_RECEIPTS_DIR.split('/'));
  const files = await fs.readdir(receiptRoot).catch((error) => {
    if (missingFileError(error)) return [] as string[];
    throw error;
  });
  for (const file of files.filter((value) => value.endsWith('.json')).sort()) {
    try {
      const receiptPath = path.join(receiptRoot, file);
      const plan = validateInstallPlan(JSON.parse(await fs.readFile(receiptPath, 'utf8')), receiptPath);
      if (stableHash(plan) === stableHash(installedPlan)) continue;
      const [source, evidence, retrieval] = plan.artifacts;
      const [evidenceResult, retrievalResult, planResult] = await allLibraryReads([
        verifyLayerReceipt(evidence.receipt, resolver, `${receiptPath} Evidence receipt`),
        verifyLayerReceipt(retrieval.receipt, resolver, `${receiptPath} Retrieval receipt`),
        verifyLayerReceipt(plan.receipt, resolver, receiptPath),
      ]);
      const planPayload = { ...plan } as Record<string, unknown>;
      delete planPayload.receipt;
      const graph = await validateStoredPackageBuild(packageRoot, {
        version: plan.package.version,
        evidenceProfileDigest: plan.evidenceProfileDigest,
        evidenceDigest: plan.evidenceDigest,
        retrievalProfileDigest: plan.retrievalProfileDigest,
        retrievalBuildDigest: plan.retrievalBuildDigest,
      });
      const expectedFile = `${stableHash(plan).slice('sha256:'.length)}.json`;
      const ok = evidenceResult.ok
        && retrievalResult.ok
        && planResult.ok
        && stableHash(sourceReceipt) === source.receiptHash
        && stableHash(source.receipt) === source.receiptHash
        && evidenceResult.receiptHash === evidence.receiptHash
        && retrievalResult.receiptHash === retrieval.receiptHash
        && evidenceResult.receipt.type === 'dkb.evidence.receipt'
        && retrievalResult.receipt.type === 'dkb.retrieval.receipt'
        && planResult.receipt.type === 'dkb.install-plan.receipt'
        && evidenceResult.receipt.parentReceiptHash === source.receiptHash
        && retrievalResult.receipt.parentReceiptHash === evidence.receiptHash
        && evidenceResult.receipt.payload.sourceReceiptHash === source.receiptHash
        && retrievalResult.receipt.payload.evidenceReceiptHash === evidence.receiptHash
        && canonicalJson(planResult.receipt.payload) === canonicalJson(planPayload)
        && plan.package.id === entry.identity
        && plan.package.version === entry.version
        && sourceReceipt.package.id === plan.package.id
        && sourceReceipt.package.version === plan.package.version
        && sourceReceipt.package.publisherId === sourceReceipt.publisher.accountId
        && (sourceReceipt.package.registryId === undefined || sourceReceipt.package.registryId === sourceReceipt.registry.registryId)
        && Boolean(sourceReceipt.payload.packageTreeHash)
        && source.digest === plan.package.sourceDigest
        && evidenceResult.receipt.package.id === plan.package.id
        && evidenceResult.receipt.package.version === plan.package.version
        && evidenceResult.receipt.package.sourceHash === plan.package.sourceDigest
        && retrievalResult.receipt.package.id === plan.package.id
        && retrievalResult.receipt.package.version === plan.package.version
        && retrievalResult.receipt.package.sourceHash === plan.package.sourceDigest
        && planResult.receipt.package.id === plan.package.id
        && planResult.receipt.package.version === plan.package.version
        && planResult.receipt.package.sourceHash === plan.package.sourceDigest
        && evidenceResult.receipt.publisher.accountId === sourceReceipt.publisher.accountId
        && retrievalResult.receipt.publisher.accountId === sourceReceipt.publisher.accountId
        && planResult.receipt.publisher.accountId === sourceReceipt.publisher.accountId
        && evidenceResult.receipt.registry.registryId === sourceReceipt.registry.registryId
        && retrievalResult.receipt.registry.registryId === sourceReceipt.registry.registryId
        && planResult.receipt.registry.registryId === sourceReceipt.registry.registryId
        && evidenceResult.receipt.payload.evidenceProfileDigest === plan.evidenceProfileDigest
        && evidenceResult.receipt.payload.evidenceDigest === plan.evidenceDigest
        && retrievalResult.receipt.payload.target === plan.target
        && retrievalResult.receipt.payload.evidenceProfileDigest === plan.evidenceProfileDigest
        && retrievalResult.receipt.payload.evidenceDigest === plan.evidenceDigest
        && retrievalResult.receipt.payload.retrievalProfileDigest === plan.retrievalProfileDigest
        && retrievalResult.receipt.payload.compatibilityDigest === plan.compatibilityDigest
        && retrievalResult.receipt.payload.retrievalBuildDigest === plan.retrievalBuildDigest
        && graph.evidence.package.sourceDigest === plan.package.sourceDigest
        && plan.evidenceDigest === graph.evidence.evidenceDigest
        && plan.retrievalBuildDigest === graph.retrieval.retrievalBuildDigest
        && plan.compatibilityDigest === graph.retrieval.compatibilityDigest
        && file === expectedFile;
      checks.push(check(
        `install.receipt-chain.${stableHash(plan).slice(7, 19)}`,
        'Attached install receipt chain',
        ok ? 'passed' : 'failed',
        ok
          ? `${plan.evidenceDigest} -> ${plan.retrievalBuildDigest} verifies against the installed Registry source.`
          : `${plan.retrievalBuildDigest} does not match its signed source, Evidence, and Retrieval chain.`,
        ok ? undefined : reinstallCommand(libraryRoot, entry),
      ));
    } catch (error) {
      checks.push(check(
        `install.receipt-chain.${path.basename(file, '.json').slice(0, 12)}`,
        'Attached install receipt chain',
        'failed',
        errorMessage(error),
        reinstallCommand(libraryRoot, entry),
      ));
    }
  }
}

async function representativeStoredPackageGraph(
  packageRoot: string,
  listed: Awaited<ReturnType<typeof listPackageBuilds>>,
) {
  const selected = [...listed.retrieval].sort((left, right) =>
    `${left.profileDigest}/${left.buildDigest}`.localeCompare(`${right.profileDigest}/${right.buildDigest}`))[0];
  if (!selected) throw new DkbError(`No Retrieval Builds are stored at ${packageRoot}.`);
  const lockPath = path.join(selected.path, DKB_RETRIEVAL_BUILD_LOCK);
  const retrieval = validateRetrievalBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
  return validateStoredPackageBuild(packageRoot, {
    version: retrieval.package.version,
    evidenceProfileDigest: retrieval.evidenceProfileDigest,
    evidenceDigest: retrieval.evidenceDigest,
    retrievalProfileDigest: retrieval.retrievalProfileDigest,
    retrievalBuildDigest: retrieval.retrievalBuildDigest,
  });
}

async function verifyAttachedRetrievalReceipts(
  packageRoot: string,
  plan: ReturnType<typeof validateInstallPlan>,
  resolver: Parameters<typeof verifyPackageReceipt>[1],
  checks: DkbInspectionCheck[],
  entry: DkbLibraryStateEntry,
  libraryRoot: string,
): Promise<void> {
  const receiptRoot = path.join(packageRoot, '.dkb', 'receipts', 'retrieval');
  const files = await fs.readdir(receiptRoot).catch((error) => {
    if (missingFileError(error)) return [] as string[];
    throw error;
  });
  for (const file of files.filter((value) => value.endsWith('.json')).sort()) {
    try {
      const receiptPath = path.join(receiptRoot, file);
      const result = await verifyLayerReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')), resolver, receiptPath);
      const payload = result.receipt.payload;
      const evidenceProfileDigest = receiptField(payload, 'evidenceProfileDigest', receiptPath);
      const evidenceDigest = receiptField(payload, 'evidenceDigest', receiptPath);
      const retrievalProfileDigest = receiptField(payload, 'retrievalProfileDigest', receiptPath);
      const compatibilityDigest = receiptField(payload, 'compatibilityDigest', receiptPath);
      const retrievalBuildDigest = receiptField(payload, 'retrievalBuildDigest', receiptPath);
      const graph = await validateStoredPackageBuild(packageRoot, {
        version: result.receipt.package.version,
        evidenceProfileDigest,
        evidenceDigest,
        retrievalProfileDigest,
        retrievalBuildDigest,
      });
      const expectedFile = `${retrievalBuildDigest.slice('sha256:'.length)}.json`;
      const ok = result.ok
        && result.receipt.type === 'dkb.retrieval.receipt'
        && result.receipt.package.id === entry.identity
        && result.receipt.package.version === entry.version
        && result.receipt.parentReceiptHash === plan.artifacts[1]!.receiptHash
        && receiptField(payload, 'evidenceReceiptHash', receiptPath) === plan.artifacts[1]!.receiptHash
        && graph.retrieval.compatibilityDigest === compatibilityDigest
        && file === expectedFile;
      checks.push(check(
        `retrieval.receipt.${retrievalBuildDigest.slice(7, 19)}`,
        'Attached Retrieval receipt',
        ok ? 'passed' : 'failed',
        ok ? `${retrievalBuildDigest} verifies against its immutable build.` : `${retrievalBuildDigest} does not match its signed receipt chain.`,
        ok ? undefined : reinstallCommand(libraryRoot, entry),
      ));
    } catch (error) {
      checks.push(check(
        `retrieval.receipt.${path.basename(file, '.json').slice(0, 12)}`,
        'Attached Retrieval receipt',
        'failed',
        errorMessage(error),
        reinstallCommand(libraryRoot, entry),
      ));
    }
  }
}

function receiptField(payload: Record<string, unknown>, name: string, source: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || value.length === 0) throw new DkbError(`Invalid ${source}: ${name} is required.`);
  return value;
}

function collectionMembers(
  manifest: DkbSourceManifest,
  collectionId: string,
  state: Awaited<ReturnType<typeof readLibraryState>>,
): DkbInstalledEntryDetail['members'] {
  const direct = new Set(Object.keys(manifest.members ?? {}));
  const identities = new Set([...direct, ...Object.values(state.entries).filter((entry) => entry.requiredBy.includes(collectionId)).map((entry) => entry.identity)]);
  return [...identities].sort().map((identity) => {
    const resolved = state.entries[identity] as DkbLibraryStateEntry | undefined;
    return {
      identity,
      requested: String(manifest.members?.[identity] ?? 'resolved dependency'),
      ...(resolved?.version ? { resolved: resolved.version } : resolved?.revision ? { resolved: `r${resolved.revision}` } : {}),
      ...(resolved?.source ? { source: resolved.source } : {}),
      status: resolved?.status ?? 'missing' as const,
      direct: direct.has(identity),
    };
  });
}

function manifestSummary(manifest: DkbSourceManifest | null): DkbInstalledEntryDetail['manifest'] {
  if (!manifest) return null;
  return {
    name: manifest.name,
    ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.version ? { version: manifest.version } : {}),
    ...(manifest.publisher ? { publisher: manifest.publisher } : {}),
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(manifest.permissions ? { permissions: manifest.permissions } : {}),
  };
}

function publisherSummary(value: ReturnType<typeof parsePersistedPackageReceipt>['publisher']): DkbReceiptSignerSummary {
  return { subjectId: value.accountId, keyId: value.keyId, publicKeyFingerprint: value.publicKeyFingerprint, algorithm: value.algorithm, signedAt: value.signedAt };
}

function registrySummary(value: ReturnType<typeof parsePersistedPackageReceipt>['registry']): DkbReceiptSignerSummary {
  return { subjectId: value.registryId, keyId: value.keyId, publicKeyFingerprint: value.publicKeyFingerprint, algorithm: value.algorithm, signedAt: value.signedAt };
}

function trustedKeyResolver(keys: DkbSigningKeyRecord[]) {
  return ({ role, signature }: { role: 'publisher' | 'registry'; signature: { keyId: string } }) => {
    const subjectId = role === 'publisher'
      ? (signature as { accountId?: string }).accountId
      : (signature as { registryId?: string }).registryId;
    const key = keys.find((candidate) => candidate.id === signature.keyId
      && candidate.subjectType === role
      && candidate.subjectId === subjectId);
    return key && (key.status === 'active' || key.status === 'rotated') ? key.publicKeyPem : null;
  };
}

function notApplicableBuildCheck(): DkbInspectionCheck {
  return check('build.graph', 'Stored build graph', 'not_applicable', 'Collections resolve member DKB builds and do not own retrieval artifacts.');
}

function check(id: string, label: string, status: DkbInspectionStatus, message: string, recovery?: string): DkbInspectionCheck {
  return { id, label, status, message, ...(recovery ? { recovery } : {}) };
}

function inspectionStatus(checks: DkbInspectionCheck[]): DkbInspectionStatus {
  if (checks.some((item) => item.status === 'failed')) return 'failed';
  if (checks.some((item) => item.status === 'warning')) return 'warning';
  return 'passed';
}

function sourcePathFor(locator: Record<string, unknown>, fallback: string): string | null {
  for (const candidate of [locator.path, locator.file, locator.relativePath, fallback]) if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  return null;
}

function normalizeSourcePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, '');
}

function reinstallCommand(libraryRoot: string, entry: DkbLibraryStateEntry): string {
  return entry.source === 'registry'
    ? `dkb install ${entry.identity}${entry.version ? ` --version ${entry.version}` : ''} --library "${libraryRoot}" --force`
    : rebuildCommand(libraryRoot, resolveContainedPath(libraryRoot, entry.path, `Installed entry ${entry.identity} path`), entry);
}

function rebuildCommand(libraryRoot: string, packageRoot: string, entry: DkbLibraryStateEntry): string {
  return `dkb build "${packageRoot}" && dkb library add ${entry.identity} --library "${libraryRoot}"`;
}

function rebuildOrReinstallCommand(libraryRoot: string, packageRoot: string, entry: DkbLibraryStateEntry): string {
  return entry.source === 'registry' ? reinstallCommand(libraryRoot, entry) : rebuildCommand(libraryRoot, packageRoot, entry);
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await fs.stat(target)).size;
  }
  return total;
}

function missingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function humanLabel(value: string): string { return value.replace(/[._-]+/gu, ' ').replace(/^./u, (character) => character.toUpperCase()); }
function unique(values: string[]): string[] { return [...new Set(values)]; }

interface EvidenceFileSummary { sourceId: string; sourceHash: string; records: number }

export async function inspectInstalledPackage(...args: Parameters<typeof inspectInstalledPackageSnapshot>): ReturnType<typeof inspectInstalledPackageSnapshot> {
  return withLibraryReadFence(args[0], () => inspectInstalledPackageSnapshot(...args));
}

export async function listInstalledPackageContents(...args: Parameters<typeof listInstalledPackageContentsSnapshot>): ReturnType<typeof listInstalledPackageContentsSnapshot> {
  return withLibraryReadFence(args[0].libraryRoot, () => listInstalledPackageContentsSnapshot(...args));
}

export async function previewInstalledPackageFile(...args: Parameters<typeof previewInstalledPackageFileSnapshot>): ReturnType<typeof previewInstalledPackageFileSnapshot> {
  return withLibraryReadFence(args[0].libraryRoot, () => previewInstalledPackageFileSnapshot(...args));
}

export async function verifyInstalledPackage(...args: Parameters<typeof verifyInstalledPackageSnapshot>): ReturnType<typeof verifyInstalledPackageSnapshot> {
  return withLibraryReadFence(args[0].libraryRoot, () => verifyInstalledPackageSnapshot(...args));
}
