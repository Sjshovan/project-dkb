import path from 'node:path';

export type ConsoleCommandId =
  | 'library.list'
  | 'library.packages'
  | 'library.register'
  | 'library.unregister'
  | 'library.use'
  | 'runtime.list'
  | 'runtime.register'
  | 'runtime.unregister'
  | 'runtime.use'
  | 'registry.list'
  | 'registry.register'
  | 'registry.unregister'
  | 'registry.login'
  | 'registry.logout'
  | 'registry.use'
  | 'stack.list'
  | 'stack.up'
  | 'stack.down'
  | 'package.install'
  | 'package.uninstall'
  | 'package.upgrade'
  | 'pipeline.use';

export interface ConsoleCommandDefinition {
  readonly id: ConsoleCommandId;
  readonly mutation: boolean;
  readonly timeoutMs: number;
  parse(input: unknown): Record<string, unknown>;
  argv(input: Record<string, unknown>): string[];
  resourceKey(input: Record<string, unknown>): string;
}

const readTimeout = 30_000;
const mutationTimeout = 30 * 60_000;

const definitions: Record<ConsoleCommandId, ConsoleCommandDefinition> = {
  'library.list': read('library.list', ['library', 'list'], checkInput),
  'library.packages': read('library.packages', ['list'], libraryInput, (input) => ['--library', text(input.library)]),
  'runtime.list': read('runtime.list', ['runtime', 'list'], checkInput),
  'registry.list': read('registry.list', ['registry', 'list'], checkInput),
  'stack.list': read('stack.list', ['stack', 'list'], checkInput),
  'library.register': mutation('library.register', ['library', 'register'], libraryRegistrationInput, (input) => [
    text(input.path), ...(input.name ? ['--name', text(input.name)] : []),
  ], (input) => `host:library:${text(input.name ?? input.path)}`),
  'library.unregister': mutation('library.unregister', ['library', 'unregister'], namedInput('library'), (input) => [text(input.name)], (input) => `host:library:${text(input.name)}`),
  'library.use': mutation('library.use', ['library', 'use'], namedInput('library'), (input) => [text(input.name)], (input) => `host:library:${text(input.name)}`),
  'runtime.register': mutation('runtime.register', ['runtime', 'register'], runtimeRegistrationInput, (input) => [
    text(input.name), text(input.url), '--kind', text(input.kind),
    ...(input.library ? ['--library', text(input.library)] : []),
    ...(input.verify ? [] : ['--no-verify']),
  ], (input) => `host:runtime:${text(input.name)}`),
  'runtime.unregister': mutation('runtime.unregister', ['runtime', 'unregister'], namedInput('runtime'), (input) => [text(input.name)], (input) => `host:runtime:${text(input.name)}`),
  'runtime.use': mutation('runtime.use', ['runtime', 'use'], namedInput('runtime'), (input) => [text(input.name)], (input) => `host:runtime:${text(input.name)}`),
  'registry.register': mutation('registry.register', ['registry', 'register'], registryRegistrationInput, (input) => [
    text(input.name), text(input.url), ...(input.verify ? [] : ['--no-verify']),
  ], (input) => `host:registry:${text(input.name)}`),
  'registry.unregister': mutation('registry.unregister', ['registry', 'unregister'], namedInput('registry'), (input) => [text(input.name)], (input) => `host:registry:${text(input.name)}`),
  'registry.login': mutation('registry.login', ['registry', 'login'], registryAuthInput, (input) => [
    '--url', text(input.url), '--scope', ...input.abilities as string[],
  ], (input) => `host:registry-auth:${text(input.url)}`),
  'registry.logout': mutation('registry.logout', ['registry', 'logout'], registryLogoutInput, (input) => [
    '--url', text(input.url), ...(input.revoke ? ['--revoke'] : []),
  ], (input) => `host:registry-auth:${text(input.url)}`),
  'registry.use': mutation('registry.use', ['registry', 'use'], namedInput('registry'), (input) => [text(input.name), '--global'], (input) => `host:registry:${text(input.name)}`),
  'stack.up': mutation('stack.up', ['stack', 'up'], stackInput, (input) => [text(input.name), ...(input.target ? ['--target', text(input.target)] : [])], (input) => `stack:${text(input.name)}`),
  'stack.down': mutation('stack.down', ['stack', 'down'], namedInput('stack'), (input) => [text(input.name)], (input) => `stack:${text(input.name)}`),
  'package.install': mutation('package.install', ['install'], packageInstallInput, (input) => [
    text(input.identity), '--library', text(input.library),
    ...(input.version ? ['--version', text(input.version)] : []),
    ...(input.force ? ['--force'] : []),
  ], (input) => `library:${text(input.library)}`),
  'package.uninstall': mutation('package.uninstall', ['uninstall'], packageMutationInput, (input) => [
    text(input.identity), '--library', text(input.library),
  ], (input) => `library:${text(input.library)}`),
  'package.upgrade': mutation('package.upgrade', ['upgrade'], packageMutationInput, (input) => [
    text(input.identity), '--library', text(input.library),
  ], (input) => `library:${text(input.library)}`),
  'pipeline.use': mutation('pipeline.use', ['pipeline', 'use'], pipelineInput, (input) => [text(input.target), text(input.library)], (input) => `library:${text(input.library)}`),
};

export function consoleCommand(id: string): ConsoleCommandDefinition {
  const command = definitions[id as ConsoleCommandId];
  if (!command) throw new ConsoleInputError(`Unsupported Console command: ${id}.`);
  return command;
}

export function parseConsoleCommandInput(command: ConsoleCommandDefinition, input: unknown): Record<string, unknown> {
  return command.parse(input);
}

export class ConsoleInputError extends Error {}

function read(
  id: ConsoleCommandId,
  prefix: string[],
  parse: (value: unknown) => Record<string, unknown>,
  suffix: (input: Record<string, unknown>) => string[] = (input) => input.check ? ['--check'] : [],
): ConsoleCommandDefinition {
  return { id, mutation: false, timeoutMs: readTimeout, parse, argv: (input) => [...prefix, ...suffix(input)], resourceKey: () => 'read' };
}

function mutation(
  id: ConsoleCommandId,
  prefix: string[],
  parse: (value: unknown) => Record<string, unknown>,
  suffix: (input: Record<string, unknown>) => string[],
  resourceKey: (input: Record<string, unknown>) => string,
): ConsoleCommandDefinition {
  return { id, mutation: true, timeoutMs: mutationTimeout, parse, argv: (input) => [...prefix, ...suffix(input)], resourceKey };
}

function checkInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['check']);
  return { check: input.check === true };
}

function namedInput(label: string): (value: unknown) => Record<string, unknown> {
  return (value) => {
    const input = record(value);
    exactKeys(input, ['name']);
    return { name: hostName(input.name, label) };
  };
}

function libraryInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library']);
  return { library: hostNameOrAbsolutePath(input.library, 'Library') };
}

function libraryRegistrationInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['path', 'name']);
  return {
    path: absolutePath(input.path, 'Library path'),
    ...(input.name === undefined || input.name === '' ? {} : { name: hostName(input.name, 'Library') }),
  };
}

function runtimeRegistrationInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['name', 'url', 'kind', 'library', 'verify']);
  const kind = safeValue(input.kind ?? 'remote', 'Runtime kind');
  if (!['process', 'docker', 'remote'].includes(kind)) throw new ConsoleInputError('Runtime kind must be process, docker, or remote.');
  return {
    name: hostName(input.name, 'Runtime'),
    url: endpointUrl(input.url, 'Runtime URL'),
    kind,
    ...(input.library === undefined || input.library === '' ? {} : { library: hostNameOrAbsolutePath(input.library, 'Library') }),
    verify: input.verify !== false,
  };
}

function registryRegistrationInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['name', 'url', 'verify']);
  return { name: hostName(input.name, 'Registry'), url: endpointUrl(input.url, 'Registry URL'), verify: input.verify !== false };
}

function registryAuthInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['url', 'abilities']);
  const abilities = input.abilities === undefined ? ['registry:read'] : input.abilities;
  if (!Array.isArray(abilities) || abilities.length === 0 || abilities.length > 8
    || abilities.some((ability) => typeof ability !== 'string' || !/^registry:[a-z-]+$/u.test(ability))) {
    throw new ConsoleInputError('Registry scopes are invalid.');
  }
  return { url: endpointUrl(input.url, 'Registry URL'), abilities };
}

function registryLogoutInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['url', 'revoke']);
  return { url: endpointUrl(input.url, 'Registry URL'), revoke: input.revoke !== false };
}

function stackInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['name', 'target']);
  return {
    name: hostName(input.name ?? 'local', 'Stack'),
    ...(input.target === undefined || input.target === '' ? {} : { target: hostName(input.target, 'Pipeline target') }),
  };
}

function packageMutationInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'identity']);
  return { library: hostNameOrAbsolutePath(input.library, 'Library'), identity: packageIdentity(input.identity) };
}

function packageInstallInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'identity', 'version', 'force']);
  return {
    library: hostNameOrAbsolutePath(input.library, 'Library'),
    identity: packageIdentity(input.identity),
    ...(input.version === undefined || input.version === '' ? {} : { version: safeValue(input.version, 'Version') }),
    force: input.force === true,
  };
}

function pipelineInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'target']);
  return { library: hostNameOrAbsolutePath(input.library, 'Library'), target: hostName(input.target, 'Pipeline target') };
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConsoleInputError('Command input must be an object.');
  return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new ConsoleInputError(`Unexpected command input: ${unexpected.join(', ')}.`);
}

function hostName(value: unknown, label: string): string {
  const result = safeValue(value, `${label} name`).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(result)) throw new ConsoleInputError(`${label} name is invalid.`);
  return result;
}

function hostNameOrAbsolutePath(value: unknown, label: string): string {
  const result = safeValue(value, label);
  if (/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(result.toLowerCase())) return result.toLowerCase();
  if (!path.isAbsolute(result)) throw new ConsoleInputError(`${label} must be a registered name or absolute path.`);
  return path.resolve(result);
}

function absolutePath(value: unknown, label: string): string {
  const result = safeValue(value, label);
  if (!path.isAbsolute(result)) throw new ConsoleInputError(`${label} must be absolute.`);
  return path.resolve(result);
}

function endpointUrl(value: unknown, label: string): string {
  const result = safeValue(value, label);
  let parsed: URL;
  try { parsed = new URL(result); } catch { throw new ConsoleInputError(`${label} is invalid.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ConsoleInputError(`${label} must be an HTTP(S) URL without embedded credentials.`);
  }
  return parsed.toString().replace(/\/$/u, '');
}

function packageIdentity(value: unknown): string {
  const result = safeValue(value, 'Package identity').toLowerCase();
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(result)) throw new ConsoleInputError('Package identity must be @namespace/name.');
  return result;
}

function safeValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512 || /[\0\r\n]/u.test(value)) {
    throw new ConsoleInputError(`${label} is invalid.`);
  }
  return value.trim();
}

function text(value: unknown): string {
  return String(value);
}
