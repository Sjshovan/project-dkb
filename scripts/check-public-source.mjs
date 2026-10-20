import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';

// This checks repository hygiene, not secret entropy. CI also runs Gitleaks.
const forbiddenPaths = [
  /(^|\/)\.(?:agents|ai|codex|junie|impeccable|dkb|codex-remote-attachments)(\/|$)/i,
  /(^|\/)(?:node_modules|vendor|graphify-out|__pycache__)(\/|$)/i,
  /(^|\/)(?:auth\.json|boost\.json|latest-session\.jsonl|rollout-[^/]+\.jsonl)$/i,
  /(^|\/)(?:task-notes|session-notes|agent-notes|handoff-notes)(?:[.-][^/]*)?$/i,

  /\.(?:sqlite(?:3)?(?:-wal|-shm)?|db|pem|p12|pfx|key|dkbpkg|dkbevidence|dkbbuild|pyc)$/i,
];
const environmentFile = /(^|\/)\.env(?:\.[^/]+)?$/i;
const exampleEnvironment = /(^|\/)(?:\.env\.example|[^/]+\.env\.example)$/i;
const privateText = [
  { label: 'personal Windows home path', pattern: /[A-Z]:[\\/]Users[\\/](?!Public[\\/]|Default[\\/]|\<|example[\\/]|user[\\/])[A-Za-z0-9_.-]+[\\/]/i },
  { label: 'conversation export link', pattern: /(?:chatgpt-conversation:\/\/|chatgpt\.com\/c\/)[0-9a-f-]{20,}/i },
  { label: 'temporary public tunnel', pattern: /https?:\/\/[a-z0-9-]+\.(?:ngrok-free\.app|ngrok\.io)\b/i },
];
const textExtensions = /\.(?:md|txt|json|jsonl|[cm]?[jt]sx?|vue|php|py|ya?ml|toml|sh|ps1|xml|env)$/i;

export function inspectPublicFile(name, text = '') {
  const findings = [];
  if (forbiddenPaths.some((rule) => rule.test(name)) ||
    (environmentFile.test(name) && !exampleEnvironment.test(name))) {
    findings.push('private, generated or machine-local file');
  }
  for (const rule of privateText) {
    if (rule.pattern.test(text)) findings.push(rule.label);
  }
  return findings;
}

function selfTest() {
  for (const name of [
    '.ai/mcp/mcp.json', '.junie/mcp/mcp.json', '.codex/config.toml',
    '.agents/skills/example/SKILL.md', 'apps/cli/src/graphify-out/graph.json',
    '.env', '.env.production', 'auth.json', 'storage/library.sqlite',
    '.ai/.env.example', 'private/signing.key', 'release.dkbbuild', 'notes/session-notes.md',
    'latest-session.jsonl', 'rollout-example.jsonl', 'node_modules/example/index.js',
  ]) assert.ok(inspectPublicFile(name).length > 0, name);
  for (const name of [
    'README.md', 'AGENTS.md', 'app/Jobs/AGENTS.md', '.env.example',
    'deploy/production.env.example', 'package-lock.json', 'composer.lock',
    'tests/fixtures/package.json', 'docs/design-decisions.md',
  ]) assert.deepEqual(inspectPublicFile(name), [], name);
  assert.ok(inspectPublicFile('README.md', ['C:', 'Users', 'private-person', 'file'].join('/')).length);
  assert.ok(inspectPublicFile('README.md', 'https://' + 'example-tunnel.ngrok-free.app').length);
  assert.ok(inspectPublicFile('README.md', 'chatgpt-conversation://' + 'a'.repeat(24)).length);
  assert.deepEqual(inspectPublicFile('README.md', 'C:/Users/<user>/project'), []);
  console.log('Public-source policy fixtures passed.');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const names = [...new Set(execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean))];
  const failures = [];
  let checked = 0;
  for (const name of names) {
    let stat;
    try { stat = lstatSync(name); } catch (error) {
      if (error.code === 'ENOENT') continue; // Tracked deletion in the candidate tree.
      throw error;
    }
    checked += 1;
    if (!stat.isFile()) {
      failures.push(name + ': non-regular source entry requires explicit review');
      continue;
    }
    const text = textExtensions.test(name) ? readFileSync(name, 'utf8') : '';
    for (const reason of inspectPublicFile(name, text)) failures.push(name + ': ' + reason);
  }
  if (failures.length) {
    console.error('Public-source policy rejected:\n' + failures.map((item) => '- ' + item).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Public-source file policy passed (' + checked + ' files). Run Gitleaks separately for secret detection.');
  }
}
