import { humanSummary } from '../presentation.js';

export function summarizeRegistryConfiguration(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    registry?: { url?: unknown; source?: unknown };
    verification?: { ok?: unknown };
    warning?: unknown;
    retryCommand?: unknown;
  };

  return [
    `status: ${String(result.status ?? 'configured')}`,
    typeof result.registry?.url === 'string'
      ? `registry: ${result.registry.url} (${String(result.registry.source ?? 'project')})`
      : '',
    result.verification ? `verification: ${result.verification.ok ? 'passed' : 'failed'}` : 'verification: skipped',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
  ];
}

export function summarizeRegistryStatus(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const registry = result.registry && typeof result.registry === 'object' ? result.registry as Record<string, unknown> : {};
  const verification = result.verification && typeof result.verification === 'object'
    ? result.verification as Record<string, unknown>
    : {};
  const checks = Array.isArray(verification.checks)
    ? verification.checks.map((value) => {
      const check = value && typeof value === 'object' ? value as Record<string, unknown> : {};

      return {
        name: check.name ?? '-',
        ok: check.ok === true,
        impact: check.required === false ? 'OPTIONAL' : 'BLOCKING',
        ...(check.status === undefined ? {} : { status: check.status }),
        ...(check.message === undefined ? {} : { message: check.message }),
      };
    })
    : [];

  return [
    `registry: ${String(registry.url ?? '-')}`,
    `source: ${String(registry.source ?? '-')}`,
    `status: ${verification.ok === true ? 'OK' : 'FAILED'}`,
    '',
    ...humanSummary({ checks }),
  ];
}

export function summarizeInstalledPackages(value: unknown): string[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const packages = Array.isArray(record.packages) ? record.packages : [];

  return [
    typeof record.libraryRoot === 'string' ? `library: ${record.libraryRoot}` : '',
    typeof record.registryUrl === 'string'
      ? `registry: ${record.registryUrl}${record.registrySource ? ` (${String(record.registrySource)})` : ''}`
      : '',
    ...humanSummary({ packages: packages.map((item) => {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};

      return {
        id: entry.id ?? '-',
        version: entry.version ?? '-',
        status: entry.status ?? '-',
        records: entry.recordCount ?? '-',
      };
    }) }),
  ];
}

export function summarizeKeyListing(value: unknown): string[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const items = Array.isArray(record.keys) ? record.keys : [];
  const keys = items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      id: item.id ?? '-',
      role: item.subjectType ?? item.role ?? '-',
      subject: item.subjectId ?? '-',
      status: item.status ?? '-',
      fingerprint: item.publicKeyFingerprint ?? item.fingerprint ?? '-',
    }));

  return humanSummary({ results: keys });
}
