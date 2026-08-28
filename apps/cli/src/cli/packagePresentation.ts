import { humanSummary } from './presentation.js';

export function summarizePackageListing(value: unknown): string[] {
  const record = isRecord(value) ? value : {};
  const items = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.packages)
      ? record.packages
      : [];
  const packages = items.filter(isRecord).map((item) => ({
    id: item.id ?? item.packageId ?? '-',
    version: item.latestVersion ?? item.version ?? '-',
    visibility: item.visibility ?? '-',
    name: item.name ?? '-',
  }));

  return [
    typeof record.registryUrl === 'string' ? `registry: ${record.registryUrl}` : '',
    ...humanSummary({ packages }),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
