import { countLabel, milliseconds } from '../presentation.js';
import { humanStatus } from './utils.js';

export function summarizeInstallResult(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    id?: unknown;
    packageId?: unknown;
    version?: unknown;
    catalog?: { recordCount?: unknown; packageCount?: unknown };
    search?: { upsert?: { documentCount?: unknown; timingsMs?: { total?: unknown } } };
    packagePath?: unknown;
    warning?: unknown;
    cleanupPath?: unknown;
  };

  return [
    `status: ${humanStatus(result.status ?? 'ok')}`,
    `package: ${String(result.packageId ?? result.id ?? 'unknown')}${result.version ? `@${String(result.version)}` : ''}`,
    countLabel(result.catalog?.recordCount ?? result.search?.upsert?.documentCount, 'record') ?? '',
    countLabel(result.catalog?.packageCount, 'package') ?? '',
    milliseconds(result.search?.upsert?.timingsMs?.total) ? `search activation: ${milliseconds(result.search?.upsert?.timingsMs?.total)}` : '',
    typeof result.packagePath === 'string' ? `path: ${result.packagePath}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.cleanupPath === 'string' ? `cleanup path: ${result.cleanupPath}` : '',
  ];
}

export function summarizeRemoveResult(value: unknown): string[] {
  const result = value as { status?: unknown; id?: unknown; libraryPath?: unknown; warning?: unknown };

  return [
    `status: ${humanStatus(result.status ?? 'ok')}`,
    `package: ${String(result.id ?? 'unknown')}`,
    typeof result.libraryPath === 'string' ? `library: ${result.libraryPath}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
  ];
}

export function summarizePublishResult(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    packageId?: unknown;
    version?: unknown;
    archivePath?: unknown;
    compiled?: { recordCount?: unknown };
    receipt?: { packageId?: unknown; version?: unknown };
    warning?: unknown;
    retryCommand?: unknown;
  };
  const packageId = result.packageId ?? result.receipt?.packageId;
  const version = result.version ?? result.receipt?.version;

  return [
    `status: ${humanStatus(result.status ?? 'published')}`,
    `package: ${String(packageId ?? 'unknown')}${version ? `@${String(version)}` : ''}`,
    countLabel(result.compiled?.recordCount, 'record') ?? '',
    typeof result.archivePath === 'string' ? `archive: ${result.archivePath}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
  ];
}

export function summarizeArtifactTransport(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    archivePath?: unknown;
    outputDir?: unknown;
    ref?: unknown;
    digest?: unknown;
    archiveBytes?: unknown;
    packageId?: unknown;
    version?: unknown;
    registry?: unknown;
    warning?: unknown;
    retryCommand?: unknown;
    cleanupPath?: unknown;
  };

  return [
    `status: ${humanStatus(result.status ?? 'ok')}`,
    typeof result.packageId === 'string' ? `package: ${result.packageId}${result.version ? `@${String(result.version)}` : ''}` : '',
    typeof result.ref === 'string' ? `ref: ${result.ref}` : '',
    typeof result.digest === 'string' ? `digest: ${result.digest}` : '',
    typeof result.archivePath === 'string' ? `archive: ${result.archivePath}` : '',
    typeof result.outputDir === 'string' ? `output: ${result.outputDir}` : '',
    typeof result.registry === 'string' ? `registry: ${result.registry}` : '',
    typeof result.archiveBytes === 'number' ? `size: ${result.archiveBytes} bytes` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
    typeof result.cleanupPath === 'string' ? `cleanup path: ${result.cleanupPath}` : '',
  ];
}
