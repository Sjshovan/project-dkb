import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';

export const LIBRARY_OWNER_FORMAT = 'dkb.library-owner.v1';
export const LIBRARY_OWNER_ROOT = '/library';
export const LIBRARY_OWNER_WORKER = '/workspace/apps/cli/dist/host/libraryOwnerWorker.js';

export type LibraryOwnerCommand =
  | 'library.init' | 'library.status' | 'library.packages' | 'library.storage'
  | 'library.sync' | 'library.recover' | 'library.add' | 'library.remove' | 'library.registry.use'
  | 'package.show' | 'package.uninstall' | 'collection.uninstall'
  | 'collection.create' | 'collection.show' | 'collection.add' | 'collection.remove';

export function libraryOwnerMutates(command: LibraryOwnerCommand): boolean {
  return ['library.init', 'library.sync', 'library.recover', 'library.add', 'library.remove', 'library.registry.use',
    'package.uninstall', 'collection.uninstall', 'collection.create', 'collection.add', 'collection.remove'].includes(command);
}

export interface LibraryOwnerRequest {
  format: typeof LIBRARY_OWNER_FORMAT;
  command: LibraryOwnerCommand;
  input: Record<string, unknown>;
  output: 'json' | 'json-stream' | 'human';
}

export interface LibraryOwnerPlan {
  request: LibraryOwnerRequest;
  argv: string[];
  timeoutMs: number;
}

/** A transport allowlist, not a second implementation of Library operations. */
export function planLibraryOwnerCommand(value: unknown): LibraryOwnerPlan {
  const request = object(value);
  keys(request, ['format', 'command', 'input', 'output']);
  if (request.format !== LIBRARY_OWNER_FORMAT) fail('Unsupported Library owner protocol. Install matching CLI images.');
  if (!['json', 'json-stream', 'human'].includes(String(request.output))) fail('Invalid Library owner output mode.');
  const input = object(request.input);
  const root = ['--library', LIBRARY_OWNER_ROOT];
  let argv: string[];
  switch (request.command) {
    case 'library.init': {
      keys(input, ['displayName', 'registryUrl', 'ifAbsent']);
      if (input.ifAbsent !== undefined && typeof input.ifAbsent !== 'boolean') fail('ifAbsent must be a boolean.');
      argv = ['init', '--dir', LIBRARY_OWNER_ROOT, '--yes', '--no-verify', '--registry-url', registryUrl(input.registryUrl)];
      if (input.displayName !== undefined) argv.push('--display-name', string(input.displayName, 'Library name'));
      if (input.ifAbsent === true) argv.push('--if-absent');
      break;
    }
    case 'library.registry.use':
      keys(input, ['registryUrl']);
      argv = ['registry', 'use', registryUrl(input.registryUrl), '--root', LIBRARY_OWNER_ROOT, '--no-verify'];
      break;
    case 'library.status': case 'library.storage': case 'library.sync': case 'library.recover':
      keys(input, []);
      argv = ['library', String(request.command).slice('library.'.length), ...root];
      break;
    case 'library.packages':
      keys(input, []);
      argv = ['list', ...root];
      break;
    case 'library.add': case 'library.remove':
      keys(input, ['identity']);
      argv = ['library', String(request.command).slice('library.'.length), identity(input.identity), ...root];
      break;
    case 'package.uninstall': case 'collection.uninstall':
      keys(input, ['identity']);
      argv = [...(request.command === 'collection.uninstall' ? ['collection'] : []), 'uninstall', identity(input.identity), ...root];
      break;
    case 'package.show':
      keys(input, ['identity', 'verify', 'contents', 'preview', 'evidence', 'evidenceBuild', 'version', 'cursor', 'limit']);
      if (input.verify !== undefined && typeof input.verify !== 'boolean') fail('verify must be a boolean.');
      argv = ['show', identity(input.identity), ...root, ...(input.verify ? ['--verify'] : [])];
      for (const [key, flag] of [['contents', '--contents'], ['preview', '--preview'], ['evidence', '--evidence'],
        ['evidenceBuild', '--evidence-build'], ['version', '--version'], ['cursor', '--cursor']] as const) {
        if (input[key] !== undefined) argv.push(flag, string(input[key], key));
      }
      if (input.limit !== undefined) {
        if (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100) fail('Contents limit must be between 1 and 100.');
        argv.push('--limit', String(input.limit));
      }
      break;
    case 'collection.create':
      keys(input, ['identity', 'displayName', 'directoryName']);
      argv = ['collection', 'create', identity(input.identity), ...root];
      if (input.displayName !== undefined) argv.push('--display-name', string(input.displayName, 'Collection name'));
      if (input.directoryName !== undefined) {
        const directory = string(input.directoryName, 'Directory name');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(directory)) fail('Collection directory must be a single folder label.');
        argv.push('--dir-name', directory);
      }
      break;
    case 'collection.add': case 'collection.remove':
      keys(input, request.command === 'collection.add' ? ['identity', 'member', 'version'] : ['identity', 'member']);
      argv = ['collection', String(request.command).slice('collection.'.length), identity(input.identity), identity(input.member), ...root];
      if (input.version !== undefined) argv.push('--version', string(input.version, 'Version selector'));
      break;
    case 'collection.show':
      keys(input, ['identity']);
      argv = ['collection', String(request.command).slice('collection.'.length), identity(input.identity), ...root];
      break;
    default: fail('Unsupported Library owner command. Raw commands and executable paths are not accepted.');
  }
  const output = request.output as LibraryOwnerRequest['output'];
  return {
    request: { format: LIBRARY_OWNER_FORMAT, command: request.command as LibraryOwnerCommand, input: { ...input }, output },
    argv: [output === 'human' ? '--no-progress' : output === 'json' ? '--json' : '--json-stream', ...argv],
    timeoutMs: 5 * 60_000,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Library owner request must contain plain objects.');
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('Unexpected Library owner parameter.');
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith('-')) {
    fail(`${label} must be nonempty text without control characters or command flags.`);
  }
  return value;
}

function identity(value: unknown): string {
  return parseDkbIdentity(string(value, 'Package identity'), 'Package identity').identity;
}

function registryUrl(value: unknown): string {
  const url = new URL(string(value, 'Registry URL'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    fail('Registry URL must be HTTP(S), without credentials, query, or fragment.');
  }
  return url.toString();
}

function fail(message: string): never {
  throw new DkbError(message, 'invalid_library_owner_request');
}
