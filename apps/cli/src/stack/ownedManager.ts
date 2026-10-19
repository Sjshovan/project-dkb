import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import { readHostInventory, registerDockerHostLibrary, registerHostRegistry, registerHostRuntime, registerHostStack } from '../host/inventory.js';
import { readDockerLibraryCommand } from '../host/libraryOwnerResult.js';
import { parseEnvironmentFile, resolveComposeFile, stackEnvironment } from './context.js';
import { withStackControl } from './control.js';
import { assertRequiredImages, assertPortAvailable, composeContainerIds, probeStack, runCompose } from './docker.js';
import { initializeDockerStackOwner } from './owner.js';
import { STACK_OWNER_FORMAT, stackOwnerScopeDigest } from './ownerContract.js';
import { recoverOwnedStackStartup, startOwnedStack, type StackOwnerStartupPlan, type StackOwnerStartupActions } from './ownerStartup.js';
import { provisionStackStorage, readStackStorage, storageEnvironment } from './ownedStorage.js';
import { encodeStackEnvironment, ownedStackContext, readOwnedStack } from './ownedContext.js';
import { stackName, stackStateRoot } from './paths.js';

export async function upOwnedStack(distribution: DkbDistribution, name: string, options: {
  compilerTarget?: string; runtimeTarget?: string; library?: string;
} = {}) {
  const normalized = stackName(name), actions = stackActions(distribution);
  // Recover before any initialization, inspection, volume creation or new plan.
  const recovered = await recoverOwnedStackStartup(distribution, normalized, actions);
  if (recovered !== 'committed') {
    const plan = await withStackControl(normalized, async () => {
      const storage = await provisionStackStorage(distribution, normalized, options.library), owner = storage.owner;
      const root = path.join(stackStateRoot(), normalized), envFile = path.join(root, 'stack.env');
      const before = await fs.readFile(envFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null; throw error;
      });
      const existing = before === null ? {} : parseEnvironmentFile(before);
      if (before !== null) await readOwnedStack(distribution, normalized);
      const compilerTarget = options.compilerTarget ?? (process.env.DKB_COMPILER_DEFAULT_TARGET?.trim()
        || existing.DKB_COMPILER_DEFAULT_TARGET || distribution.defaults.activeTarget);
      if (!compilerTarget) throw new DkbError('The distribution has no default Pipeline. Select --compiler-target explicitly.', 'stack_target_required');
      const allowed = process.env.DKB_COMPILER_ALLOWED_TARGETS ?? existing.DKB_COMPILER_ALLOWED_TARGETS ?? '';
      const seed = stackEnvironment(distribution, normalized, root, existing,
        { target: compilerTarget, runtimeTarget: options.runtimeTarget ?? existing.DKB_RUNTIME_PIPELINE_TARGET ?? compilerTarget, allowedTargets: [] }, {});
      const libraryOwner = { context: owner.context, image: owner.image, volume: owner.libraryVolume };
      if (!storage.sharedLibrary) {
        // init is idempotent; it never reassigns an existing Library's Registry.
        await readDockerLibraryCommand(libraryOwner, 'library.init', { displayName: `${normalized} Library`, registryUrl: `http://127.0.0.1:${seed.DKB_REGISTRY_PORT}`, ifAbsent: true });
      }
      const expected = await initializeDockerStackOwner(distribution, owner, { format: STACK_OWNER_FORMAT, command: 'binding.initialize', input: {
        runtimeId: `${normalized}-runtime`, scopeDigest: stackOwnerScopeDigest(owner), compilerTarget,
        ...(options.runtimeTarget ? { runtimeTarget: options.runtimeTarget } : {}),
        allowedTargets: allowed.split(',').map(value => value.trim()).filter(Boolean),
      } });
      const values = stackEnvironment(distribution, normalized, root, seed, {
        target: expected.plan.compilerTarget, runtimeTarget: expected.plan.runtimeTarget, allowedTargets: expected.plan.compilerTargets,
      }, expected.plan.serviceEnvironment);
      Object.assign(values, storageEnvironment(storage), { DKB_STACK_REQUIRED_SERVICES: expected.plan.requiredServices.join(','), DKB_STACK_RECIPE_DIGEST: expected.plan.recipeDigest });
      delete values.DKB_LIBRARY_HOST_PATH;
      const after = encodeStackEnvironment(values), composeFile = await resolveComposeFile();
      const context = ownedStackContext(distribution, owner, after, composeFile);
      const digests = assertRequiredImages(context, values);
      const wasRunning = before !== null && (await composeContainerIds(await readOwnedStack(distribution, normalized))).length > 0;
      if (!wasRunning) for (const service of context.requiredServices) {
        const port = context.servicePorts[service.id];
        if (port !== undefined) await assertPortAvailable(port, service.stack?.health?.component ?? service.id);
      }
      const inventory = await readHostInventory();
      const libraryName = Object.entries(inventory.libraries).find(([, value]) => value.storage?.context === owner.context && value.storage.volume === owner.libraryVolume)?.[0]
        ?? `${normalized}-library`;
      return { owner, before, after, wasRunning, composeFile, composeDigest: stableHash(await fs.readFile(composeFile, 'utf8')),
        configuration: { format: STACK_OWNER_FORMAT, command: 'configure' as const, input: { id: randomUUID(), scopeDigest: stackOwnerScopeDigest(owner), expected,
          images: Object.fromEntries(Object.entries(digests).map(([id, digest]) => {
            const service = context.requiredServices.find(item => item.id === id)!;
            return [id, { reference: values[service.stack!.imageEnvironment]!, digest }];
          })) } },
        registration: { library: libraryName,
          registry: Object.entries(inventory.registries).find(([, entry]) => entry.url === context.registryUrl)?.[0] ?? `${normalized}-registry`,
          runtime: Object.entries(inventory.runtimes).find(([, entry]) => entry.url === context.runtimeUrl)?.[0] ?? `${normalized}-runtime` },
      } satisfies StackOwnerStartupPlan;
    });
    await startOwnedStack(distribution, normalized, plan, actions);
  }
  return readOwnedStack(distribution, normalized);
}

function stackActions(distribution: DkbDistribution): StackOwnerStartupActions {
  const context = (plan: StackOwnerStartupPlan) => ownedStackContext(distribution, plan.owner, plan.after, plan.composeFile);
  return {
    async start(plan) {
      const stack = context(plan);
      if (stack.inactiveComposeServices.length) runCompose(stack, ['rm', '--force', '--stop', ...stack.inactiveComposeServices], false, false, 'all');
      runCompose(stack, ['up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '240']);
      const failed = (await probeStack(stack)).filter(check => check.status === 'failed');
      if (failed.length) throw new DkbError(`Stack health failed: ${failed.map(check => check.component).join(', ')}. Run dkb stack doctor ${stack.name}.`, 'stack_health_failed');
    },
    async stop(plan) { runCompose(context(plan), ['down', '--remove-orphans']); },
    async activate(plan) {
      const stack = context(plan), values = parseEnvironmentFile(plan.after);
      if (!values.DKB_RUNTIME_ADMIN_TOKEN) throw new DkbError('Stack admin credential is missing.', 'stack_credential_missing');
      await new DkbRuntimeClient({ baseUrl: stack.runtimeUrl, adminToken: values.DKB_RUNTIME_ADMIN_TOKEN, timeoutMs: 5 * 60_000 })
        .switchPipeline({ target: stack.runtimeTarget });
    },
    async register(plan) {
      const stack = context(plan), owner = plan.owner;
      const registry = await registerHostRegistry(plan.registration.registry, stack.registryUrl, { select: 'if-empty' });
      const knownLibrary = (await readHostInventory()).libraries[plan.registration.library];
      const storage = await readStackStorage(stack.name);
      if (!storage || stackOwnerScopeDigest(storage.owner) !== stackOwnerScopeDigest(owner)) throw new DkbError('Stack storage changed before registration.', 'stack_storage_mismatch');
      const library = await registerDockerHostLibrary({ kind: 'docker', context: owner.context, image: owner.image, volume: owner.libraryVolume },
        { name: plan.registration.library, displayName: knownLibrary?.displayName ?? `${stack.name} Library`, select: 'if-empty',
          ...(!storage.sharedLibrary && !knownLibrary ? { registryName: registry.name, registryUrl: stack.registryUrl } : {}) });
      const runtime = await registerHostRuntime(plan.registration.runtime, stack.runtimeUrl, { kind: 'docker', library: library.name,
        composeFile: stack.composeFile, select: 'if-empty' });
      await registerHostStack(stack.name, stack.root, { library: library.name, registry: registry.name, runtime: runtime.name, select: 'if-empty' });
    },
  };
}
