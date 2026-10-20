import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { inspectSafePaths } from './mutationPaths.js';

const execute = promisify(execFile);
const windowsVolumes = new Map<string, Promise<void>>();
const linuxFilesystems = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'overlay', 'tmpfs']);

interface Mount { id: number; device: string; location: string; filesystem: string; }

function unsupported(root: string, detail: string): DkbError {
  return new DkbError(`Library storage at ${root} is not supported for direct database access: ${detail}. `
    + 'Use local Windows storage with native DKB, or a Linux-local Docker volume with management commands executed in Linux. '
    + 'Do not share a live Library database across Windows and Docker. No database was opened.', 'library_storage_unsupported');
}

/** Check the current backing storage, not an environment variable or a saved OS stamp. */
export async function assertLocalLibraryStorage(root: string, targets: readonly string[] = []): Promise<ReadonlyMap<string, Stats | null>> {
  const resolved = path.resolve(root);
  if (!['linux', 'win32'].includes(process.platform)) throw unsupported(resolved, `unverified platform ${process.platform}`);
  const drive = path.parse(resolved).root;
  if (process.platform === 'win32' && !/^[a-z]:\\$/iu.test(drive)) {
    throw unsupported(resolved, 'network paths and non-drive volume handles are unsupported');
  }
  const results = await Promise.allSettled([
    inspectSafePaths(resolved, targets),
    process.platform === 'linux' ? fs.readFile('/proc/self/mountinfo', 'utf8') : fs.stat(drive),
  ] as const);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const paths = (results[0] as PromiseFulfilledResult<ReadonlyMap<string, Stats | null>>).value;
  const storage = (results[1] as PromiseFulfilledResult<string | Stats>).value;
  if (process.platform === 'linux') {
    assertLinuxLibraryMounts(resolved, targets, storage as string);
    return paths;
  }
  const rootDevice = paths.get(resolved)!.dev;
  if ((storage as Stats).dev !== rootDevice) throw unsupported(resolved, 'directory-mounted volumes require owner-side management');
  // The same fresh lstat values already proved every existing ancestor/link.
  // Re-stat-ing each absent sidecar and walking its parents adds no guarantee.
  for (const stat of paths.values()) {
    if (stat && stat.dev !== rootDevice) throw unsupported(resolved, 'Library database and ownership files must stay on the same volume');
  }
  const key = `${drive.toLowerCase()}:${rootDevice}`;
  let checked = windowsVolumes.get(key);
  if (!checked) {
    // Node reports statfs.type=0 on Windows. Query built-in OS volume APIs;
    // keep paths out of executable source and cache only this process's volume identity.
    checked = checkWindowsVolume(resolved, drive);
    if (windowsVolumes.size >= 32) windowsVolumes.delete(windowsVolumes.keys().next().value!);
    windowsVolumes.set(key, checked);
    void checked.catch(() => windowsVolumes.delete(key));
  }
  await checked;
  return paths;
}

async function checkWindowsVolume(root: string, drive: string): Promise<void> {
  try {
    let report: string | undefined;
    try {
      const cscript = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cscript.exe');
      const probe = fileURLToPath(new URL('../platform/windows-volume-probe.js', import.meta.url));
      report = (await execute(cscript, ['//B', '//Nologo', '//E:JScript', probe, drive],
        { windowsHide: true, timeout: 5000, maxBuffer: 1024 })).stdout.trim();
    } catch { /* WSH may be disabled; the existing .NET API remains a verified alternative. */ }
    if (report === 'dkb.windows-storage.v1:supported') return;
    if (report === 'dkb.windows-storage.v1:unsupported') throw new Error('not a ready local fixed NTFS volume');
    // Unknown/disabled probe never authorizes storage. Require an independent positive OS result.
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; $v=[System.IO.DriveInfo]::new($env:DKB_STORAGE_PROBE_DRIVE); '
      + '@{type=$v.DriveType.ToString();format=$v.DriveFormat;ready=$v.IsReady}|ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 10_000, maxBuffer: 4096, env: { ...process.env, DKB_STORAGE_PROBE_DRIVE: drive } });
    const value: unknown = JSON.parse(stdout.trim().replace(/^\uFEFF/u, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || (value as Record<string, unknown>).type !== 'Fixed'
      || (value as Record<string, unknown>).format !== 'NTFS'
      || (value as Record<string, unknown>).ready !== true) throw new Error('not a ready local fixed NTFS volume');
  } catch {
    throw unsupported(root, 'a ready local fixed NTFS volume could not be verified');
  }
}

/** Mount-table contract is exported for deterministic storage validation tests. */
export function assertLinuxLibraryMounts(root: string, targets: readonly string[], source: string): void {
  if (!root.startsWith('/') || path.posix.normalize(root) !== root
    || targets.some((target) => path.posix.normalize(target) !== target || !target.startsWith(root === '/' ? '/' : root + '/'))) {
    throw unsupported(root, 'database paths must be canonical paths inside the Library');
  }
  const mounts: Mount[] = source.trim().split('\n').filter(Boolean).map((line) => {
    const [left, right, extra] = line.split(' - ');
    const fields = left?.split(' '), filesystem = right?.split(' ')[0];
    if (!fields || fields.length < 6 || !/^\d+$/u.test(fields[0]!) || !/^\d+:\d+$/u.test(fields[2]!)
      || !fields[4]?.startsWith('/') || !filesystem || extra !== undefined) throw unsupported(root, 'unreadable Linux mount information');
    return { id: Number(fields[0]), device: fields[2]!, location: unescapeMount(fields[4]), filesystem };
  });
  const covering = (target: string): Mount => {
    const selected = mounts.filter((mount) => mount.location === '/' || target === mount.location || target.startsWith(`${mount.location}/`))
      .sort((a, b) => b.location.length - a.location.length || b.id - a.id)[0];
    if (!selected || !linuxFilesystems.has(selected.filesystem)) throw unsupported(root, `Linux mount ${selected?.filesystem ?? 'unknown'} is not local supported storage`);
    return selected;
  };
  const owner = covering(root);
  for (const target of targets) {
    const mount = covering(target);
    if (mount.id !== owner.id || mount.device !== owner.device) throw unsupported(root, 'Library database and ownership files cross a mount boundary');
  }
}

function unescapeMount(value: string): string {
  return value.replace(/\\(040|011|012|134)/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}
