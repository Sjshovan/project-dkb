import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stableHash, stableStringify } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { captureFileSnapshot, assertFileSnapshotCurrent, type FileSnapshot } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { isPluginId } from './config.js';
import { DKB_PLUGIN_API_VERSION, type DkbProviderIntegrityReceipt } from './types.js';
import {
  BUNDLED_INTEGRITY_RECEIPT_PATH,
  dependencyIntegrity,
  dependencyIntegrityInputs,
  packageFilesInclude,
  shippedPackageFileHashes,
  type ShippedPackageFileHash,
} from './dependencyIntegrity.js';

export const DKB_BUNDLED_INTEGRITY_FORMAT = 'dkb.provider-integrity.v1';
export const DKB_BUNDLED_INTEGRITY_PATH = BUNDLED_INTEGRITY_RECEIPT_PATH;
export const DKB_BUNDLED_INTEGRITY_MAX_BYTES = 2 * 1024 * 1024;

export type DkbBundledIntegrityIdentity = Pick<DkbProviderIntegrityReceipt,
  'apiVersion' | 'id' | 'version' | 'protocols' | 'artifactFormats'>;

export interface DkbBundledIntegrityOptions {
  packageRoot: string;
  /** Absolute or package-relative ordinary file; the receipt always stores a portable relative path. */
  entrypoint: string;
  identity: DkbBundledIntegrityIdentity;
}

/** Pre-import verification reads identity from the bounded receipt, never executable code. */
export type DkbBundledIntegrityVerificationOptions = Omit<DkbBundledIntegrityOptions, 'identity'> & {
  identity?: DkbBundledIntegrityIdentity;
};

export interface DkbBundledIntegrityReceipt extends DkbBundledIntegrityIdentity {
  format: typeof DKB_BUNDLED_INTEGRITY_FORMAT;
  packageName: string;
  packageVersion: string;
  entrypoint: string;
  files: ShippedPackageFileHash[];
  filesDigest: string;
  dependencyDigest: string;
}

type DependencyCache = Map<string, Promise<string>>;
type PackageContext = {
  root: string;
  manifestText: string;
  packageName: string;
  packageVersion: string;
  entrypoint: string;
};

/** Build-time attestation only: no plugin setup, runtime options, secrets, or live service identities. */
export async function createBundledIntegrityReceipt(
  options: DkbBundledIntegrityOptions,
  dependencyCache?: DependencyCache,
): Promise<DkbBundledIntegrityReceipt> {
  const identity = normalizedIdentity(options.identity);
  const context = await packageContext(options);
  const inputs = (await dependencyIntegrityInputs(context.root, true)).sort();
  const observation = await captureFileSnapshot(inputs);
  const files = await shippedPackageFileHashes(context.root);
  if (!files?.length || !files.some((file) => file.path === context.entrypoint)) {
    throw failure('The provider entrypoint must be included in its explicit package files allowlist.');
  }
  const receipt: DkbBundledIntegrityReceipt = {
    format: DKB_BUNDLED_INTEGRITY_FORMAT,
    ...identity,
    packageName: context.packageName,
    packageVersion: context.packageVersion,
    entrypoint: context.entrypoint,
    files,
    filesDigest: stableHash(files),
    dependencyDigest: await dependencyIntegrity(context.root, dependencyCache),
  };
  const current = await packageContext(options);
  if (current.root !== context.root || current.manifestText !== context.manifestText
    || current.entrypoint !== context.entrypoint
    || stableStringify((await dependencyIntegrityInputs(context.root, true)).sort()) !== stableStringify(inputs)) {
    throw failure('Provider package inputs changed while generating their integrity identity.');
  }
  await assertFileSnapshotCurrent(observation);
  validateReceipt(receipt);
  serializedReceipt(receipt);
  return receipt;
}

/** Atomically replace only the generated receipt, preserving its mtime when bytes are unchanged. */
export async function writeBundledIntegrityReceipt(
  options: DkbBundledIntegrityOptions,
  dependencyCache?: DependencyCache,
): Promise<DkbBundledIntegrityReceipt> {
  const receipt = await createBundledIntegrityReceipt(options, dependencyCache);
  const root = await fs.realpath(options.packageRoot);
  const target = path.join(root, DKB_BUNDLED_INTEGRITY_PATH);
  const bytes = serializedReceipt(receipt);
  await assertOrdinaryPath(root, target, true);
  try {
    if ((await readBounded(target, true))?.equals(bytes)) return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await assertOrdinaryPath(root, target, true);
  // A sibling temporary file cannot accidentally enter this package's shipped inventory.
  const temporary = path.join(path.dirname(root), `.${path.basename(root)}-provider-integrity-${randomUUID()}.tmp`);
  let ownsTemporary = false;
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary, target);
  } finally {
    if (ownsTemporary) await fs.rm(temporary, { force: true });
  }
  return receipt;
}

/** Verify a shipped baseline against installed bytes. Never regenerate a missing or stale receipt. */
export async function verifyBundledIntegrityReceipt(
  options: DkbBundledIntegrityVerificationOptions,
  dependencyCache?: DependencyCache,
): Promise<DkbBundledIntegrityReceipt> {
  const root = await fs.realpath(options.packageRoot);
  const target = path.join(root, DKB_BUNDLED_INTEGRITY_PATH);
  let receipt: DkbBundledIntegrityReceipt;
  let observation: FileSnapshot;
  try {
    await assertOrdinaryPath(root, target);
    observation = await captureFileSnapshot([target]);
    const bytes = await readBounded(target);
    receipt = validateReceipt(JSON.parse(bytes!.toString('utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw failure(`Bundled provider integrity receipt is missing at ${DKB_BUNDLED_INTEGRITY_PATH}. Rebuild the provider package with its locked dependencies.`);
    }
    if (error instanceof DkbError) throw error;
    throw failure('Bundled provider integrity receipt is not valid JSON. Rebuild the provider package with its locked dependencies.');
  }
  const expected = await createBundledIntegrityReceipt({
    ...options,
    identity: options.identity ?? {
      apiVersion: receipt.apiVersion, id: receipt.id, version: receipt.version,
      protocols: receipt.protocols, artifactFormats: receipt.artifactFormats,
    },
  }, dependencyCache);
  if (stableStringify(receipt) !== stableStringify(expected)) {
    throw failure(`Bundled provider ${expected.id} integrity receipt does not match its installed identity, shipped files, or declared dependency closure. Rebuild the provider package with its locked dependencies.`);
  }
  await assertFileSnapshotCurrent(observation);
  return receipt;
}

async function packageContext(options: DkbBundledIntegrityOptions): Promise<PackageContext> {
  const root = await fs.realpath(options.packageRoot);
  if (!(await fs.stat(root)).isDirectory()) throw failure('Provider package root must be a directory.');
  const manifestPath = path.join(root, 'package.json');
  await assertOrdinaryPath(root, manifestPath);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  let manifest: Record<string, unknown>;
  try { manifest = object(JSON.parse(manifestText), 'package.json'); } catch {
    throw failure('Provider package.json must be a JSON object.');
  }
  if (!validName(manifest.name) || !validText(manifest.version, 128)) {
    throw failure('Provider package.json requires a valid name and version.');
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length
    || manifest.files.some((value) => !validText(value, 2048))) {
    throw failure('Bundled providers require an explicit, nonempty package files allowlist.');
  }
  if (!packageFilesInclude(DKB_BUNDLED_INTEGRITY_PATH, manifest.files as string[])) {
    throw failure(`The package files allowlist must ship ${DKB_BUNDLED_INTEGRITY_PATH}.`);
  }
  const originalRoot = path.resolve(options.packageRoot);
  const relative = path.relative(originalRoot, path.resolve(originalRoot, options.entrypoint)).replace(/\\/gu, '/');
  if (!portablePath(relative) || relative === DKB_BUNDLED_INTEGRITY_PATH) {
    throw failure('Provider entrypoint must be an ordinary, contained package-relative file.');
  }
  await assertOrdinaryPath(root, path.join(root, relative));
  return { root, manifestText, packageName: manifest.name, packageVersion: manifest.version, entrypoint: relative };
}

async function assertOrdinaryPath(root: string, target: string, allowMissing = false): Promise<void> {
  const relative = path.relative(root, target);
  if (!portablePath(relative.replace(/\\/gu, '/'))) throw failure('Provider integrity paths must remain inside the package.');
  const parts = relative.split(path.sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw failure('Provider entrypoints and integrity receipts must use ordinary contained files and directories, never symlinks.');
    }
  }
}

async function readBounded(filename: string, skipOversized = false): Promise<Buffer | null> {
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw failure('Provider integrity receipt must be an ordinary file.');
    if (stat.size > DKB_BUNDLED_INTEGRITY_MAX_BYTES) {
      if (skipOversized) return null;
      throw failure('Provider integrity receipt exceeds the 2 MiB size limit.');
    }
    const bytes = Buffer.alloc(Math.min(stat.size + 1, DKB_BUNDLED_INTEGRITY_MAX_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size || length > DKB_BUNDLED_INTEGRITY_MAX_BYTES) throw failure('Provider integrity receipt changed size while being read.');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

function normalizedIdentity(value: DkbBundledIntegrityIdentity): DkbBundledIntegrityIdentity {
  const identity = object(value, 'identity');
  exactKeys(identity, ['apiVersion', 'id', 'version', 'protocols', 'artifactFormats']);
  if (identity.apiVersion !== DKB_PLUGIN_API_VERSION || typeof identity.id !== 'string' || !isPluginId(identity.id)
    || !validText(identity.version, 128)) throw failure('Provider integrity identity requires API v3, a namespaced plugin ID, and a version.');
  return {
    apiVersion: DKB_PLUGIN_API_VERSION, id: identity.id, version: identity.version,
    protocols: stringSet(identity.protocols), artifactFormats: stringSet(identity.artifactFormats),
  };
}

function validateReceipt(value: unknown): DkbBundledIntegrityReceipt {
  const receipt = object(value, 'receipt');
  exactKeys(receipt, ['format', 'apiVersion', 'id', 'version', 'packageName', 'packageVersion', 'entrypoint', 'files', 'filesDigest', 'dependencyDigest', 'protocols', 'artifactFormats']);
  const identity = normalizedIdentity({ apiVersion: receipt.apiVersion, id: receipt.id, version: receipt.version, protocols: receipt.protocols, artifactFormats: receipt.artifactFormats } as DkbBundledIntegrityIdentity);
  if (receipt.format !== DKB_BUNDLED_INTEGRITY_FORMAT || !validName(receipt.packageName) || !validText(receipt.packageVersion, 128)
    || !portablePath(receipt.entrypoint) || !Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 10_000
    || typeof receipt.filesDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(receipt.filesDigest)
    || typeof receipt.dependencyDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(receipt.dependencyDigest)
    || stableStringify(identity.protocols) !== stableStringify(receipt.protocols)
    || stableStringify(identity.artifactFormats) !== stableStringify(receipt.artifactFormats)) throw failure('Provider integrity receipt schema is invalid.');
  let previous = '';
  for (const item of receipt.files) {
    const file = object(item, 'file');
    exactKeys(file, ['path', 'hash']);
    if (!portablePath(file.path) || file.path === DKB_BUNDLED_INTEGRITY_PATH || file.path <= previous
      || typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(file.hash)) throw failure('Provider integrity file inventory must contain sorted unique portable paths and SHA-256 hashes.');
    previous = file.path;
  }
  const files = receipt.files as ShippedPackageFileHash[];
  if (!files.some((file) => file.path === receipt.entrypoint) || !files.some((file) => file.path === 'package.json')
    || stableHash(files) !== receipt.filesDigest) throw failure('Provider integrity file inventory digest or entrypoint is invalid.');
  return receipt as unknown as DkbBundledIntegrityReceipt;
}

function serializedReceipt(receipt: DkbBundledIntegrityReceipt): Buffer {
  const bytes = Buffer.from(`${stableStringify(receipt)}\n`, 'utf8');
  if (bytes.length > DKB_BUNDLED_INTEGRITY_MAX_BYTES) throw failure('Provider integrity receipt exceeds the 2 MiB size limit.');
  return bytes;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(`Provider integrity ${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    throw failure('Provider integrity contains missing or unsupported fields.');
  }
}

function stringSet(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => !validText(item, 160))) {
    throw failure('Provider integrity protocols and artifact formats must be bounded arrays of nonempty strings.');
  }
  return [...new Set(value as string[])].sort();
}

function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validName(value: unknown): value is string {
  return validText(value, 214) && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function portablePath(value: unknown): value is string {
  return validText(value, 2048) && !/[\\:]/u.test(value) && !value.startsWith('/')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/u.test(part));
}

function failure(message: string): DkbError { return new DkbError(message, 'bundled_integrity_invalid'); }
