import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ConsoleProcessState {
  format: 'dkb.console-process.v1';
  pid: number;
  port: number;
  url: string;
  controlToken: string;
  startedAt: string;
}

export function consoleStateRoot(): string {
  return path.resolve(process.env.DKB_CONSOLE_STATE_ROOT ?? path.join(os.homedir(), '.dkb', 'console'));
}

export function consoleProcessStatePath(): string {
  return path.join(consoleStateRoot(), 'process.json');
}

export async function readConsoleProcessState(): Promise<ConsoleProcessState | null> {
  try {
    const value = JSON.parse(await fs.readFile(consoleProcessStatePath(), 'utf8')) as Partial<ConsoleProcessState>;
    if (value.format !== 'dkb.console-process.v1' || !Number.isInteger(value.pid) || !Number.isInteger(value.port) || typeof value.url !== 'string' || typeof value.controlToken !== 'string' || typeof value.startedAt !== 'string') return null;
    return value as ConsoleProcessState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeConsoleProcessState(state: ConsoleProcessState): Promise<void> {
  const target = consoleProcessStatePath();
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function removeConsoleProcessState(expectedPid?: number): Promise<void> {
  if (expectedPid !== undefined) {
    const current = await readConsoleProcessState();
    if (current && current.pid !== expectedPid) return;
  }
  await fs.rm(consoleProcessStatePath(), { force: true });
}
