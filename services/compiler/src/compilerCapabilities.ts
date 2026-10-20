import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DKB_COMPILER_CAPABILITIES_FORMAT, type DkbCompilerCapabilities } from '@sjshovan/dkb-protocol/compilerCapabilities.js';
import { observeInstalledPackageIntegrity } from '@sjshovan/dkb-pipeline/packageIntegrity.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { resolveRegistryCompilerCatalog } from './registryTargets.js';
import { DKB_COMPILER_VERSION } from './version.js';

// Start observation at module bootstrap, not after a first request could see
// rebuilt files beside still-cached compiler code. No mutable-image claim.
const installedCompiler = observeInstalledPackageIntegrity(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
void installedCompiler.catch(() => undefined);

export async function assertCompilerBuildCurrent(): Promise<void> {
  await (await installedCompiler).assertCurrent();
}

export async function readCompilerBuildIdentity() {
  const compiler = await installedCompiler;
  await compiler.assertCurrent();
  return compiler.identity;
}

export async function registryCompilerCapabilities(distribution: DkbDistribution, contextRoot: string): Promise<DkbCompilerCapabilities> {
  const compiler = await installedCompiler;
  await compiler.assertCurrent();
  const catalog = await resolveRegistryCompilerCatalog(distribution, contextRoot);
  await compiler.assertCurrent();
  return {
    format: DKB_COMPILER_CAPABILITIES_FORMAT,
    service: 'dkb.registry.compiler',
    version: DKB_COMPILER_VERSION,
    compiler: compiler.identity,
    activeTarget: catalog.defaultTarget,
    defaultTarget: catalog.defaultTarget,
    allowedTargets: catalog.targets,
  };
}
