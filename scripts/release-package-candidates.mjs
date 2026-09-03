import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { distributableWorkspaces } from './package-policy.mjs';
import { inspectPackageArchive, installedNpmCli } from './package-distribution.mjs';

const executeFile = promisify(execFile);
const registry = 'https://npm.pkg.github.com';

async function verifyArchiveBytes(archive, candidate) {
  const stat = await fs.lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.size) {
    throw new Error(`Candidate must be an unchanged regular archive: ${candidate.filename}`);
  }
  const sha512 = createHash('sha512');
  const sha1 = createHash('sha1');
  for await (const bytes of createReadStream(archive)) {
    sha512.update(bytes);
    sha1.update(bytes);
  }
  if (`sha512-${sha512.digest('base64')}` !== candidate.integrity || sha1.digest('hex') !== candidate.shasum) {
    throw new Error(`Candidate archive integrity mismatch: ${candidate.filename}. Rebuild and review the candidate set.`);
  }
}

/** The complete candidate set is checked before the first publication call. */
export async function verifyPackageCandidates(directory) {
  const root = await fs.realpath(directory);
  const manifestPath = path.join(root, 'candidates.json');
  const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Candidate manifest must be a bounded regular JSON file.');
  const document = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (document.status !== 'packed' || !Array.isArray(document.packages) || document.packages.length !== distributableWorkspaces.length) {
    throw new Error(`Candidate set must contain all ${distributableWorkspaces.length} distributable workspaces.`);
  }
  const names = new Set();
  const filenames = new Set();
  const packages = [];
  for (const candidate of document.packages) {
    if (!candidate || !distributableWorkspaces.includes(candidate.name) || names.has(candidate.name)) {
      throw new Error('Candidate set contains an unknown or duplicate workspace.');
    }
    if (typeof candidate.filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u.test(candidate.filename) || filenames.has(candidate.filename)) {
      throw new Error(`Candidate has an unsafe or duplicate filename: ${candidate.name}`);
    }
    if (typeof candidate.version !== 'string' || !candidate.version || typeof candidate.private !== 'boolean'
      || !Number.isSafeInteger(candidate.size) || candidate.size <= 0
      || typeof candidate.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(candidate.integrity)
      || typeof candidate.shasum !== 'string' || !/^[a-f0-9]{40}$/u.test(candidate.shasum)) {
      throw new Error(`Candidate metadata is invalid: ${candidate.name}`);
    }
    names.add(candidate.name);
    filenames.add(candidate.filename);
    const archive = path.join(root, candidate.filename);
    await verifyArchiveBytes(archive, candidate);
    const { manifest, paths } = await inspectPackageArchive(archive);
    if (new Set(paths).size !== paths.length) throw new Error(`Candidate contains duplicate archive entries: ${candidate.filename}`);
    if (manifest.name !== candidate.name || manifest.version !== candidate.version || (manifest.private === true) !== candidate.private) {
      throw new Error(`Candidate manifest does not match its archive: ${candidate.filename}`);
    }
    if (manifest.private !== undefined && typeof manifest.private !== 'boolean') throw new Error(`Invalid private flag in ${candidate.filename}`);
    if (manifest.publishConfig?.registry && manifest.publishConfig.registry.replace(/\/$/u, '') !== registry) {
      throw new Error(`Candidate declares a non-GitHub package registry: ${candidate.name}`);
    }
    packages.push({ ...candidate, archive, manifest });
  }
  const unexpected = (await fs.readdir(root)).filter(name => name !== 'candidates.json' && !filenames.has(name));
  if (unexpected.length) throw new Error(`Candidate directory contains unlisted files: ${unexpected.join(', ')}`);
  const byName = new Map(packages.map(candidate => [candidate.name, candidate]));
  for (const candidate of packages) {
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(candidate.manifest[kind] ?? {})) {
        if (!name.startsWith('@sjshovan/dkb-')) continue;
        if (!byName.has(name) || byName.get(name).version !== version) {
          throw new Error(`${candidate.name} requires ${name}@${version}, but no exact dependency candidate exists.`);
        }
      }
    }
  }
  // Use the reviewed distribution order, not caller-controlled JSON order.
  return distributableWorkspaces.map(name => byName.get(name));
}

export async function releasePackageCandidates({ directory, publish = false, npmCli, execute = executeFile }) {
  const packages = await verifyPackageCandidates(directory);
  const blocked = packages.filter(candidate => candidate.private).map(candidate => candidate.name);
  if (!publish) return { status: 'verified', packages: packages.length, publicationBlockedBy: blocked };
  if (blocked.length) {
    throw new Error(`Publication blocked before any upload: required packages are marked private:true: ${blocked.join(', ')}. `
      + 'A separate publication-policy decision and newly built, reviewed candidates are required. Do not strip flags or skip dependencies.');
  }
  npmCli ??= await installedNpmCli();
  const published = [];
  for (const candidate of packages) {
    try {
      // Recheck immediately before use; never repack or run package scripts.
      await verifyArchiveBytes(candidate.archive, candidate);
      await execute(process.execPath, [npmCli, 'publish', candidate.archive, '--ignore-scripts',
        `--registry=${registry}`, '--access=restricted', '--tag=preview'], {
        cwd: path.dirname(candidate.archive), shell: false, windowsHide: true,
        timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      });
      published.push(`${candidate.name}@${candidate.version}`);
    } catch (error) {
      throw new Error(`Publication stopped at ${candidate.name}@${candidate.version} after ${published.length}/${packages.length} successful uploads. `
        + `Publication is not atomic; reconcile the exact candidate digests before retrying. Published: ${published.join(', ') || 'none'}. `
        + `Failure: ${error.code ?? error.message}`, { cause: error });
    }
  }
  return { status: 'published', packages: published };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args[0] !== '--directory' || !args[1] || (args.length !== 2 && !(args.length === 3 && args[2] === '--publish'))) {
      throw new Error('Usage: node scripts/release-package-candidates.mjs --directory <candidate-directory> [--publish]');
    }
    console.log(JSON.stringify(await releasePackageCandidates({ directory: args[1], publish: args[2] === '--publish' }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
