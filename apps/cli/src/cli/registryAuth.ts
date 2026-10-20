import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { progressFinish, progressStart, type DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import type { DkbRegistryClient, DkbRegistryTokenExchange } from '@sjshovan/dkb-registry-client/client.js';

export async function registryTokenInput(options: {
  tokenStdin?: boolean;
}): Promise<string> {
  if (process.env.DKB_REGISTRY_TOKEN?.trim()) return process.env.DKB_REGISTRY_TOKEN.trim();

  if (options.tokenStdin) {
    let value = '';
    for await (const chunk of process.stdin) value += String(chunk);
    if (value.trim()) return value.trim();
    throw new DkbError('No Registry token was received on standard input.');
  }

  throw new DkbError('A Registry token is required. Use --token-stdin or set DKB_REGISTRY_TOKEN.');
}

export async function browserRegistryLogin(
  client: DkbRegistryClient,
  abilities: string[],
  progress?: DkbProgressReporter,
): Promise<DkbRegistryTokenExchange> {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const callback = await loopbackCallback(state);
  try {
    const authorization = await client.startBrowserAuthorization({
      callbackUri: callback.url,
      state,
      codeChallenge: challenge,
      abilities,
    });
    progress?.(progressStart({
      phase: 'registry-browser-login',
      label: `Approve Registry access in your browser: ${authorization.authorizeUrl}`,
      total: 1,
      unit: 'steps',
    }));
    openExternal(authorization.authorizeUrl);
    const code = await callback.wait();
    const exchanged = await client.exchangeAuthorization({
      grantType: 'authorization_code',
      code,
      codeVerifier: verifier,
    });
    progress?.(progressFinish({ phase: 'registry-browser-login', label: 'Registry browser login approved', total: 1, unit: 'steps' }));
    return exchanged;
  } finally {
    await callback.close();
  }
}

export async function deviceRegistryLogin(
  client: DkbRegistryClient,
  abilities: string[],
  progress?: DkbProgressReporter,
): Promise<DkbRegistryTokenExchange> {
  const authorization = await client.startDeviceAuthorization(abilities);
  progress?.(progressStart({
    phase: 'registry-device-login',
    label: `Open ${authorization.verificationUri} and enter ${authorization.userCode}`,
    total: 1,
    unit: 'steps',
  }));
  const deadline = Date.now() + authorization.expiresIn * 1_000;
  while (Date.now() < deadline) {
    await delay(Math.max(2, authorization.interval) * 1_000);
    try {
      const exchanged = await client.exchangeAuthorization({ grantType: 'device_code', deviceCode: authorization.deviceCode });
      progress?.(progressFinish({ phase: 'registry-device-login', label: 'Registry device login approved', total: 1, unit: 'steps' }));
      return exchanged;
    } catch (error) {
      if (error instanceof DkbError && error.code === 'authorization_pending') continue;
      throw error;
    }
  }
  throw new DkbError('Registry device authorization expired. Retry: dkb registry login --device', 'expired_token');
}

async function loopbackCallback(expectedState: string): Promise<{
  url: string;
  wait(): Promise<string>;
  close(): Promise<void>;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  let settled = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const receivedState = url.searchParams.get('state') ?? '';
    const receivedCode = url.searchParams.get('code') ?? '';
    const valid = url.pathname === '/callback'
      && receivedCode.length >= 32
      && timingSafeText(receivedState, expectedState);
    response.writeHead(valid ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(valid
      ? '<!doctype html><title>DKB Registry connected</title><p>Registry access approved. You can close this window and return to DKB.</p>'
      : '<!doctype html><title>DKB Registry authorization failed</title><p>The callback was invalid. Return to the DKB CLI and retry.</p>');
    if (settled) return;
    settled = true;
    if (valid) resolveCode(receivedCode);
    else rejectCode(new DkbError('Registry login callback was invalid. Retry: dkb registry login'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new DkbError('Unable to open a loopback callback for Registry login.');
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCode(new DkbError('Registry browser authorization expired. Retry: dkb registry login'));
    }
  }, 10 * 60_000);
  timeout.unref();

  return {
    url: `http://127.0.0.1:${address.port}/callback`,
    wait: () => code,
    close: async () => {
      clearTimeout(timeout);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function openExternal(url: string): void {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false }).unref();
}

function timingSafeText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
