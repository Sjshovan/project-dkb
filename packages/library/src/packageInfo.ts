import fs from 'node:fs/promises';
import path from 'node:path';
import {
  validateEvidenceBuildLock,
  validateInstallPlan,
  validateRetrievalBuildLock,
} from '@sjshovan/dkb-protocol/builds.js';
import { canonicalJson, stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
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
  DKB_RETRIEVAL_BUILD_LOCK,
  listPackageBuilds,
  maybeReadRuntimeLock,
  readRetrievalBuildProfile,
  validatePackageBuildGraph,
} from './builds.js';
import { readEvidenceCatalog } from './evidenceCatalog.js';
import {
  DKB_INSTALL_PLAN_RECEIPT_PATH,
  DKB_PACKAGE_RECEIPT_PATH,
  parsePackageReceipt,
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

export async function inspectInstalledPackage(
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
  const runtimeLock = await maybeReadRuntimeLock(root).catch(() => null);
  const runtimeEntry = runtimeLock?.packages[entry.identity];
  const buildResult = entry.kind === 'dkb'
    ? await inspectDkbBuilds(packageRoot, runtimeLock?.compatibilityDigest, runtimeEntry, root, entry)
    : { builds: [] as DkbInstalledBuildSummary[], catalog: null, graph: null, profile: null, check: notApplicableBuildCheck() };
  checks.push(buildResult.check);
  const receiptResult = await inspectReceipt(root, packageRoot, entry);
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
  const active = runtimeLock && runtimeEntry && buildResult.profile
    ? {
        target: runtimeLock.target,
        evidenceProfileDigest: runtimeEntry.evidenceProfileDigest,
        evidenceDigest: runtimeEntry.evidenceDigest,
        retrievalProfileDigest: runtimeEntry.retrievalProfileDigest,
        retrievalBuildDigest: runtimeEntry.retrievalBuildDigest,
        compatibilityDigest: runtimeLock.compatibilityDigest,
        embeddingProvider: buildResult.profile.profile.embedding.provider,
        embeddingSpace: buildResult.profile.profile.embedding.space,
        dimensions: buildResult.profile.profile.embedding.dimensions,
        metric: buildResult.profile.profile.embedding.metric,
        indexProvider: buildResult.profile.profile.index.provider,
        indexFormat: buildResult.profile.profile.index.format,
        retrievalProvider: buildResult.profile.profile.retrieval.provider,
      }
    : undefined;

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
    ...(active ? { activeBuild: active } : {}),
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

export async function listInstalledPackageContents(input: {
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

export async function previewInstalledPackageFile(input: {
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

export async function verifyInstalledPackage(input: {
  libraryRoot: string;
  identity: string;
  trustedKeys?: DkbSigningKeyRecord[];
  keyWarning?: string;
}): Promise<DkbPackageVerification> {
  const { root, entry, packageRoot } = await installedEntryContext(input.libraryRoot, input.identity);
  const checks: DkbInspectionCheck[] = [];
  let receipt: ReturnType<typeof parsePackageReceipt> | null = null;

  try {
    const manifest = await loadManifest(packageRoot);
    checks.push(check('package.manifest', 'Package manifest', 'passed', `${manifest.name} matches an installed ${manifest.type}.`));
  } catch (error) {
    checks.push(check('package.manifest', 'Package manifest', 'failed', errorMessage(error), reinstallCommand(root, entry)));
  }

  if (entry.kind === 'dkb') {
    try {
      const graph = await validatePackageBuildGraph(packageRoot);
      checks.push(check('build.graph', 'Active build graph', 'passed', `${graph.evidence.evidenceDigest} → ${graph.retrieval.retrievalBuildDigest}`));
    } catch (error) {
      checks.push(check('build.graph', 'Active build graph', 'failed', errorMessage(error), rebuildOrReinstallCommand(root, packageRoot, entry)));
    }
  } else {
    checks.push(check('build.graph', 'Active build graph', 'not_applicable', 'Collections resolve member DKB builds and do not own retrieval artifacts.'));
  }

  if (entry.source === 'registry') {
    try {
      const receiptPath = path.join(packageRoot, DKB_PACKAGE_RECEIPT_PATH);
      receipt = parsePackageReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')), receiptPath);
      const tree = await hashPortablePackageTree(packageRoot);
      const treeMatches = !receipt.payload.packageTreeHash || receipt.payload.packageTreeHash === tree.hash;
      checks.push(check(
        'package.tree', 'Portable package tree', treeMatches ? 'passed' : 'failed',
        treeMatches ? `${tree.files.length} files match ${tree.hash}.` : `Expected ${receipt.payload.packageTreeHash}, got ${tree.hash}.`,
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
  compatibilityDigest: string | undefined,
  runtimeEntry: { evidenceProfileDigest: string; evidenceDigest: string; retrievalProfileDigest: string; retrievalBuildDigest: string } | undefined,
  libraryRoot: string,
  entry: DkbLibraryStateEntry,
) {
  try {
    const [graph, listed] = await Promise.all([validatePackageBuildGraph(packageRoot), listPackageBuilds(packageRoot)]);
    const catalog = readEvidenceCatalog(graph.evidencePath);
    const builds: DkbInstalledBuildSummary[] = [];
    for (const item of listed.evidence) {
      const lockPath = path.join(item.path, DKB_EVIDENCE_BUILD_LOCK);
      const lock = validateEvidenceBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
      builds.push({
        kind: 'evidence', profileDigest: item.profileDigest, buildDigest: item.evidenceDigest,
        active: Boolean(runtimeEntry && runtimeEntry.evidenceProfileDigest === item.profileDigest && runtimeEntry.evidenceDigest === item.evidenceDigest),
        bytes: await directoryBytes(item.path), generatedAt: lock.generatedAt, recordCount: lock.recordCount, chunkCount: lock.chunkCount,
      });
    }
    for (const item of listed.retrieval) {
      const lockPath = path.join(item.path, DKB_RETRIEVAL_BUILD_LOCK);
      const lock = validateRetrievalBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
      builds.push({
        kind: 'retrieval', profileDigest: item.profileDigest, buildDigest: item.buildDigest,
        active: Boolean(runtimeEntry && runtimeEntry.retrievalProfileDigest === item.profileDigest && runtimeEntry.retrievalBuildDigest === item.buildDigest),
        bytes: await directoryBytes(item.path), generatedAt: lock.generatedAt, compatibilityDigest: lock.compatibilityDigest,
      });
    }
    const profile = await readRetrievalBuildProfile(graph.retrievalPath);
    return {
      builds, catalog, graph, profile,
      check: check('build.graph', 'Active build graph', 'passed', `${catalog.assets.length} sources and ${catalog.records.length} Evidence records are active in ${compatibilityDigest ?? graph.retrieval.compatibilityDigest}.`),
    };
  } catch (error) {
    return {
      builds: [] as DkbInstalledBuildSummary[], catalog: null, graph: null, profile: null,
      check: check('build.graph', 'Active build graph', 'failed', errorMessage(error), rebuildOrReinstallCommand(libraryRoot, packageRoot, entry)),
    };
  }
}

async function inspectReceipt(libraryRoot: string, packageRoot: string, entry: DkbLibraryStateEntry) {
  if (entry.source !== 'registry') {
    return {
      receipt: null, status: 'not_applicable' as const, installChainStatus: 'not_applicable' as const,
      check: check('package.receipt', 'Package receipt', 'not_applicable', 'Editable local knowledge is not a signed Registry release.'),
      installChainCheck: check('install.receipts', 'Installed build receipts', 'not_applicable', 'Editable local knowledge uses locally compiled builds.'),
    };
  }
  let receipt: ReturnType<typeof parsePackageReceipt> | null = null;
  let status: 'present' | 'missing' | 'invalid' = 'missing';
  let receiptMessage = 'The signed package receipt is missing.';
  try {
    const receiptPath = path.join(packageRoot, DKB_PACKAGE_RECEIPT_PATH);
    receipt = parsePackageReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')), receiptPath);
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

async function activeEvidenceMap(packageRoot: string): Promise<Map<string, EvidenceFileSummary>> {
  try {
    const graph = await validatePackageBuildGraph(packageRoot);
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
  sourceReceipt: ReturnType<typeof parsePackageReceipt>,
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
    const graph = await validatePackageBuildGraph(packageRoot);
    const identities = [
      stableHash(sourceReceipt) === source.receiptHash,
      evidenceResult.receiptHash === evidence.receiptHash,
      retrievalResult.receiptHash === retrieval.receiptHash,
      evidenceResult.receipt.parentReceiptHash === source.receiptHash,
      retrievalResult.receipt.parentReceiptHash === evidence.receiptHash,
      canonicalJson(planResult.receipt.payload) === canonicalJson(planPayload),
      plan.package.id === entry.identity,
      plan.evidenceDigest === graph.evidence.evidenceDigest,
      plan.retrievalBuildDigest === graph.retrieval.retrievalBuildDigest,
      plan.compatibilityDigest === graph.retrieval.compatibilityDigest,
    ];
    const ok = identities.every(Boolean) && evidenceResult.ok && retrievalResult.ok && planResult.ok;
    checks.push(check(
      'install.receipt-chain', 'Installed receipt chain', ok ? 'passed' : 'failed',
      ok ? 'Source, Evidence, Retrieval, and install-plan receipts verify against the active build graph.' : 'The stored install receipt chain does not match the active build graph.',
      ok ? undefined : reinstallCommand(libraryRoot, entry),
    ));
  } catch (error) {
    checks.push(check('install.receipt-chain', 'Installed receipt chain', missingFileError(error) ? 'warning' : 'failed', errorMessage(error), reinstallCommand(libraryRoot, entry)));
  }
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

function publisherSummary(value: ReturnType<typeof parsePackageReceipt>['publisher']): DkbReceiptSignerSummary {
  return { subjectId: value.accountId, keyId: value.keyId, publicKeyFingerprint: value.publicKeyFingerprint, algorithm: value.algorithm, signedAt: value.signedAt };
}

function registrySummary(value: ReturnType<typeof parsePackageReceipt>['registry']): DkbReceiptSignerSummary {
  return { subjectId: value.registryId, keyId: value.keyId, publicKeyFingerprint: value.publicKeyFingerprint, algorithm: value.algorithm, signedAt: value.signedAt };
}

function trustedKeyResolver(keys: DkbSigningKeyRecord[]) {
  return ({ role, signature }: { role: 'publisher' | 'registry'; signature: { keyId: string } }) => {
    const key = keys.find((candidate) => candidate.id === signature.keyId && candidate.subjectType === role);
    return key && key.status !== 'revoked' ? key.publicKeyPem : null;
  };
}

function notApplicableBuildCheck(): DkbInspectionCheck {
  return check('build.graph', 'Active build graph', 'not_applicable', 'Collections resolve member DKB builds and do not own retrieval artifacts.');
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
