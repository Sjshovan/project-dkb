import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConsoleProcessState, removeConsoleProcessState, type ConsoleProcessState } from './processState.js';

export interface ConsoleStatus {
  status: 'running' | 'stopped' | 'stale';
  url?: string;
  pid?: number;
  startedAt?: string;
}

export async function launchDkbConsole(input: { cliEntrypoint: string; openBrowser?: boolean }): Promise<ConsoleStatus & { opened: boolean; launchUrl?: string }> {
  const current = await consoleStatus();
  if (current.status === 'running' && current.url) {
    const state = await readConsoleProcessState();
    if (!state) throw new Error('DKB Console process state disappeared. Retry: dkb console');
    const launchUrl = await issueBootstrapUrl(state);
    if (input.openBrowser !== false) openExternal(launchUrl);
    return { ...current, launchUrl, opened: input.openBrowser !== false };
  }

  const bootstrapSecret = randomBytes(32).toString('base64url');
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const child = spawn(process.execPath, [bin], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    shell: false,
    env: {
      ...process.env,
      DKB_CONSOLE_BOOTSTRAP_SECRET: bootstrapSecret,
      DKB_CONSOLE_CLI_ENTRYPOINT: input.cliEntrypoint,
    },
  });
  child.unref();
  const state = await waitForConsole();
  const launchUrl = `${state.url}/?bootstrap=${encodeURIComponent(bootstrapSecret)}`;
  if (input.openBrowser !== false) openExternal(launchUrl);
  return { status: 'running', url: state.url, launchUrl, pid: state.pid, startedAt: state.startedAt, opened: input.openBrowser !== false };
}

export async function consoleStatus(): Promise<ConsoleStatus> {
  const state = await readConsoleProcessState();
  if (!state) return { status: 'stopped' };
  try {
    const response = await fetch(`${state.url}/healthz`, { signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer();
    if (response.ok) return { status: 'running', url: state.url, pid: state.pid, startedAt: state.startedAt };
  } catch {}
  return { status: 'stale', url: state.url, pid: state.pid, startedAt: state.startedAt };
}

export async function stopDkbConsole(): Promise<ConsoleStatus> {
  const state = await readConsoleProcessState();
  if (!state) return { status: 'stopped' };
  try {
    const response = await fetch(`${state.url}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${state.controlToken}` }, signal: AbortSignal.timeout(3_000) });
    await response.arrayBuffer();
  } catch {}
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await consoleStatus()).status !== 'running') {
      await removeConsoleProcessState(state.pid);
      return { status: 'stopped' };
    }
    await delay(100);
  }
  return { status: 'stale', url: state.url, pid: state.pid, startedAt: state.startedAt };
}

async function waitForConsole(): Promise<ConsoleProcessState> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await readConsoleProcessState();
    if (state && (await consoleStatus()).status === 'running') return state;
    await delay(100);
  }
  throw new Error('DKB Console did not become ready. Run: dkb console status');
}

async function issueBootstrapUrl(state: ConsoleProcessState): Promise<string> {
  const response = await fetch(`${state.url}/control/bootstrap`, {
    method: 'POST',
    headers: { authorization: `Bearer ${state.controlToken}` },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error('DKB Console could not create a new local session. Retry: dkb console stop, then dkb console');
  const value = await response.json() as { secret?: unknown };
  if (typeof value.secret !== 'string') throw new Error('DKB Console returned an invalid session bootstrap response.');
  return `${state.url}/?bootstrap=${encodeURIComponent(value.secret)}`;
}

function openExternal(url: string): void {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false }).unref();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
