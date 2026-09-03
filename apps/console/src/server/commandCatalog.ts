import path from 'node:path';

export type ConsoleCommandId =
  | 'library.list'
  | 'library.packages'
  | 'library.register'
  | 'library.unregister'
  | 'library.use'
  | 'library.registry.use'
  | 'runtime.list'
  | 'runtime.show'
  | 'runtime.library.show'
  | 'runtime.library.use'
  | 'runtime.refresh'
  | 'runtime.audit.list'
  | 'runtime.register'
  | 'runtime.unregister'
  | 'runtime.use'
  | 'registry.list'
  | 'registry.register'
  | 'registry.unregister'
  | 'registry.login'
  | 'registry.logout'
  | 'registry.use'
  | 'registry.catalog'
  | 'registry.entry'
  | 'registry.contents'
  | 'registry.pipeline.list'
  | 'registry.build'
  | 'registry.build.cancel'
  | 'stack.list'
  | 'stack.use'
  | 'stack.up'
  | 'stack.down'
  | 'package.install'
  | 'package.show'
  | 'package.contents'
  | 'package.preview'
  | 'package.evidence'
  | 'package.verify'
  | 'package.build.verify'
  | 'package.publish'
  | 'package.uninstall'
  | 'package.upgrade'
  | 'pipeline.list'
  | 'pipeline.show'
  | 'pipeline.verify'
  | 'pipeline.use';

export interface ConsoleCommandDefinition {
  readonly id: ConsoleCommandId;
  readonly mutation: boolean;
  readonly timeoutMs: number;
  parse(input: unknown): Record<string, unknown>;
  argv(input: Record<string, unknown>): string[];
  resourceKey(input: Record<string, unknown>): string;
}

const readTimeout = 90_000;
const verificationTimeout = 5 * 60_000;
const mutationTimeout = 30 * 60_000;

const definitions: Record<ConsoleCommandId, ConsoleCommandDefinition> = {
  'library.list': read('library.list', ['library', 'list'], checkInput, () => []),
  'library.packages': read('library.packages', ['list'], libraryInput, (input) => ['--library', text(input.library)]),
  'runtime.list': read('runtime.list', ['runtime', 'list'], checkInput),
  'runtime.show': read('runtime.show', ['runtime', 'show'], runtimeNameInput, (input) => [text(input.runtime)]),
  'runtime.library.show': read('runtime.library.show', ['runtime', 'library', 'show'], runtimeNameInput, (input) => [text(input.runtime)]),
  'pipeline.list': read('pipeline.list', ['pipeline', 'list'], runtimeNameInput, (input) => ['--runtime', text(input.runtime)], verificationTimeout),
  'pipeline.show': read('pipeline.show', ['pipeline', 'show'], pipelineReadInput, (input) => [text(input.target), '--runtime', text(input.runtime)]),
  'pipeline.verify': read('pipeline.verify', ['pipeline', 'verify'], pipelineReadInput, (input) => [text(input.target), '--runtime', text(input.runtime)], verificationTimeout),
  'runtime.audit.list': read('runtime.audit.list', ['runtime', 'audit', 'list'], runtimeAuditInput, (input) => [text(input.runtime), '--limit', text(input.limit)]),
  'registry.list': read('registry.list', ['registry', 'list'], checkInput),
  'registry.catalog': read('registry.catalog', ['search'], registryCatalogInput, (input) => [
    ...(input.query ? [text(input.query)] : []), '--url', text(input.url), '--type', text(input.type),
    '--page', text(input.page), '--per-page', text(input.perPage),
  ]),
  'registry.entry': read('registry.entry', ['registry', 'show'], registryEntryInput, (input) => [
    text(input.identity), '--url', text(input.url),
    ...(input.version ? ['--version', text(input.version)] : []),
    ...(input.revision ? ['--revision', text(input.revision)] : []),
  ]),
  'registry.contents': read('registry.contents', ['registry', 'show'], registryContentsInput, (input) => [
    text(input.identity), '--url', text(input.url), '--version', text(input.version), '--contents', text(input.path),
    '--limit', text(input.limit), ...(input.cursor ? ['--cursor', text(input.cursor)] : []),
  ]),
  'registry.pipeline.list': read('registry.pipeline.list', ['registry', 'pipeline', 'list'], registryPipelineInput, (input) => ['--url', text(input.url)]),
  'stack.list': read('stack.list', ['stack', 'list'], checkInput),
  'stack.use': mutation('stack.use', ['stack', 'use'], namedInput('stack'), (input) => [text(input.name)], (input) => `host:stack:${text(input.name)}`),
  'package.show': read('package.show', ['show'], packageMutationInput, (input) => [text(input.identity), '--library', text(input.library)]),
  'package.contents': read('package.contents', ['show'], packageContentsInput, (input) => [
    text(input.identity), '--library', text(input.library), '--contents', text(input.directory), '--limit', text(input.limit),
    ...(input.cursor ? ['--cursor', text(input.cursor)] : []),
  ]),
  'package.preview': read('package.preview', ['show'], packagePreviewInput, (input) => [
    text(input.identity), '--library', text(input.library), '--preview', text(input.file),
  ]),
  'package.evidence': read('package.evidence', ['show'], packageEvidenceInput, (input) => [
    text(input.identity), '--library', text(input.library), '--version', text(input.version),
    '--evidence-build', text(input.evidenceDigest), '--evidence', text(input.evidenceId),
  ]),
  'package.verify': read('package.verify', ['show'], packageMutationInput, (input) => [
    text(input.identity), '--library', text(input.library), '--verify',
  ], verificationTimeout),
  'package.build.verify': read('package.build.verify', ['show'], packageBuildVerificationInput, (input) => [
    text(input.identity), '--library', text(input.library), '--verify-build', text(input.buildDigest),
  ], verificationTimeout),
  'package.publish': mutation('package.publish', ['publish'], packagePublishInput, (input) => [
    '--installed', text(input.identity), '--library', text(input.library), '--url', text(input.url), '--pipeline', text(input.pipeline),
  ], (input) => `library:${text(input.library)}`),
  'library.register': mutation('library.register', ['library', 'register'], libraryRegistrationInput, (input) => [
    text(input.path), ...(input.name ? ['--name', text(input.name)] : []),
  ], (input) => `host:library:${text(input.name ?? input.path)}`),
  'library.unregister': mutation('library.unregister', ['library', 'unregister'], namedInput('library'), (input) => [text(input.name)], (input) => `host:library:${text(input.name)}`),
  'library.use': mutation('library.use', ['library', 'use'], namedInput('library'), (input) => [text(input.name)], (input) => `host:library:${text(input.name)}`),
  'library.registry.use': mutation('library.registry.use', ['registry', 'use'], libraryRegistryInput, (input) => [
    text(input.registry), '--root', text(input.library),
  ], (input) => `host:library:${text(input.library)}`),
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
  'registry.build': mutation('registry.build', ['registry', 'build'], registryBuildInput, (input) => [
    text(input.identity), '--version', text(input.version), '--pipeline', text(input.pipeline), '--url', text(input.url),
  ], (input) => `registry:${text(input.url)}:${text(input.identity)}@${text(input.version)}`),
  'registry.build.cancel': mutation('registry.build.cancel', ['registry', 'cancel-build'], registryBuildCancelInput, (input) => [
    text(input.identity), '--version', text(input.version), '--job', text(input.jobId), '--url', text(input.url),
  ], (input) => `registry:${text(input.url)}:${text(input.identity)}@${text(input.version)}`),
  'runtime.library.use': mutation('runtime.library.use', ['runtime', 'library', 'use'], runtimeLibraryInput, (input) => [
    text(input.library), '--runtime', text(input.runtime), ...(input.handle ? ['--handle', text(input.handle)] : []),
  ], (input) => `runtime:${text(input.runtime)}`),
  'runtime.refresh': mutation('runtime.refresh', ['runtime', 'refresh'], runtimeNameInput, (input) => [text(input.runtime)], (input) => `runtime:${text(input.runtime)}`),
  'stack.up': mutation('stack.up', ['stack', 'up'], stackInput, (input) => [
    text(input.name),
    ...(input.compilerTarget ? ['--compiler-target', text(input.compilerTarget)] : []),
    ...(input.pipeline ? ['--pipeline', text(input.pipeline)] : []),
    ...(input.library ? ['--library', text(input.library)] : []),
  ], (input) => `stack:${text(input.name)}`),
  'stack.down': mutation('stack.down', ['stack', 'down'], namedInput('stack'), (input) => [text(input.name)], (input) => `stack:${text(input.name)}`),
  'package.install': mutation('package.install', ['install'], packageInstallInput, (input) => [
    text(input.identity), '--library', text(input.library),
    ...(input.version ? ['--version', text(input.version)] : []),
    ...(input.revision ? ['--revision', text(input.revision)] : []),
    ...(input.target ? ['--target', text(input.target)] : []),
    '--url', text(input.registryUrl),
    ...(input.runtimeUrl ? ['--runtime-url', text(input.runtimeUrl)] : []),
    ...(input.force ? ['--force'] : []),
  ], (input) => `library:${text(input.library)}`),
  'package.uninstall': mutation('package.uninstall', ['uninstall'], packageMutationInput, (input) => [
    text(input.identity), '--library', text(input.library),
    ...(input.runtimeUrl ? ['--url', text(input.runtimeUrl)] : []),
  ], (input) => `library:${text(input.library)}`),
  'package.upgrade': mutation('package.upgrade', ['upgrade'], packageMutationInput, (input) => [
    text(input.identity), '--library', text(input.library),
    ...(input.runtimeUrl ? ['--runtime-url', text(input.runtimeUrl)] : []),
  ], (input) => `library:${text(input.library)}`),
  'pipeline.use': mutation('pipeline.use', ['pipeline', 'use'], pipelineUseInput, (input) => [
    text(input.target), '--runtime', text(input.runtime),
    ...(input.runtimeUrl ? ['--runtime-url', text(input.runtimeUrl)] : []),
    ...(input.registryUrl ? ['--registry-url', text(input.registryUrl)] : []),
  ], (input) => `runtime:${text(input.runtime)}`),
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
  timeoutMs = readTimeout,
): ConsoleCommandDefinition {
  return { id, mutation: false, timeoutMs, parse, argv: (input) => [...prefix, ...suffix(input)], resourceKey: () => 'read' };
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
  exactKeys(input, ['name', 'compilerTarget', 'pipeline', 'library']);
  return {
    name: hostName(input.name ?? 'local', 'Stack'),
    ...(input.compilerTarget === undefined || input.compilerTarget === '' ? {} : { compilerTarget: hostName(input.compilerTarget, 'Compiler target') }),
    ...(input.pipeline === undefined || input.pipeline === '' ? {} : { pipeline: hostName(input.pipeline, 'Runtime Pipeline') }),
    ...(input.library === undefined || input.library === '' ? {} : { library: hostNameOrAbsolutePath(input.library, 'Library') }),
  };
}

function packagePublishInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'identity', 'url', 'pipeline']);
  return { library: hostName(input.library, 'Library'), identity: packageIdentity(input.identity), url: endpointUrl(input.url, 'Registry URL'), pipeline: hostName(input.pipeline, 'Pipeline') };
}

function packageBuildVerificationInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'identity', 'buildDigest']);
  if (typeof input.buildDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(input.buildDigest)) throw new ConsoleInputError('Build digest must be an exact sha256 digest.');
  return { library: hostName(input.library, 'Library'), identity: packageIdentity(input.identity), buildDigest: input.buildDigest };
}

function packageMutationInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'identity', 'runtimeUrl']);
  return {
    library: hostNameOrAbsolutePath(input.library, 'Library'),
    identity: packageIdentity(input.identity),
    ...(input.runtimeUrl === undefined ? {} : { runtimeUrl: endpointUrl(input.runtimeUrl, 'Runtime URL') }),
  };
}

function packageInstallInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'identity', 'version', 'revision', 'target', 'registryUrl', 'runtimeUrl', 'force']);
  if (input.version && input.revision) throw new ConsoleInputError('Version and revision cannot be combined.');
  const revision = input.revision === undefined ? undefined : Number(input.revision);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
    throw new ConsoleInputError('Collection revision must be a positive integer.');
  }
  return {
    library: hostNameOrAbsolutePath(input.library, 'Library'),
    identity: packageIdentity(input.identity),
    ...(input.version === undefined || input.version === '' ? {} : { version: safeValue(input.version, 'Version') }),
    ...(revision === undefined ? {} : { revision }),
    ...(input.target === undefined || input.target === '' ? {} : { target: hostName(input.target, 'Pipeline target') }),
    registryUrl: endpointUrl(input.registryUrl, 'Registry URL'),
    ...(input.runtimeUrl === undefined ? {} : { runtimeUrl: endpointUrl(input.runtimeUrl, 'Runtime URL') }),
    force: input.force === true,
  };
}

function libraryRegistryInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'registry']);
  return {
    library: hostNameOrAbsolutePath(input.library, 'Library'),
    registry: hostName(input.registry, 'Registry'),
  };
}

function registryCatalogInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['url', 'query', 'type', 'page', 'perPage']);
  const type = input.type ?? 'all';
  if (type !== 'all' && type !== 'dkb' && type !== 'collection') throw new ConsoleInputError('Registry catalog type is invalid.');
  const page = boundedInteger(input.page ?? 1, 1, Number.MAX_SAFE_INTEGER, 'Registry catalog page');
  const perPage = boundedInteger(input.perPage ?? 20, 1, 50, 'Registry catalog page size');
  return {
    url: endpointUrl(input.url, 'Registry URL'),
    ...(input.query === undefined || input.query === '' ? {} : { query: safeValue(input.query, 'Registry search query') }),
    type,
    page,
    perPage,
  };
}

function registryEntryInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['url', 'identity', 'version', 'revision']);
  if (input.version && input.revision) throw new ConsoleInputError('Version and revision cannot be combined.');
  const revision = input.revision === undefined ? undefined : boundedInteger(input.revision, 1, Number.MAX_SAFE_INTEGER, 'Collection revision');
  return {
    url: endpointUrl(input.url, 'Registry URL'),
    identity: packageIdentity(input.identity),
    ...(input.version === undefined || input.version === '' ? {} : { version: safeValue(input.version, 'Version') }),
    ...(revision === undefined ? {} : { revision }),
  };
}

function registryContentsInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['url', 'identity', 'version', 'path', 'cursor', 'limit']);
  return {
    url: endpointUrl(input.url, 'Registry URL'),
    identity: packageIdentity(input.identity),
    version: safeValue(input.version, 'Version'),
    path: portablePackagePath(input.path ?? '.', true),
    ...(input.cursor === undefined || input.cursor === '' ? {} : { cursor: safeValue(input.cursor, 'Source inventory cursor') }),
    limit: boundedInteger(input.limit ?? 100, 1, 200, 'Source inventory page size'),
  };
}

function registryPipelineInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['url']);
  return { url: endpointUrl(input.url, 'Registry URL') };
}

function registryBuildInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['url', 'identity', 'version', 'pipeline']);
  return {
    url: endpointUrl(input.url, 'Registry URL'),
    identity: packageIdentity(input.identity),
    version: safeValue(input.version, 'Version'),
    pipeline: hostName(input.pipeline, 'Registry Pipeline'),
  };
}

function registryBuildCancelInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['url', 'identity', 'version', 'jobId']);
  return {
    url: endpointUrl(input.url, 'Registry URL'),
    identity: packageIdentity(input.identity),
    version: safeValue(input.version, 'Version'),
    jobId: boundedInteger(input.jobId, 1, Number.MAX_SAFE_INTEGER, 'Compile job ID'),
  };
}

function runtimeAuditInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['runtime', 'limit']);
  return {
    runtime: hostName(input.runtime, 'Runtime'),
    limit: boundedInteger(input.limit ?? 100, 1, 100, 'Runtime audit limit'),
  };
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new ConsoleInputError(`${label} is invalid.`);
  return result;
}

function packageContentsInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'identity', 'directory', 'cursor', 'limit']);
  const limit = input.limit === undefined ? 100 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConsoleInputError('Package contents limit must be between 1 and 100.');
  return {
    library: hostNameOrAbsolutePath(input.library, 'Library'),
    identity: packageIdentity(input.identity),
    directory: portablePackagePath(input.directory ?? '.', true),
    ...(input.cursor === undefined || input.cursor === '' ? {} : { cursor: portablePackagePath(input.cursor, false) }),
    limit,
  };
}

function packagePreviewInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'identity', 'file']);
  return {
    library: hostNameOrAbsolutePath(input.library, 'Library'),
    identity: packageIdentity(input.identity),
    file: portablePackagePath(input.file, false),
  };
}

function runtimeNameInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['runtime']);
  return { runtime: hostName(input.runtime, 'Runtime') };
}

function runtimeLibraryInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['runtime', 'library', 'handle']);
  return {
    runtime: hostName(input.runtime, 'Runtime'),
    library: hostNameOrAbsolutePath(input.library, 'Library'),
    ...(input.handle === undefined || input.handle === '' ? {} : { handle: safeValue(input.handle, 'Runtime Library handle') }),
  };
}

function pipelineReadInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['runtime', 'target']);
  return { runtime: hostName(input.runtime, 'Runtime'), target: hostName(input.target, 'Pipeline target') };
}

function pipelineUseInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['runtime', 'target', 'runtimeUrl', 'registryUrl']);
  return {
    runtime: hostName(input.runtime, 'Runtime'),
    target: hostName(input.target, 'Pipeline target'),
    ...(input.runtimeUrl === undefined || input.runtimeUrl === '' ? {} : { runtimeUrl: endpointUrl(input.runtimeUrl, 'Runtime URL') }),
    ...(input.registryUrl === undefined || input.registryUrl === '' ? {} : { registryUrl: endpointUrl(input.registryUrl, 'Registry URL') }),
  };
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

function packageEvidenceInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, ['library', 'identity', 'version', 'evidenceDigest', 'evidenceId']);
  for (const field of ['evidenceDigest', 'evidenceId']) {
    if (typeof input[field] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(input[field])) throw new ConsoleInputError(`${field} must be an exact SHA-256 identity.`);
  }
  return { library: hostNameOrAbsolutePath(input.library, 'Library'), identity: packageIdentity(input.identity),
    version: safeValue(input.version, 'Version'), evidenceDigest: input.evidenceDigest, evidenceId: input.evidenceId };
}

function portablePackagePath(value: unknown, allowRoot: boolean): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\0\r\n]/u.test(value)) {
    throw new ConsoleInputError('Package content path is invalid.');
  }
  const portable = value.trim().replace(/\\/gu, '/');
  if ((portable === '.' || portable === './') && allowRoot) return '.';
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(portable)) throw new ConsoleInputError('Package content path must be relative.');
  const parts = portable.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..' || part === '.dkb')) {
    throw new ConsoleInputError('Package content path is outside the portable package tree.');
  }
  return parts.join('/');
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
