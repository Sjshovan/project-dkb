import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { compileComposeProject } from '../compiler/compile.js';
import { invalidateRuntimeQuerySnapshot, ensureRuntimeState } from '../runtime/state.js';
import { refreshRuntimeCatalogFromInstalledArtifacts } from '../runtime/catalog.js';
import { canonicalJson, stableHash } from '../contracts/hash.js';
import { DkbError } from '../protocol/errors.js';
import { loadDkb, loadRegistry } from '../protocol/manifest.js';
import { manifestPath } from '../protocol/paths.js';
import { validateDkbLockManifest } from '../protocol/validation.js';
import { createDkbPackageArchive, DKB_PACKAGE_EXTENSION, extractDkbPackageArchive } from './archive.js';
import {
  createSignedPackageReceipt,
  DKB_PACKAGE_RECEIPT_PATH,
  generateSigningKeyPair,
  packageReceiptPayloadForLock,
  parsePackageReceipt,
  verifyPackageReceipt,
} from '../signing/index.js';
import {
  KR_GRAPH_PATH,
  KR_INDEX_PATH,
  KR_VECTOR_PATH,
} from '../indexes/knowledgeIndex.js';
import { SOURCE_INDEX_PATH } from '../indexes/sourceIndex.js';
import type { DkbLockArtifact, DkbLockManifest, DkbPackageReceipt, DkbSigningKeyRecord, LoadedDkb } from '../protocol/types.js';

export const MOCK_REGISTRY_DB = 'registry.sqlite';
export const MOCK_REGISTRY_PACKAGES_DIR = 'packages';
export const MOCK_REGISTRY_ARCHIVES_DIR = 'archives';
export const MOCK_REGISTRY_TMP_DIR = '.tmp';
export const MOCK_REGISTRY_ID = 'mock-registry';

export interface MockRegistryPaths {
  root: string;
  databasePath: string;
  packagesDir: string;
  archivesDir: string;
  tmpDir: string;
}

export interface MockRegistryAccount {
  id: string;
  name?: string;
  email?: string;
}

export interface MockRegistryLoginResult {
  status: 'logged_in';
  account: MockRegistryAccount;
  key: DkbSigningKeyRecord;
}

export interface MockRegistryPublishOptions {
  registryRoot: string;
  sourcePath: string;
  accountId?: string;
  accountName?: string;
  accountEmail?: string;
  force?: boolean;
}

export interface MockRegistryPublishResult {
  status: 'published';
  registryRoot: string;
  packageId: string;
  name: string;
  version: string;
  packagePath: string;
  receiptPath: string;
  archivePath: string;
  archiveHash: string;
  payloadHash: string;
  publisherKeyId: string;
  registryKeyId: string;
}

export interface MockRegistryPackageSummary {
  packageId: string;
  name: string;
  version: string;
  description?: string;
  collectionId?: string;
  collectionName?: string;
  receiptPath: string;
  archivePath: string;
  archiveHash: string;
  payloadHash: string;
  publishedAt: string;
}

export interface MockRegistryDownloadResult {
  status: 'downloaded';
  registryRoot: string;
  packageId: string;
  version: string;
  packagePath: string;
  receiptPath: string;
  archivePath: string;
  archiveHash: string;
  receipt: DkbPackageReceipt;
  publisherKey: DkbSigningKeyRecord;
  registryKey: DkbSigningKeyRecord;
}

export interface MockRegistryPackageArchive {
  status: 'packaged';
  packageId: string;
  version: string;
  archivePath: string;
  archiveHash: string;
  fileName: string;
}

export interface MockRegistryVerifyResult {
  ok: boolean;
  packageId: string;
  version: string;
  checks: Awaited<ReturnType<typeof verifyPackageReceipt>>['checks'];
}

export interface MockRegistryInstallResult {
  status: 'installed';
  packageId: string;
  version: string;
  runtimeRoot: string;
  packagePath: string;
  verification: MockRegistryVerifyResult;
  catalog: {
    recordCount: number;
    packageCount: number;
  };
}

interface AccountRow {
  id: string;
  name: string | null;
  email: string | null;
}

interface KeyRow {
  id: string;
  subject_type: 'publisher' | 'registry';
  subject_id: string;
  private_key_pem: string;
  public_key_pem: string;
  public_key_fingerprint: string;
  status: 'active' | 'rotated' | 'revoked';
  created_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
}

interface ReleaseRow {
  package_id: string;
  name: string;
  version: string;
  description: string | null;
  collection_id: string | null;
  collection_name: string | null;
  package_path: string;
  lock_path: string;
  release_path: string;
  archive_path: string;
  archive_hash: string;
  payload_hash: string;
  publisher_key_id: string;
  registry_key_id: string;
  published_at: string;
}

export async function mockRegistryPaths(registryRoot: string): Promise<MockRegistryPaths> {
  const root = path.resolve(registryRoot);

  return {
    root,
    databasePath: path.join(root, MOCK_REGISTRY_DB),
  packagesDir: path.join(root, MOCK_REGISTRY_PACKAGES_DIR),
  archivesDir: path.join(root, MOCK_REGISTRY_ARCHIVES_DIR),
  tmpDir: path.join(root, MOCK_REGISTRY_TMP_DIR),
  };
}

export async function ensureMockRegistry(registryRoot: string): Promise<MockRegistryPaths> {
  const paths = await mockRegistryPaths(registryRoot);

  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.packagesDir, { recursive: true });
  await fs.mkdir(paths.archivesDir, { recursive: true });
  await fs.mkdir(paths.tmpDir, { recursive: true });

  const database = openRegistryDatabase(paths.databasePath);

  try {
    migrateRegistryDatabase(database);
    ensureActiveRegistryKey(database);
  } finally {
    database.close();
  }

  return paths;
}

export async function loginMockRegistry(options: {
  registryRoot: string;
  accountId?: string;
  name?: string;
  email?: string;
}): Promise<MockRegistryLoginResult> {
  const paths = await ensureMockRegistry(options.registryRoot);
  const database = openRegistryDatabase(paths.databasePath);

  try {
    const accountId = safeId(options.accountId ?? options.email ?? options.name ?? 'local-publisher');
    const now = new Date().toISOString();

    database.prepare(`
      insert into accounts (id, name, email, created_at)
      values (?, ?, ?, ?)
      on conflict(id) do update set
        name = excluded.name,
        email = excluded.email
    `).run(accountId, options.name ?? null, options.email ?? null, now);

    const key = ensureActiveSubjectKey(database, 'publisher', accountId);

    return {
      status: 'logged_in',
      account: {
        id: accountId,
        ...(options.name ? { name: options.name } : {}),
        ...(options.email ? { email: options.email } : {}),
      },
      key: keyRecordFromRow(key),
    };
  } finally {
    database.close();
  }
}

export async function publishDkbToMockRegistry(options: MockRegistryPublishOptions): Promise<MockRegistryPublishResult> {
  const paths = await ensureMockRegistry(options.registryRoot);
  const account = await loginMockRegistry({
    registryRoot: options.registryRoot,
    accountId: options.accountId,
    name: options.accountName,
    email: options.accountEmail,
  });
  const sourceRoot = path.resolve(options.sourcePath);
  const dkb = await loadDkb(sourceRoot);
  const version = dkb.manifest.version;
  const packageId = dkb.manifest.id;
  const packagePath = path.join(paths.packagesDir, packageId, version);
  const archivePath = path.join(paths.archivesDir, packageId, version, packageArchiveFileName(packageId, version));

  if (await exists(packagePath)) {
    if (!options.force) {
      throw new DkbError(`Registry package version already exists: ${packageId}@${version}. Use force to replace it.`);
    }

    await fs.rm(packagePath, { recursive: true, force: true });
  }
  await fs.rm(archivePath, { force: true });

  const buildParent = path.join(paths.tmpDir, `publish-${process.pid}-${Date.now().toString(36)}`);
  const buildRoot = path.join(buildParent, packageId);

  await fs.rm(buildParent, { recursive: true, force: true });
  await fs.mkdir(path.dirname(buildRoot), { recursive: true });
  await copyDkbSourceOnly(sourceRoot, buildRoot);

  try {
    await writeRegistryPackageManifest(buildRoot, dkb, account.account.id);
    const compiled = await compileComposeProject(buildRoot, { force: true });
    const database = openRegistryDatabase(paths.databasePath);

    try {
      const publisherKey = activeKey(database, account.key.id);
      const registryKey = activeRegistryKey(database);
      await fs.rm(manifestPath(buildRoot, 'dkb-lock.json'), { force: true });
      await fs.rm(manifestPath(buildRoot, 'dkb-release.json'), { force: true });
      const packageTreeHash = await hashPackageTree(buildRoot);
      const receipt = createSignedPackageReceipt(compiled.lock, {
        package: {
          id: packageId,
          name: dkb.manifest.name,
          version,
          registryId: MOCK_REGISTRY_ID,
          publisherId: account.account.id,
        },
        packageTreeHash,
        publisher: {
          accountId: account.account.id,
          keyId: publisherKey.id,
          privateKeyPem: publisherKey.private_key_pem,
        },
        registry: {
          registryId: MOCK_REGISTRY_ID,
          keyId: registryKey.id,
          privateKeyPem: registryKey.private_key_pem,
        },
      });
      const receiptPath = manifestPath(buildRoot, DKB_PACKAGE_RECEIPT_PATH);

      await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      await fs.mkdir(path.dirname(packagePath), { recursive: true });
      await fs.cp(buildRoot, packagePath, { recursive: true });
      await createDkbPackageArchive(buildRoot, archivePath);
      const archiveHash = await hashRequiredPath(archivePath);
      upsertPackage(database, dkb);
      insertRelease(database, {
        dkb,
        packagePath,
        lockPath: path.join(packagePath, DKB_PACKAGE_RECEIPT_PATH),
        releasePath: path.join(packagePath, DKB_PACKAGE_RECEIPT_PATH),
        archivePath,
        archiveHash,
        payloadHash: receipt.payloadHash,
        publisherKeyId: publisherKey.id,
        registryKeyId: registryKey.id,
      });

      return {
        status: 'published',
        registryRoot: paths.root,
        packageId,
        name: dkb.manifest.name,
        version,
        packagePath,
        receiptPath: path.join(packagePath, DKB_PACKAGE_RECEIPT_PATH),
        archivePath,
        archiveHash,
        payloadHash: receipt.payloadHash,
        publisherKeyId: publisherKey.id,
        registryKeyId: registryKey.id,
      };
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(buildParent, { recursive: true, force: true });
  }
}

export async function listMockRegistryPackages(registryRoot: string): Promise<{ packages: MockRegistryPackageSummary[] }> {
  const paths = await ensureMockRegistry(registryRoot);
  const database = openRegistryDatabase(paths.databasePath);

  try {
    const rows = database.prepare(`
      select
        releases.package_id,
        packages.name,
        releases.version,
        packages.description,
        packages.collection_id,
        packages.collection_name,
        releases.release_path,
        releases.archive_path,
        releases.archive_hash,
        releases.payload_hash,
        releases.published_at
      from releases
      join packages on packages.id = releases.package_id
      order by packages.name asc, releases.published_at desc
    `).all() as unknown as ReleaseRow[];

    return { packages: rows.map(packageSummaryFromRow) };
  } finally {
    database.close();
  }
}

export async function downloadDkbFromMockRegistry(options: {
  registryRoot: string;
  packageId: string;
  version?: string;
}): Promise<MockRegistryDownloadResult> {
  const paths = await ensureMockRegistry(options.registryRoot);
  const database = openRegistryDatabase(paths.databasePath);

  try {
    const row = latestReleaseRow(database, options.packageId, options.version);
    const receipt = parsePackageReceipt(JSON.parse(await fs.readFile(row.release_path, 'utf8')), row.release_path);
    const publisherKey = keyRecordFromRow(keyById(database, row.publisher_key_id));
    const registryKey = keyRecordFromRow(keyById(database, row.registry_key_id));

    return {
      status: 'downloaded',
      registryRoot: paths.root,
      packageId: row.package_id,
      version: row.version,
      packagePath: row.package_path,
      receiptPath: row.release_path,
      archivePath: row.archive_path,
      archiveHash: row.archive_hash,
      receipt,
      publisherKey,
      registryKey,
    };
  } finally {
    database.close();
  }
}

export async function verifyDownloadedMockRelease(options: {
  registryRoot: string;
  packageId: string;
  version?: string;
}): Promise<MockRegistryVerifyResult> {
  const downloaded = await downloadDkbFromMockRegistry(options);
  const lock = downloaded.receipt.payload.lock;
  const payloadMatchesLock = stableHash(packageReceiptPayloadForLock(lock, downloaded.receipt.payload.packageTreeHash)) === downloaded.receipt.payloadHash
    && canonicalJson(lock) === canonicalJson(downloaded.receipt.payload.lock);
  const artifactChecks = await verifyPackageArtifacts(downloaded.packagePath, lock);
  const packageTreeHash = downloaded.receipt.payload.packageTreeHash ?? null;
  const actualPackageTreeHash = packageTreeHash ? await hashPackageTree(downloaded.packagePath) : null;
  const packageTreeMatches = !packageTreeHash || actualPackageTreeHash === packageTreeHash;
  const verification = await verifyPackageReceipt(downloaded.receipt, ({ role }) => (
    role === 'publisher'
      ? downloaded.publisherKey.publicKeyPem
      : downloaded.registryKey.publicKeyPem
  ));

  return {
    ok: payloadMatchesLock && packageTreeMatches && artifactChecks.every((check) => check.ok) && verification.ok,
    packageId: downloaded.packageId,
    version: downloaded.version,
    checks: [
      {
        name: 'payload_matches_lock',
        ok: payloadMatchesLock,
        detail: payloadMatchesLock ? 'receipt payload matches registry build lock' : 'receipt payload differs from registry build lock',
      },
      {
        name: 'package_tree_hash',
        ok: packageTreeMatches,
        detail: packageTreeMatches ? 'package tree hash matches receipt' : `package tree hash mismatch: expected ${packageTreeHash}, got ${actualPackageTreeHash}`,
      },
      ...artifactChecks,
      ...verification.checks,
    ],
  };
}

export async function installDkbFromMockRegistry(options: {
  registryRoot: string;
  packageId: string;
  version?: string;
  runtimeRoot?: string;
  force?: boolean;
}): Promise<MockRegistryInstallResult> {
  const downloaded = await downloadDkbFromMockRegistry(options);

  return installDkbArchiveIntoRuntime({
    archivePath: downloaded.archivePath,
    runtimeRoot: options.runtimeRoot,
    trustedKeys: [downloaded.publisherKey, downloaded.registryKey],
    force: options.force,
  });
}

export async function exportMockRegistryPackageArchive(options: {
  registryRoot: string;
  packageId: string;
  version?: string;
}): Promise<MockRegistryPackageArchive> {
  const downloaded = await downloadDkbFromMockRegistry(options);

  return {
    status: 'packaged',
    packageId: downloaded.packageId,
    version: downloaded.version,
    archivePath: downloaded.archivePath,
    archiveHash: downloaded.archiveHash,
    fileName: packageArchiveFileName(downloaded.packageId, downloaded.version),
  };
}

export async function installDkbArchiveIntoRuntime(options: {
  archivePath: string;
  runtimeRoot?: string;
  trustedKeys: DkbSigningKeyRecord[];
  force?: boolean;
}): Promise<MockRegistryInstallResult> {
  const runtime = await ensureRuntimeState(options.runtimeRoot);
  const installParent = path.join(runtime.stateDir, 'tmp', `install-${process.pid}-${Date.now().toString(36)}`);
  const extractedRoot = path.join(installParent, 'package');

  await fs.rm(installParent, { recursive: true, force: true });

  try {
    await extractDkbPackageArchive(options.archivePath, extractedRoot);
    const verification = await verifyExtractedPackage(extractedRoot, options.trustedKeys, 'package receipt');

    if (!verification.ok) {
      throw new DkbError(`Registry package verification failed: ${verification.packageId}@${verification.version}`);
    }

    const receipt = parsePackageReceipt(JSON.parse(await fs.readFile(path.join(extractedRoot, DKB_PACKAGE_RECEIPT_PATH), 'utf8')), path.join(extractedRoot, DKB_PACKAGE_RECEIPT_PATH));
    const target = runtimeVendorPackagePath(runtime.stateRoot, receipt, verification.packageId, verification.version);
    const installed = await installedPackageRoots(runtime.stateRoot, verification.packageId);

    if (installed.length > 0 || await exists(target)) {
      if (!options.force) {
        throw new DkbError(`Runtime DKB already exists: ${verification.packageId}. Use force to replace it.`);
      }

      await Promise.all(installed.map((root) => fs.rm(root, { recursive: true, force: true })));
      await fs.rm(target, { recursive: true, force: true });
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(path.join(extractedRoot, DKB_PACKAGE_RECEIPT_PATH), { force: true });
    await fs.rm(path.join(extractedRoot, 'dkb-lock.json'), { force: true });
    await fs.rm(path.join(extractedRoot, 'dkb-release.json'), { force: true });
    await fs.rename(extractedRoot, target);
    const catalog = await refreshRuntimeCatalogFromInstalledArtifacts(runtime.stateRoot);
    await updateRuntimeInstallManifests(runtime.stateRoot, receipt, {
      archiveHash: await hashRequiredPath(options.archivePath),
      installedPath: path.relative(runtime.stateRoot, target).replace(/\\/g, '/'),
    });
    invalidateRuntimeQuerySnapshot(runtime.stateRoot);

    return {
      status: 'installed',
      packageId: verification.packageId,
      version: verification.version,
      runtimeRoot: runtime.stateRoot,
      packagePath: target,
      verification,
      catalog,
    };
  } finally {
    await fs.rm(installParent, { recursive: true, force: true });
  }
}

export async function rotateMockRegistryAccountKey(options: {
  registryRoot: string;
  accountId: string;
}): Promise<{ status: 'rotated'; previousKeyId: string; activeKey: DkbSigningKeyRecord }> {
  const paths = await ensureMockRegistry(options.registryRoot);
  const database = openRegistryDatabase(paths.databasePath);

  try {
    const current = activeSubjectKey(database, 'publisher', options.accountId);
    const now = new Date().toISOString();

    database.prepare('update signing_keys set status = ?, rotated_at = ? where id = ?').run('rotated', now, current.id);

    const next = createSubjectKey(database, 'publisher', options.accountId, now);

    return {
      status: 'rotated',
      previousKeyId: current.id,
      activeKey: keyRecordFromRow(next),
    };
  } finally {
    database.close();
  }
}

export async function rotateMockRegistrySigningKey(options: {
  registryRoot: string;
}): Promise<{ status: 'rotated'; previousKeyId: string; activeKey: DkbSigningKeyRecord }> {
  const paths = await ensureMockRegistry(options.registryRoot);
  const database = openRegistryDatabase(paths.databasePath);

  try {
    const current = activeRegistryKey(database);
    const now = new Date().toISOString();

    database.prepare('update signing_keys set status = ?, rotated_at = ? where id = ?').run('rotated', now, current.id);

    const next = createSubjectKey(database, 'registry', MOCK_REGISTRY_ID, now);

    return {
      status: 'rotated',
      previousKeyId: current.id,
      activeKey: keyRecordFromRow(next),
    };
  } finally {
    database.close();
  }
}

export async function revokeMockRegistryKey(options: {
  registryRoot: string;
  keyId: string;
}): Promise<{ status: 'revoked'; key: DkbSigningKeyRecord }> {
  const paths = await ensureMockRegistry(options.registryRoot);
  const database = openRegistryDatabase(paths.databasePath);

  try {
    const now = new Date().toISOString();

    database.prepare('update signing_keys set status = ?, revoked_at = ? where id = ?').run('revoked', now, options.keyId);

    return {
      status: 'revoked',
      key: keyRecordFromRow(keyById(database, options.keyId)),
    };
  } finally {
    database.close();
  }
}

export async function registryPublicKeys(registryRoot: string): Promise<{ keys: DkbSigningKeyRecord[] }> {
  const paths = await ensureMockRegistry(registryRoot);
  const database = openRegistryDatabase(paths.databasePath);

  try {
    const rows = database.prepare(`
      select id, subject_type, subject_id, private_key_pem, public_key_pem, public_key_fingerprint, status, created_at, rotated_at, revoked_at
      from signing_keys
      order by created_at asc, id asc
    `).all() as unknown as KeyRow[];

    return { keys: rows.map(keyRecordFromRow) };
  } finally {
    database.close();
  }
}

function openRegistryDatabase(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath);
}

function migrateRegistryDatabase(database: DatabaseSync): void {
  database.exec(`
    create table if not exists accounts (
      id text primary key,
      name text,
      email text,
      created_at text not null
    );

    create table if not exists signing_keys (
      id text primary key,
      subject_type text not null check(subject_type in ('publisher', 'registry')),
      subject_id text not null,
      private_key_pem text not null,
      public_key_pem text not null,
      public_key_fingerprint text not null,
      status text not null check(status in ('active', 'rotated', 'revoked')),
      created_at text not null,
      rotated_at text,
      revoked_at text
    );

    create table if not exists packages (
      id text primary key,
      name text not null,
      latest_version text not null,
      description text,
      collection_id text,
      collection_name text,
      owner_json text,
      updated_at text not null
    );

    create table if not exists releases (
      id text primary key,
      package_id text not null,
      version text not null,
      package_path text not null,
      lock_path text not null,
      release_path text not null,
      archive_path text,
      archive_hash text,
      payload_hash text not null,
      publisher_key_id text not null,
      registry_key_id text not null,
      published_at text not null,
      unique(package_id, version)
    );
  `);
  addColumnIfMissing(database, 'releases', 'archive_path text');
  addColumnIfMissing(database, 'releases', 'archive_hash text');
}

function addColumnIfMissing(database: DatabaseSync, table: string, definition: string): void {
  const column = definition.split(/\s+/)[0]!;
  const existing = database.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;

  if (existing.some((row) => row.name === column)) {
    return;
  }

  database.exec(`alter table ${table} add column ${definition}`);
}

function ensureActiveRegistryKey(database: DatabaseSync): KeyRow {
  try {
    return activeSubjectKey(database, 'registry', MOCK_REGISTRY_ID);
  } catch {
    return createSubjectKey(database, 'registry', MOCK_REGISTRY_ID);
  }
}

function ensureActiveSubjectKey(database: DatabaseSync, subjectType: 'publisher' | 'registry', subjectId: string): KeyRow {
  try {
    return activeSubjectKey(database, subjectType, subjectId);
  } catch {
    return createSubjectKey(database, subjectType, subjectId);
  }
}

function activeRegistryKey(database: DatabaseSync): KeyRow {
  return activeSubjectKey(database, 'registry', MOCK_REGISTRY_ID);
}

function activeSubjectKey(database: DatabaseSync, subjectType: 'publisher' | 'registry', subjectId: string): KeyRow {
  const row = database.prepare(`
    select id, subject_type, subject_id, private_key_pem, public_key_pem, public_key_fingerprint, status, created_at, rotated_at, revoked_at
    from signing_keys
    where subject_type = ? and subject_id = ? and status = 'active'
    order by created_at desc
    limit 1
  `).get(subjectType, subjectId) as KeyRow | undefined;

  if (!row) {
    throw new DkbError(`No active ${subjectType} signing key for ${subjectId}`);
  }

  return row;
}

function activeKey(database: DatabaseSync, keyId: string): KeyRow {
  const row = keyById(database, keyId);

  if (row.status !== 'active') {
    throw new DkbError(`Signing key is not active: ${keyId}`);
  }

  return row;
}

function keyById(database: DatabaseSync, keyId: string): KeyRow {
  const row = database.prepare(`
    select id, subject_type, subject_id, private_key_pem, public_key_pem, public_key_fingerprint, status, created_at, rotated_at, revoked_at
    from signing_keys
    where id = ?
  `).get(keyId) as KeyRow | undefined;

  if (!row) {
    throw new DkbError(`Unknown signing key: ${keyId}`);
  }

  return row;
}

function createSubjectKey(
  database: DatabaseSync,
  subjectType: 'publisher' | 'registry',
  subjectId: string,
  createdAt = new Date().toISOString(),
): KeyRow {
  const key = generateSigningKeyPair();
  const id = `${subjectType}_${subjectId}_${createdAt.replace(/[^0-9a-z]/gi, '').toLowerCase()}`;

  database.prepare(`
    insert into signing_keys (
      id,
      subject_type,
      subject_id,
      private_key_pem,
      public_key_pem,
      public_key_fingerprint,
      status,
      created_at
    )
    values (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(id, subjectType, subjectId, key.privateKeyPem, key.publicKeyPem, key.publicKeyFingerprint, createdAt);

  return keyById(database, id);
}

function upsertPackage(database: DatabaseSync, dkb: LoadedDkb): void {
  database.prepare(`
    insert into packages (
      id,
      name,
      latest_version,
      description,
      collection_id,
      collection_name,
      owner_json,
      updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      name = excluded.name,
      latest_version = excluded.latest_version,
      description = excluded.description,
      collection_id = excluded.collection_id,
      collection_name = excluded.collection_name,
      owner_json = excluded.owner_json,
      updated_at = excluded.updated_at
  `).run(
    dkb.manifest.id,
    dkb.manifest.name,
    dkb.manifest.version,
    dkb.manifest.description ?? null,
    dkb.manifest.collection?.id ?? null,
    dkb.manifest.collection?.name ?? null,
    dkb.manifest.owner ? JSON.stringify(dkb.manifest.owner) : null,
    new Date().toISOString(),
  );
}

function insertRelease(database: DatabaseSync, input: {
  dkb: LoadedDkb;
  packagePath: string;
  lockPath: string;
  releasePath: string;
  archivePath: string;
  archiveHash: string;
  payloadHash: string;
  publisherKeyId: string;
  registryKeyId: string;
}): void {
  const publishedAt = new Date().toISOString();

  database.prepare(`
    insert into releases (
      id,
      package_id,
      version,
      package_path,
      lock_path,
      release_path,
      archive_path,
      archive_hash,
      payload_hash,
      publisher_key_id,
      registry_key_id,
      published_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(package_id, version) do update set
      package_path = excluded.package_path,
      lock_path = excluded.lock_path,
      release_path = excluded.release_path,
      archive_path = excluded.archive_path,
      archive_hash = excluded.archive_hash,
      payload_hash = excluded.payload_hash,
      publisher_key_id = excluded.publisher_key_id,
      registry_key_id = excluded.registry_key_id,
      published_at = excluded.published_at
  `).run(
    `${input.dkb.manifest.id}@${input.dkb.manifest.version}`,
    input.dkb.manifest.id,
    input.dkb.manifest.version,
    input.packagePath,
    input.lockPath,
    input.releasePath,
    input.archivePath,
    input.archiveHash,
    input.payloadHash,
    input.publisherKeyId,
    input.registryKeyId,
    publishedAt,
  );
}

function latestReleaseRow(database: DatabaseSync, packageId: string, version?: string): ReleaseRow {
  const row = version
    ? database.prepare(`
        select
          releases.package_id,
          packages.name,
          releases.version,
          packages.description,
          packages.collection_id,
          packages.collection_name,
          releases.package_path,
          releases.lock_path,
          releases.release_path,
          releases.archive_path,
          releases.archive_hash,
          releases.payload_hash,
          releases.publisher_key_id,
          releases.registry_key_id,
          releases.published_at
        from releases
        join packages on packages.id = releases.package_id
        where releases.package_id = ? and releases.version = ?
      `).get(packageId, version) as ReleaseRow | undefined
    : database.prepare(`
        select
          releases.package_id,
          packages.name,
          releases.version,
          packages.description,
          packages.collection_id,
          packages.collection_name,
          releases.package_path,
          releases.lock_path,
          releases.release_path,
          releases.archive_path,
          releases.archive_hash,
          releases.payload_hash,
          releases.publisher_key_id,
          releases.registry_key_id,
          releases.published_at
        from releases
        join packages on packages.id = releases.package_id
        where releases.package_id = ?
        order by releases.published_at desc
        limit 1
      `).get(packageId) as ReleaseRow | undefined;

  if (!row) {
    throw new DkbError(version ? `Unknown registry package version: ${packageId}@${version}` : `Unknown registry package: ${packageId}`);
  }

  if (!row.archive_path || !row.archive_hash) {
    throw new DkbError(`Registry package version has no downloadable ${DKB_PACKAGE_EXTENSION} artifact: ${row.package_id}@${row.version}`);
  }

  return row;
}

function packageSummaryFromRow(row: ReleaseRow): MockRegistryPackageSummary {
  return {
    packageId: row.package_id,
    name: row.name,
    version: row.version,
    ...(row.description ? { description: row.description } : {}),
    ...(row.collection_id ? { collectionId: row.collection_id } : {}),
    ...(row.collection_name ? { collectionName: row.collection_name } : {}),
    receiptPath: row.release_path,
    archivePath: row.archive_path,
    archiveHash: row.archive_hash,
    payloadHash: row.payload_hash,
    publishedAt: row.published_at,
  };
}

function keyRecordFromRow(row: KeyRow): DkbSigningKeyRecord {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    algorithm: 'ed25519',
    publicKeyPem: row.public_key_pem,
    publicKeyFingerprint: row.public_key_fingerprint,
    status: row.status,
    createdAt: row.created_at,
    ...(row.rotated_at ? { rotatedAt: row.rotated_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

async function copyDkbSourceOnly(sourceRoot: string, targetRoot: string): Promise<void> {
  const stat = await fs.stat(sourceRoot);

  if (!stat.isDirectory()) {
    throw new DkbError(`Registry publish source must be a DKB directory: ${sourceRoot}`);
  }

  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (candidate) => !isDkbSystemArtifactPath(sourceRoot, candidate),
  });
}

async function writeRegistryPackageManifest(root: string, dkb: LoadedDkb, publisherId: string): Promise<void> {
  const source = manifestPath(root, 'dkb.json');
  const manifest = await readJsonObject(source);
  const packageName = dependencyNameFor(publisherId, dkb.manifest.id);

  delete manifest.dependencies;

  await fs.writeFile(source, `${JSON.stringify({
    manifestVersion: typeof manifest.manifestVersion === 'number' ? manifest.manifestVersion : 1,
    type: 'package',
    ...manifest,
    name: dkb.manifest.name,
    version: dkb.manifest.version,
    publisher: publisherId,
    package: packageName,
  }, null, 2)}\n`, 'utf8');
}

async function updateRuntimeInstallManifests(root: string, receipt: DkbPackageReceipt, install: {
  archiveHash: string;
  installedPath: string;
}): Promise<void> {
  const rootManifestPath = manifestPath(root, 'dkb.json');
  const rootManifest = await ensureRuntimeProjectManifest(rootManifestPath, root);
  const dependencyName = dependencyNameFor(receipt.publisher.accountId, receipt.package.id);
  const dependencies = {
    ...(isRecord(rootManifest.dependencies) ? rootManifest.dependencies as Record<string, string> : {}),
    [dependencyName]: receipt.package.version,
  };

  await fs.writeFile(rootManifestPath, `${JSON.stringify({
    ...rootManifest,
    dependencies,
  }, null, 2)}\n`, 'utf8');

  const lockPath = manifestPath(root, 'dkb-lock.json');
  const existingLock = await readExistingLock(lockPath);
  const receiptPackage = receipt.payload.lock.packages[receipt.package.id];

  if (!receiptPackage) {
    throw new DkbError(`Package receipt does not contain package lock entry: ${receipt.package.id}`);
  }

  const packages = {
    ...(existingLock?.packages ?? {}),
    [dependencyName]: {
      ...receiptPackage,
      publisher: receipt.publisher.accountId,
      package: dependencyName,
      resolved: `${receipt.registry.registryId}:${receipt.package.id}@${receipt.package.version}`,
      integrity: install.archiveHash,
      archiveHash: install.archiveHash,
      receiptHash: stableHash(receipt),
      packageTreeHash: receipt.payload.packageTreeHash,
      payloadHash: receipt.payloadHash,
      publisherSignature: receipt.publisher,
      registrySignature: receipt.registry,
      installedPath: install.installedPath,
      registryId: receipt.registry.registryId,
      installedAt: new Date().toISOString(),
    },
  };
  const artifacts = await runtimeLockArtifacts(root);
  const recordCount = Object.values(packages).reduce((total, item) => total + item.recordCount, 0);

  await fs.writeFile(lockPath, `${JSON.stringify({
    registry: {
      id: safeId(path.basename(root) || 'runtime'),
      name: String(rootManifest.name ?? titleFromId(path.basename(root) || 'Runtime Registry')),
      version: String(rootManifest.version ?? '0.0.0-local'),
    },
    packages,
    artifacts,
    compiled: {
      path: KR_INDEX_PATH,
      artifactHash: artifacts.krIndex.hash,
      krRepositoryHash: stableHash(packages),
      indexHash: stableHash(artifacts),
      recordCount,
      compiledAt: new Date().toISOString(),
    },
  }, null, 2)}\n`, 'utf8');
}

async function ensureRuntimeProjectManifest(manifestFile: string, root: string): Promise<Record<string, unknown>> {
  const existing = await maybeReadJsonObject(manifestFile);

  if (existing) {
    return {
      version: '0.0.0-local',
      ...existing,
      manifestVersion: typeof existing.manifestVersion === 'number' ? existing.manifestVersion : 1,
      type: 'registry',
      dependencies: isRecord(existing.dependencies) ? existing.dependencies : {},
    };
  }

  return {
    manifestVersion: 1,
    type: 'registry',
    name: titleFromId(path.basename(root) || 'Runtime Registry'),
    version: '0.0.0-local',
    description: 'Local DKB runtime registry.',
    dependencies: {},
  };
}

async function readExistingLock(lockPath: string): Promise<DkbLockManifest | null> {
  try {
    return validateDkbLockManifest(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
  } catch {
    return null;
  }
}

async function runtimeLockArtifacts(root: string): Promise<DkbLockManifest['artifacts']> {
  const krIndexHash = await hashPath(path.join(root, KR_INDEX_PATH));
  const krGraphHash = await hashPath(path.join(root, KR_GRAPH_PATH));
  const krVectorHash = await hashPath(path.join(root, KR_VECTOR_PATH));
  const sourceIndexHash = await hashPath(path.join(root, SOURCE_INDEX_PATH));

  return {
    krIndex: lockArtifact(KR_INDEX_PATH, krIndexHash),
    krGraph: lockArtifact(KR_GRAPH_PATH, krGraphHash),
    krVector: lockArtifact(KR_VECTOR_PATH, krVectorHash),
    sourceIndex: lockArtifact(SOURCE_INDEX_PATH, sourceIndexHash),
  };
}

function lockArtifact(pathValue: string, hash: string | null): DkbLockArtifact {
  return {
    path: pathValue,
    hash,
    status: hash ? 'built' : 'missing',
  };
}

async function verifyPackageArtifacts(root: string, lock: DkbLockManifest): Promise<Array<{
  name: string;
  ok: boolean;
  detail: string;
}>> {
  const artifactEntries = Object.entries(lock.artifacts) as Array<[string, DkbLockArtifact | undefined]>;
  const checks = await Promise.all(artifactEntries.map(async ([name, artifact]) => {
    if (!artifact || artifact.status !== 'built') {
      return {
        name: `artifact.${name}`,
        ok: true,
        detail: `${name} is ${artifact?.status ?? 'not listed'}`,
      };
    }

    const target = safePackageFilePath(root, artifact.path);
    const actualHash = await hashPath(target);
    const ok = actualHash === artifact.hash;

    return {
      name: `artifact.${name}`,
      ok,
      detail: ok ? `${name} hash matches lockfile` : `${name} hash mismatch: expected ${artifact.hash}, got ${actualHash}`,
    };
  }));

  if (lock.compiled?.path && lock.compiled.artifactHash) {
    const target = safePackageFilePath(root, lock.compiled.path);
    const actualHash = await hashPath(target);
    const ok = actualHash === lock.compiled.artifactHash;

    checks.push({
      name: 'artifact.compiled',
      ok,
      detail: ok ? 'compiled artifact hash matches lockfile' : `compiled artifact hash mismatch: expected ${lock.compiled.artifactHash}, got ${actualHash}`,
    });
  }

  return checks;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);

    if (entry.isDirectory()) {
      return listFiles(target);
    }

    return entry.isFile() ? [target] : [];
  }));

  return nested.flat().sort((left, right) => left.localeCompare(right));
}

async function verifyExtractedPackage(root: string, trustedKeys: DkbSigningKeyRecord[], lockLabel: string): Promise<MockRegistryVerifyResult> {
  const receiptPath = path.join(root, DKB_PACKAGE_RECEIPT_PATH);
  const receipt = parsePackageReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')), receiptPath);
  const lock = receipt.payload.lock;
  const packageId = packageIdFromLock(lock);
  const version = receipt.payload.lock.packages[packageId]?.version ?? receipt.package.version;
  const payloadMatchesLock = stableHash(packageReceiptPayloadForLock(lock, receipt.payload.packageTreeHash)) === receipt.payloadHash
    && canonicalJson(lock) === canonicalJson(receipt.payload.lock);
  const artifactChecks = await verifyPackageArtifacts(root, lock);
  const packageTreeHash = receipt.payload.packageTreeHash ?? null;
  const actualPackageTreeHash = packageTreeHash ? await hashPackageTree(root) : null;
  const packageTreeMatches = !packageTreeHash || actualPackageTreeHash === packageTreeHash;
  const signatureVerification = await verifyPackageReceipt(receipt, ({ role, signature }) => {
    const key = trustedKeys.find((candidate) => candidate.id === signature.keyId && candidate.subjectType === role);

    if (!key || key.status === 'revoked') {
      return null;
    }

    return key.publicKeyPem;
  });

  return {
    ok: payloadMatchesLock && packageTreeMatches && artifactChecks.every((check) => check.ok) && signatureVerification.ok,
    packageId,
    version,
    checks: [
      {
        name: 'payload_matches_lock',
        ok: payloadMatchesLock,
        detail: payloadMatchesLock ? `receipt payload matches ${lockLabel}` : `receipt payload differs from ${lockLabel}`,
      },
      {
        name: 'package_tree_hash',
        ok: packageTreeMatches,
        detail: packageTreeMatches ? 'package tree hash matches receipt' : `package tree hash mismatch: expected ${packageTreeHash}, got ${actualPackageTreeHash}`,
      },
      ...artifactChecks,
      ...signatureVerification.checks,
    ],
  };
}

function packageIdFromLock(lock: DkbLockManifest): string {
  const packageIds = Object.keys(lock.packages);

  if (packageIds.length !== 1) {
    throw new DkbError(`Registry package receipt must contain exactly one DKB package, found ${packageIds.length}.`);
  }

  return packageIds[0]!;
}

async function installedPackageRoots(stateRoot: string, packageId: string): Promise<string[]> {
  try {
    const registry = await loadRegistry(stateRoot);
    const dkbs = [
      ...registry.collections.flatMap((collection) => collection.dkbs),
      ...registry.dkbs,
    ];

    return dkbs
      .filter((dkb) => dkb.manifest.id === packageId)
      .map((dkb) => dkb.root);
  } catch {
    return [];
  }
}

function runtimeVendorPackagePath(stateRoot: string, receipt: DkbPackageReceipt, packageId: string, version: string): string {
  void version;

  return path.join(
    path.resolve(stateRoot),
    'vendor',
    safeId(receipt.publisher.accountId),
    safeId(packageId),
  );
}

function packageArchiveFileName(packageId: string, version: string): string {
  return `${safeId(packageId)}-${safeId(version)}${DKB_PACKAGE_EXTENSION}`;
}

async function hashPath(target: string): Promise<string | null> {
  try {
    const stat = await fs.stat(target);

    if (stat.isDirectory()) {
      const files = await listFiles(target);
      const hashed = await Promise.all(files.map(async (file) => ({
        path: path.relative(target, file).replace(/\\/g, '/'),
        hash: await hashPath(file),
      })));

      return stableHash(hashed);
    }

    return `sha256:${createHashForBuffer(await fs.readFile(target))}`;
  } catch {
    return null;
  }
}

async function hashRequiredPath(target: string): Promise<string> {
  const hash = await hashPath(target);

  if (!hash) {
    throw new DkbError(`Unable to hash package artifact: ${target}`);
  }

  return hash;
}

async function hashPackageTree(root: string): Promise<string> {
  const files = (await listFiles(root))
    .map((file) => path.relative(root, file).replace(/\\/g, '/'))
    .filter((relative) => relative !== DKB_PACKAGE_RECEIPT_PATH)
    .sort((left, right) => left.localeCompare(right));
  const entries = await Promise.all(files.map(async (relative) => ({
    path: relative,
    hash: await hashRequiredPath(path.join(root, relative)),
  })));

  return stableHash(entries);
}

async function readJsonObject(source: string): Promise<Record<string, unknown>> {
  const value = await maybeReadJsonObject(source);

  if (!value) {
    throw new DkbError(`Expected JSON object at ${source}`);
  }

  return value;
}

async function maybeReadJsonObject(source: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(source, 'utf8')) as unknown;

    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function createHashForBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function safePackageFilePath(root: string, relativeFile: string): string {
  const target = path.resolve(root, relativeFile);
  const resolvedRoot = path.resolve(root);

  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new DkbError(`Package file escapes package root: ${relativeFile}`);
  }

  return target;
}

function isDkbSystemArtifactPath(sourceRoot: string, candidate: string): boolean {
  const relative = path.relative(sourceRoot, candidate);

  if (!relative) {
    return false;
  }

  const parts = relative.split(path.sep);
  const name = path.basename(candidate);

  return parts.includes('.dkb') || name === 'dkb-lock.json' || name === 'dkb-release.json' || name === DKB_PACKAGE_RECEIPT_PATH;
}

function dependencyNameFor(publisherId: string, packageId: string): string {
  return `@${safeId(publisherId)}/${safeId(packageId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'dkb';
}

function titleFromId(value: string): string {
  return value
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || value;
}
