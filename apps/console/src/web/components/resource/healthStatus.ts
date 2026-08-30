import type { ResourceCheck, ResourceRow } from '../../types.js';

const negativeStatuses = new Set(['failed', 'offline', 'missing', 'invalid', 'unavailable', 'cancelled']);
const warningStatuses = new Set(['degraded', 'warning', 'incomplete', 'stale']);
const positiveStatuses = new Set(['ready', 'online', 'active', 'installed', 'ok', 'succeeded']);

export interface HealthSummary {
  healthy: number;
  warnings: number;
  errors: number;
}

export function summarizeHealth(rows: ResourceRow[]): HealthSummary {
  return rows.reduce<HealthSummary>((summary, row) => {
    const status = normalizedStatus(row.status);
    if (negativeStatuses.has(status)) summary.errors += 1;
    else if (warningStatuses.has(status)) summary.warnings += 1;
    else if (positiveStatuses.has(status)) summary.healthy += 1;
    else summary.warnings += 1;
    return summary;
  }, { healthy: 0, warnings: 0, errors: 0 });
}

export function hasHealthDetails(row: ResourceRow): boolean {
  return Boolean(row.message || row.checks?.length);
}

export function healthCheckStatus(check: ResourceCheck): string {
  if (check.ok === true || normalizedStatus(check.status) === 'ok') return 'ok';
  if (check.ok === false || normalizedStatus(check.status) === 'failed') return check.required === false ? 'warning' : 'failed';
  return normalizedStatus(check.status) || 'unknown';
}

function normalizedStatus(value?: string | number): string {
  return String(value ?? '').toLowerCase().replaceAll('_', ' ');
}
