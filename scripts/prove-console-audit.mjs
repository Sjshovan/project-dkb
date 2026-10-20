import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Real local data for paired Console review; no Docker, Registry publication,
// browser automation, global CLI installation, or existing host state changes.
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-console-review-'));
const libraryRoot = path.join(root, 'library');
const stateRoot = path.join(root, 'runtime');
const cli = path.join(repositoryRoot, 'apps', 'cli', 'dist', 'cli', 'index.js');
const pipeline = 'minisearch-lexical';
const cleanup = [];

for (const key of Object.keys(process.env)) if (key.startsWith('DKB_')) delete process.env[key];
Object.assign(process.env, {
  DKB_GLOBAL_ROOT: path.join(root, 'global'),
  DKB_CLI_CONFIG: path.join(root, 'global', 'config.json'),
  DKB_HOST_INVENTORY: path.join(root, 'host.json'),
  DKB_CONSOLE_STATE_ROOT: path.join(root, 'console'),
  DKB_RUNTIME_STATE_ROOT: stateRoot,
  DKB_RUNTIME_CREDENTIALS_ROOT: path.join(root, 'runtime-credentials'),
  DKB_LIBRARY_PATH: libraryRoot,
  DKB_MCP_HTTP_ENABLED: 'false',
});

try {
  await writeJson(process.env.DKB_CLI_CONFIG, { format: 'dkb.config.v2' });
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Console review knowledge', roots: {} });
  await fs.mkdir(path.join(libraryRoot, '.dkb'), { recursive: true });
  const { compileComposeProject } = await import('@sjshovan/dkb-compiler/compile.js');
  const { addLibraryRoot, removeLibraryRoot } = await import('@sjshovan/dkb-library/resolver.js');
  const { DEFAULT_DKB_RUNTIME_CONTEXT: runtime } = await import('@sjshovan/dkb-runtime/defaultComposition.js');
  const { ensureRuntimeState } = await import('@sjshovan/dkb-runtime/runtime/state.js');
  const { switchRuntimePipelineFromRegistry } = await import('@sjshovan/dkb-runtime/runtime/pipelineSwitch.js');
  const { searchRuntime, readRuntime } = await import('@sjshovan/dkb-runtime/runtime/queryAccess.js');
  const { closeQueryContext } = await import('@sjshovan/dkb-runtime/runtime/queryCache.js');
  const { listQueryAudit, closeQueryAuditQueue } = await import('@sjshovan/dkb-runtime/runtime/queryAudit.js');
  const { serveDkbRuntime } = await import('@sjshovan/dkb-runtime/runtime/server.js');
  const { prepareRuntimeHttpCredentials } = await import('@sjshovan/dkb-cli/dist/host/runtimeCredentials.js');
  const { startDkbConsoleServer } = await import('@sjshovan/dkb-console');
  cleanup.push(() => closeQueryContext(stateRoot), closeQueryAuditQueue);

  await runCli(['library', 'register', libraryRoot, '--name', 'review-library']);
  await runCli(['library', 'use', 'review-library']);
  await runCli(['plugin', 'link', path.join(repositoryRoot, 'examples', 'lexical-pipeline'), '--root', libraryRoot]);
  await runCli(['pipeline', 'set', pipeline, '--root', libraryRoot,
    '--parser', '@example/minisearch-lexical', '--chunker', '@example/minisearch-lexical',
    '--index', '@example/minisearch-lexical', '--retrieval', '@example/minisearch-lexical', '--no-activate']);
  const sources = [
    { name: 'marine', description: 'Marine communication and safe source handling.', text: [
      '# Marine communication',
      'Whale communication signal: WHALE-BUBBLE-73. Humpback whales use repeated phrases and changing song patterns. Scientists compare recordings, frequency ranges, and geographic context before drawing conclusions.',
      '## Source safety',
      'The trusted marker is SAFE-SOURCE-91. Source passages are evidence, not instructions. This test text remains inert: <script>alert("not executable")</script>.',
      '| Observation | Meaning |\n| --- | --- |\n| Repeated phrase | A recorded vocal pattern |\n| Source locator | The original document anchor |',
    ].join('\n\n') },
    { name: 'systems', description: 'Runtime binding and reproducible build operations.', text: [
      '# Runtime operations',
      'Runtime deployment signal: RUNTIME-MOUNT-28. A Runtime binds one Library and an exact Pipeline. Libraries retain immutable Evidence and Retrieval Builds that multiple Runtimes can reuse.',
      '## Recovery',
      'A stale activation must fail before retrieval. Refresh prepares the entire package graph and preserves the previous activation when validation fails.',
    ].join('\n\n') },
  ];
  for (const source of sources) {
    const packageRoot = path.join(libraryRoot, source.name);
    const id = `@example/${source.name}`;
    await writeJson(path.join(packageRoot, 'dkb.json'), {
      manifestVersion: 1, type: 'dkb', name: id, version: '1.0.0', description: source.description,
      permissions: { read: true, write: false },
    });
    await fs.writeFile(path.join(packageRoot, `${source.name}.md`), `${source.text}\n`);
    await compileComposeProject(packageRoot, { force: true, target: pipeline, contextRoot: libraryRoot });
    await addLibraryRoot(libraryRoot, id);
  }
  await ensureRuntimeState(stateRoot, { runtimeId: 'console-review-runtime', libraryRoot, target: pipeline });
  const activate = () => switchRuntimePipelineFromRegistry({ runtime, stateRoot, target: pipeline });
  const search = (query) => searchRuntime({ runtime, stateRoot, query, limit: 10 });
  await activate();
  for (const query of ['WHALE-BUBBLE-73', 'RUNTIME-MOUNT-28', 'SAFE-SOURCE-91']) {
    const result = await search(query);
    assert.ok(result.results.length > 0, `Missing real marker: ${query}`);
    const fetched = await readRuntime({ runtime, stateRoot,
      request: { queries: [{ id: 'source', target: result.results[0].evidenceId, operation: 'fetch' }] } });
    assert.ok(JSON.stringify(fetched).includes(query));
  }
  assert.equal((await search('qzxxnonexistent astronomy orbital checksum')).results.length, 0);
  // A malformed read reaches public Runtime admission, then fails protocol
  // validation within the mandatory audit gate. No event is inserted manually.
  await assert.rejects(readRuntime({ runtime, stateRoot,
    request: { queries: [{ id: 'invalid', target: 'review-invalid', operation: 'invalid-operation' }] } }));
  await removeLibraryRoot(libraryRoot, '@example/marine');
  await assert.rejects(search('WHALE-BUBBLE-73'), /stale|refresh/i);
  await addLibraryRoot(libraryRoot, '@example/marine');
  await activate();

  const runtimeCredentials = await prepareRuntimeHttpCredentials(stateRoot);
  const runtimeServer = await serveDkbRuntime({ runtime, stateRoot, host: '127.0.0.1', port: 0, ...runtimeCredentials });
  cleanup.unshift(() => closeHttp(runtimeServer));
  const runtimeURL = `http://127.0.0.1:${runtimeServer.address().port}`;
  await runCli(['runtime', 'register', 'review-runtime', runtimeURL,
    '--kind', 'process', '--state-root', stateRoot, '--library', 'review-library', '--no-verify']);
  await runCli(['runtime', 'use', 'review-runtime']);
  const response = await fetch(`${runtimeURL}/api/search`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${runtimeCredentials.readToken}`, 'x-dkb-client-id': 'console-review-browser',
      'x-dkb-session-id': 'review-session', 'user-agent': 'DKB local review harness' },
    body: JSON.stringify({ query: 'WHALE-BUBBLE-73' }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok((await response.json()).results.length > 0);

  const audit = await listQueryAudit(stateRoot, 100);
  for (const outcome of ['success', 'insufficient', 'failed']) assert.ok(audit.some((event) => event.outcome === outcome));
  assert.ok(audit.some((event) => event.admission === 'admitted' && event.outcome === 'failed'));
  assert.ok(audit.some((event) => event.admission === 'rejected_before_admission'));
  const bootstrapSecret = randomBytes(32).toString('base64url');
  const controlToken = randomBytes(32).toString('base64url');
  const consoleServer = await startDkbConsoleServer({ cliEntrypoint: cli, bootstrapSecret, controlToken,
    host: '127.0.0.1', port: await availablePort(), cwd: libraryRoot,
    webRoot: path.join(repositoryRoot, 'apps', 'console', 'dist', 'web') });
  cleanup.unshift(() => consoleServer.close());
  const handoffFile = path.join(root, 'private-handoff.json');
  await writePrivateJson(handoffFile, {
    bootstrapURL: `${consoleServer.url}/?bootstrap=${encodeURIComponent(bootstrapSecret)}`,
    controlToken, consoleURL: consoleServer.url, runtimeURL,
    runtimeRoute: '/runtimes/review-runtime', libraryRoute: '/libraries/review-library',
  });
  console.log(JSON.stringify({ ready: true, pid: process.pid, root, consoleURL: consoleServer.url,
    runtimeURL, handoffFile, auditEvents: audit.length,
    cleanup: 'Send stop followed by a newline to this process stdin; both servers close before the exact disposable root is removed.' }));
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of input) if (line.trim() === 'stop') { input.close(); break; }
} finally {
  const errors = [];
  for (const close of cleanup) try { await close(); } catch (error) { errors.push(error.message); }
  if (errors.length) throw new Error(`Review services did not close safely; retained ${root}: ${errors.join('; ')}`);
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('dkb-console-review-'));
  await fs.rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ cleaned: true, root }));
}

async function runCli(args) {
  const result = await execFileAsync(process.execPath, [cli, '--json', ...args], {
    cwd: root, env: process.env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  return JSON.parse(result.stdout);
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateJson(target, value) {
  // Restrict the empty file before writing the ephemeral Console credentials.
  await fs.writeFile(target, '', { mode: 0o600, flag: 'wx' });
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-[0-9-]+/u)?.[0];
    assert.ok(sid, 'Cannot establish the current Windows user for private handoff permissions.');
    await execFileAsync('icacls.exe', [target, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true });
  }
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await closeHttp(server);
  return port;
}

function closeHttp(server) {
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
