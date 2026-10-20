import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import { containsSensitiveCorpusContent, isSensitiveCorpusPath } from './lib/corpus-sanitizer.mjs';
import { proofStackLibraryRoot } from './lib/disposable-stack.mjs';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repositoryRoot, 'apps', 'cli', 'dist', 'cli', 'index.js');
const sourceRoot = path.resolve(required(process.env.DKB_REAL_CORPUS_ROOT, 'DKB_REAL_CORPUS_ROOT'));
const stackName = process.env.DKB_STACK_NAME ?? process.argv[2] ?? 'preview-gate';
const stackStateRoot = path.resolve(process.env.DKB_STACK_STATE_ROOT ?? path.join(os.homedir(), '.dkb', 'stacks'));
const stackRoot = path.join(stackStateRoot, stackName);
const stackEnvironment = parseEnvironment(await fs.readFile(path.join(stackRoot, 'stack.env'), 'utf8'));
const registryUrl = `http://127.0.0.1:${stackEnvironment.DKB_REGISTRY_PORT}`;
const runtimeUrl = `http://127.0.0.1:${stackEnvironment.DKB_RUNTIME_PORT}`;
const libraryRoot = proofStackLibraryRoot(stackRoot, stackEnvironment);
const namespace = required(stackEnvironment.DKB_REGISTRY_BOOTSTRAP_NAMESPACE, 'Registry bootstrap namespace');
const registryToken = required(stackEnvironment.DKB_REGISTRY_BOOTSTRAP_TOKEN, 'Registry bootstrap token');
const runtimeAdminToken = required(stackEnvironment.DKB_RUNTIME_ADMIN_TOKEN, 'Runtime admin token');
const runtimeReadToken = required(stackEnvironment.DKB_RUNTIME_READ_TOKEN, 'Runtime read token');
const mcpToken = required(stackEnvironment.DKB_MCP_BEARER_TOKEN, 'MCP bearer token');
const packageId = `@${namespace}/assembly-toolbox-jd-proof`;
const resumedVersion = process.env.DKB_REAL_CORPUS_RESUME_VERSION;
const version = resumedVersion ?? process.env.DKB_REAL_CORPUS_VERSION ?? `0.0.${Math.floor(Date.now() / 1000)}`;
const proofRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-real-corpus-'));
const packageRoot = path.join(proofRoot, 'package');
const client = new DkbRegistryClient({ baseUrl: registryUrl, token: registryToken });
let currentStep = 'startup';

const corpusMode = process.env.DKB_REAL_CORPUS_SCOPE === 'full' ? 'full' : 'architecture';
const allowedRoots = corpusMode === 'full'
  ? ['app', 'routes', path.join('database', 'migrations'), 'config']
  : [path.join('app', 'Providers'), path.join('app', 'Services', 'Module'), 'routes', 'config'];
const allowedTopLevelFiles = ['composer.json'];
const allowedExtensions = new Set(['.php', '.json', '.js', '.ts', '.vue', '.xml', '.yml', '.yaml', '.ini', '.conf']);
const queries = [
  { query: 'How does ModuleServiceProvider register ModuleManager?', expected: 'ModuleManager' },
  { query: 'Which class is responsible for registering application routes?', expected: 'RouteServiceProvider' },
  { query: 'Which Composer package provides Laravel MongoDB integration?', expected: 'mongodb/laravel-mongodb' },
];

try {
  let corpus;

  if (resumedVersion) {
    step(`resume signed release ${packageId}@${version}`);
    corpus = { mode: corpusMode, resumedRelease: true };
  } else {
    step('create sanitized external corpus copy');
    const copy = await copySanitizedCorpus();
    assert.ok(copy.includedFiles > 100, `sanitized corpus unexpectedly contains only ${copy.includedFiles} files`);
    assert.ok(copy.includedBytes > 100_000, `sanitized corpus unexpectedly contains only ${copy.includedBytes} bytes`);
    await fs.writeFile(path.join(packageRoot, 'dkb.json'), `${JSON.stringify({
      manifestVersion: 1,
      type: 'dkb',
      name: packageId,
      displayName: 'Assembly Toolbox JD Proof',
      version,
      permissions: { read: true, write: false },
    }, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(packageRoot, 'sources', '_dkb-import-summary.json'), `${JSON.stringify({
      project: 'AssemblyToolboxJD',
      scope: corpusMode === 'full'
        ? ['application source', 'routes', 'configuration', 'database migrations', 'Composer manifest']
        : ['service providers', 'module architecture', 'routes', 'configuration', 'Composer manifest'],
      includedFiles: copy.includedFiles,
      includedBytes: copy.includedBytes,
      excludedSensitiveFiles: copy.excludedSensitiveFiles,
      excludedOversizedFiles: copy.excludedOversizedFiles,
    }, null, 2)}\n`, 'utf8');

    step(`publish private ${packageId}@${version}`);
    await runCli(['publish', packageRoot, '--url', registryUrl]);
    corpus = { mode: corpusMode, ...copy };
  }
  const releaseBefore = await client.packageRelease(packageId, version);

  step('install signed real-corpus release through Runtime');
  await runCli(['install', packageId, '--version', version, '--url', registryUrl, '--runtime-url', runtimeUrl, '--library', libraryRoot, '--force']);
  for (const query of queries) await assertRetrieved(query.query, query.expected, true);

  step('verify real-corpus MCP search and fetch');
  const searched = await mcpTool('search', { query: queries[0].query, limit: 5 }, 1);
  const results = searched.result.structuredContent.results;
  const matchingResult = results.find((item) => JSON.stringify(item).includes(queries[0].expected));
  assert.ok(matchingResult, `MCP search did not return ${queries[0].expected}`);
  const fetched = await mcpTool('fetch', { id: matchingResult.id }, 2);
  assert.match(JSON.stringify(fetched), /ModuleManager/u);
  assert.doesNotMatch(JSON.stringify(fetched), /PWNED/u);

  step('uninstall real corpus and verify evidence disappearance');
  await runCli(['uninstall', packageId, '--library', libraryRoot, '--url', runtimeUrl]);
  for (const query of queries) await assertRetrieved(query.query, query.expected, false);

  step('reinstall real corpus without compilation');
  await runCli(['install', packageId, '--version', version, '--url', registryUrl, '--runtime-url', runtimeUrl, '--library', libraryRoot]);
  const releaseAfter = await client.packageRelease(packageId, version);
  assert.equal(releaseAfter.archiveHash, releaseBefore.archiveHash);
  assert.equal(releaseAfter.packageTreeHash, releaseBefore.packageTreeHash);
  for (const query of queries) await assertRetrieved(query.query, query.expected, true);

  console.log(JSON.stringify({
    ok: true,
    stack: stackName,
    package: `${packageId}@${version}`,
    corpus,
    checks: {
      privateRegistryCompilation: true,
      signedRuntimeInstall: true,
      retrieval: `${queries.length}/${queries.length}`,
      mcpSearchFetch: true,
      uninstallDisappearance: true,
      reinstallWithoutCompilation: true,
      sensitiveFilesExcluded: true,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    stack: stackName,
    step: currentStep,
    error: error instanceof Error ? error.message : String(error),
    ...(typeof error?.stdout === 'string' && error.stdout.trim() ? { commandOutput: error.stdout.trim() } : {}),
    ...(typeof error?.stderr === 'string' && error.stderr.trim() ? { commandError: error.stderr.trim() } : {}),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await fs.rm(proofRoot, { recursive: true, force: true });
}

async function copySanitizedCorpus() {
  const candidates = [
    ...await Promise.all(allowedRoots.map((relative) => listFiles(path.join(sourceRoot, relative)))),
    ...allowedTopLevelFiles.map((relative) => path.join(sourceRoot, relative)),
  ].flat();
  let includedFiles = 0;
  let includedBytes = 0;
  let excludedSensitiveFiles = 0;
  let excludedOversizedFiles = 0;

  for (const source of candidates.sort((left, right) => left.localeCompare(right))) {
    const relative = path.relative(sourceRoot, source).replace(/\\/gu, '/');
    if (isSensitiveCorpusPath(relative) || !allowedExtensions.has(path.extname(source).toLowerCase())) continue;
    const stat = await fs.stat(source);
    if (stat.size > 512 * 1024) {
      excludedOversizedFiles += 1;
      continue;
    }
    const contents = await fs.readFile(source);
    const text = contents.toString('utf8');
    if (containsSensitiveCorpusContent(text)) {
      excludedSensitiveFiles += 1;
      continue;
    }
    const destination = path.join(packageRoot, 'sources', 'project', relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
    includedFiles += 1;
    includedBytes += contents.length;
  }
  return { includedFiles, includedBytes, excludedSensitiveFiles, excludedOversizedFiles };
}

async function listFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return listFiles(target);
    return entry.isFile() ? [target] : [];
  }));
  return nested.flat();
}

async function runCli(args) {
  const { stdout } = await executeFile(process.execPath, [cliPath, '--json', ...args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DKB_REGISTRY_TOKEN: registryToken,
      DKB_RUNTIME_ADMIN_TOKEN: runtimeAdminToken,
      DKB_RUNTIME_READ_TOKEN: runtimeReadToken,
      DKB_RUNTIME_CREDENTIALS_ROOT: path.join(proofRoot, 'runtime-credentials'),
      DKB_REGISTRY_PUBLISH_TIMEOUT_MS: process.env.DKB_REGISTRY_PUBLISH_TIMEOUT_MS ?? String(65 * 60_000),
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 70 * 60_000,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

async function assertRetrieved(query, expected, present) {
  const response = await fetch(`${runtimeUrl}/api/retrieve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${runtimeReadToken}` },
    redirect: 'error',
    body: JSON.stringify({ need: query, phrases: [expected], intent: 'evidence', limit: 8 }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const found = JSON.stringify(body.evidence).includes(expected);
  assert.equal(found, present, `${expected} presence was ${found}, expected ${present}`);
  if (present) assert.equal(body.sufficiency?.matchedNeed, true);
}

async function mcpTool(name, args, id) {
  const response = await fetch(`${runtimeUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${mcpToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.error, undefined, JSON.stringify(body));
  return body;
}

function parseEnvironment(source) {
  return Object.fromEntries(source.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const separator = trimmed.indexOf('=');
    return separator > 0 ? [[trimmed.slice(0, separator), trimmed.slice(separator + 1)]] : [];
  }));
}

function required(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function step(value) {
  currentStep = value;
  console.log(JSON.stringify({ event: 'proof.step', step: value }));
}
