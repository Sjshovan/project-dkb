import { humanSummary } from '../presentation.js';

export function summarizeInitResult(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    type?: unknown;
    root?: unknown;
    manifest?: unknown;
    registry?: { url?: unknown; source?: unknown };
    host?: { library?: unknown; inventoryPath?: unknown };
    warning?: unknown;
    retryCommand?: unknown;
  };

  return [
    `status: ${String(result.status ?? 'initialized')}`,
    `type: ${String(result.type ?? 'package')}`,
    typeof result.root === 'string' ? `path: ${result.root}` : '',
    typeof result.manifest === 'string' ? `manifest: ${result.manifest}` : '',
    typeof result.registry?.url === 'string'
      ? `registry: ${result.registry.url} (${String(result.registry.source ?? 'project')})`
      : '',
    result.host?.library ? `host Library: ${String(result.host.library)}` : '',
    result.host?.inventoryPath ? `inventory: ${String(result.host.inventoryPath)}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
  ];
}

export function summarizeHostLibraries(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const libraries = Array.isArray(result.libraries) ? result.libraries : [];

  return [
    `inventory: ${String(result.inventoryPath ?? '-')}`,
    `default: ${String(result.selected ?? 'none')}`,
    '',
    ...humanSummary({
      results: libraries.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: item.selected ? '*' : '',
          name: item.name ?? '-',
          status: item.status ?? '-',
          registry: item.registry ?? '-',
          kind: item.kind ?? 'local',
          location: item.location ?? item.path ?? '-',
        };
      }),
    }),
  ];
}

export function summarizeHostRegistries(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const registries = Array.isArray(result.registries) ? result.registries : [];

  return [
    `inventory: ${String(result.inventoryPath ?? '-')}`,
    `default: ${String(result.selected ?? 'none')}`,
    `network checks: ${result.checked ? 'enabled' : 'skipped'}`,
    '',
    ...humanSummary({
      results: registries.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: item.selected ? '*' : '',
          name: item.name ?? '-',
          status: item.status ?? '-',
          usedBy: Array.isArray(item.usedBy) && item.usedBy.length > 0 ? item.usedBy.join(', ') : '-',
          url: item.url ?? '-',
        };
      }),
    }),
  ];
}

export function summarizeHostRuntimes(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const runtimes = Array.isArray(result.runtimes) ? result.runtimes : [];

  return [
    `inventory: ${String(result.inventoryPath ?? '-')}`,
    `default: ${String(result.selected ?? 'none')}`,
    `network checks: ${result.checked ? 'enabled' : 'skipped'}`,
    '',
    ...humanSummary({
      results: runtimes.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: item.selected ? '*' : '',
          name: item.name ?? '-',
          kind: item.kind ?? '-',
          status: item.status ?? '-',
          library: item.library ?? '-',
          url: item.url ?? '-',
        };
      }),
    }),
  ];
}

export function summarizeHostMutation(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const library = result.library && typeof result.library === 'object' ? result.library as Record<string, unknown> : {};
  const registry = result.registry && typeof result.registry === 'object' ? result.registry as Record<string, unknown> : {};
  const runtime = result.runtime && typeof result.runtime === 'object' ? result.runtime as Record<string, unknown> : {};

  return [
    `status: ${String(result.status ?? 'updated')}`,
    result.name ? `name: ${String(result.name)}` : '',
    library.displayName ? `Library: ${String(library.displayName)}` : '',
    library.path ? `path: ${String(library.path)}` : '',
    library.registry ? `registry: ${String(library.registry)}` : '',
    registry.url ? `registry: ${String(registry.url)}` : '',
    runtime.kind ? `kind: ${String(runtime.kind)}` : '',
    runtime.library ? `Library: ${String(runtime.library)}` : '',
    runtime.url ? `URL: ${String(runtime.url)}` : '',
    result.path && !library.path ? `path: ${String(result.path)}` : '',
    result.location && !result.path ? `location: ${String(result.location)}` : '',
    result.url && !registry.url && !runtime.url ? `URL: ${String(result.url)}` : '',
    result.composeFile ? `compose file: ${String(result.composeFile)}` : '',
    typeof result.selectedCleared === 'boolean' ? `default cleared: ${result.selectedCleared ? 'yes' : 'no'}` : '',
    result.inventoryPath ? `inventory: ${String(result.inventoryPath)}` : '',
    result.warning ? `warning: ${String(result.warning)}` : '',
    result.retryCommand ? `retry: ${String(result.retryCommand)}` : '',
  ].filter(Boolean);
}

export function summarizeRuntimeAudit(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const events = Array.isArray(result.events) ? result.events : [];
  return [
    ...humanSummary({
      results: events.map((value) => {
        const event = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        const runtime = event.runtime && typeof event.runtime === 'object' ? event.runtime as Record<string, unknown> : {};
        const library = event.library && typeof event.library === 'object' ? event.library as Record<string, unknown> : {};
        return {
          recorded: event.recordedAt ?? '-',
          channel: event.channel ?? '-',
          outcome: event.outcome ?? '-',
          runtime: runtime.id ?? '-',
          library: library.id ?? '-',
          results: event.resultCount ?? 0,
          query: event.query ?? '-',
        };
      }),
    }),
    '',
    `returned: ${events.length}`,
  ];
}
