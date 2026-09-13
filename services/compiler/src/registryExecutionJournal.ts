import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { assertJsonData } from '@sjshovan/dkb-protocol/json.js';
import type { PendingProviderExecution } from './providerExecution.js';
import { compilerWorkRoot } from './workRoot.js';

/** One execution directory; immutable resource records avoid lost concurrent registrations. */
export class RegistryExecutionJournal {
  private lease?: DatabaseSync;
  constructor(readonly root: string) {}

  async begin(): Promise<void> {
    await fs.mkdir(path.dirname(this.root), { recursive: true });
    try { await fs.mkdir(this.root, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DkbError('This compile execution already has recovery state. Cancel and reconcile it before requesting another build.', 'compile_termination_unconfirmed');
      }
      throw error;
    }
    try {
      this.lease = new DatabaseSync(path.join(this.root, 'owner.sqlite'));
      this.lease.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; CREATE TABLE owner (id INTEGER); BEGIN EXCLUSIVE;');
      await writePrivate(path.join(this.root, 'owner.json'), {
        format: 'dkb.compiler.execution.v1', hostname: os.hostname(), pid: process.pid,
      });
    } catch (error) {
      this.lease?.close();
      this.lease = undefined;
      throw error;
    }
  }

  async register(pending: PendingProviderExecution): Promise<string> {
    assertJsonData(pending, 'Pending provider execution');
    if (Buffer.byteLength(JSON.stringify(pending)) > 64 * 1024) {
      throw new DkbError('Pending worker recovery state exceeds 64 KiB.', 'invalid_compile_execution');
    }
    const id = randomUUID();
    await writePrivate(this.resourcePath(id), pending);
    return id;
  }

  async settle(id: string): Promise<void> {
    await fs.unlink(this.resourcePath(id)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await syncDirectory(this.root);
  }

  async entries(): Promise<Array<{ id: string; pending: PendingProviderExecution }>> {
    const names = await fs.readdir(this.root).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    return Promise.all(names.filter((name) => /^[0-9a-f-]{36}\.pending\.json$/u.test(name)).sort().map(async (name) => {
      const pending = JSON.parse(await fs.readFile(path.join(this.root, name), 'utf8')) as PendingProviderExecution;
      assertJsonData(pending, 'Pending provider execution');
      if (pending.kind !== 'evidence' || typeof pending.target !== 'string' || !pending.target
        || typeof pending.providerId !== 'string' || !pending.state || Array.isArray(pending.state)
        || typeof pending.state !== 'object'
        || [pending.providerIntegrityDigest, pending.providerBuildDigest, pending.optionsDigest].some((value) => typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value))) {
        throw terminationUnconfirmed();
      }
      return { id: name.slice(0, 36), pending };
    }));
  }

  async finish(): Promise<void> {
    const file = path.join(this.root, 'finished.json');
    await writePrivate(file, { finished: true }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((JSON.parse(await fs.readFile(file, 'utf8')) as { finished?: unknown }).finished !== true) throw terminationUnconfirmed();
    });
    this.releaseOwner();
  }

  releaseOwner(): void {
    this.lease?.close();
    this.lease = undefined;
  }

  async retainUntrackedWork(): Promise<void> {
    await writePrivate(path.join(this.root, 'untracked.json'), { reason: 'Provider reported unconfirmed work without a recovery handle.' });
  }

  async registerWorkspace(root: string): Promise<void> {
    const parent = await fs.realpath(compilerWorkRoot());
    const resolved = await fs.realpath(root);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('dkb-registry-compile-')
      || (await fs.lstat(root)).isSymbolicLink()) throw terminationUnconfirmed();
    const owner = randomUUID();
    await writePrivate(path.join(resolved, '.dkb-compiler-workspace-owner.json'), { owner });
    await writePrivate(path.join(this.root, 'workspace.json'), { root: resolved, parent, owner });
  }

  private async cleanupWorkspace(): Promise<void> {
    const file = path.join(this.root, 'workspace.json');
    if (!await exists(file)) return;
    const workspace = JSON.parse(await fs.readFile(file, 'utf8')) as { root: string; parent: string; owner: string };
    if (typeof workspace.root !== 'string' || typeof workspace.parent !== 'string' || typeof workspace.owner !== 'string'
      || path.dirname(workspace.root) !== workspace.parent || !path.basename(workspace.root).startsWith('dkb-registry-compile-')) throw terminationUnconfirmed();
    if (!await exists(workspace.root)) return;
    if ((await fs.lstat(workspace.root)).isSymbolicLink() || await fs.realpath(workspace.root) !== workspace.root
      || await fs.realpath(compilerWorkRoot()) !== workspace.parent) throw terminationUnconfirmed();
    const marker = JSON.parse(await fs.readFile(path.join(workspace.root, '.dkb-compiler-workspace-owner.json'), 'utf8')) as { owner?: string };
    if (marker.owner !== workspace.owner) throw terminationUnconfirmed();
    await fs.rm(workspace.root, { recursive: true, force: true });
  }

  async exists(): Promise<boolean> { return exists(this.root); }

  async ownerHasStopped(): Promise<boolean> {
    // SQLite's OS-held lock survives threads/namespaces but is released on actual process death.
    // PID/hostname/heartbeat inference cannot safely distinguish simultaneous containers.
    let probe: DatabaseSync | undefined;
    try {
      const owner = JSON.parse(await fs.readFile(path.join(this.root, 'owner.json'), 'utf8')) as { format?: string };
      if (owner.format !== 'dkb.compiler.execution.v1' || !await exists(path.join(this.root, 'owner.sqlite'))) return false;
      probe = new DatabaseSync(path.join(this.root, 'owner.sqlite'));
      probe.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK;');
      return true;
    } catch { return false; }
    finally { probe?.close(); }
  }

  async removeIfSettled(): Promise<boolean> {
    if (await exists(path.join(this.root, 'untracked.json'))) return false;
    if ((await this.entries()).length) return false;
    const finished = path.join(this.root, 'finished.json');
    if (!await exists(finished)
      || (JSON.parse(await fs.readFile(finished, 'utf8')) as { finished?: unknown }).finished !== true) return false;
    await this.cleanupWorkspace();
    await fs.rm(this.root, { recursive: true, force: true });
    return true;
  }

  private resourcePath(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
      throw new DkbError('Invalid pending worker identity.', 'invalid_compile_execution');
    }
    return path.join(this.root, `${id}.pending.json`);
  }
}

export function terminationUnconfirmed(): DkbError {
  return new DkbError('Compiler worker termination is not confirmed. Work and recovery state are retained; retry cancellation for this same execution after restoring worker connectivity. Do not retry compilation or delete its working files.', 'compile_termination_unconfirmed');
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose directory fsync through Node; file handles are still flushed above.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
