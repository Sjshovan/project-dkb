import type { PipelineTarget, ResourceRow, RuntimeAuditEvent } from '../../types.js';
import type { DkbInstalledBuildSummary, DkbInstalledEntryDetail } from '@sjshovan/dkb-protocol/packageInspection.js';

export interface AuditInstalledPackage { id: string; version: string; status: string }
export interface AuditEvidenceSelection { library: string; identity: string; version: string; evidenceDigest: string; evidenceId: string }

export function retainedAuditBuild(detail: DkbInstalledEntryDetail | undefined, input: {
  identity: string; version: string; kind: 'evidence' | 'retrieval'; digest: string; evidenceDigest?: string;
}): DkbInstalledBuildSummary | undefined {
  if (detail?.identity !== input.identity || detail.version !== input.version || detail.kind !== 'dkb' || detail.status !== 'installed') return undefined;
  const matches = detail.builds.filter((build) => build.kind === input.kind && build.buildDigest === input.digest
    && (input.kind === 'evidence' || !input.evidenceDigest || build.evidenceDigest === input.evidenceDigest));
  return matches.length === 1 ? matches[0] : undefined;
}

/** DataTables passes the resolved cell value, not its source row, to a renderer. */
export function auditSlotRender(display: string): { _: (value: unknown) => unknown; display: string } {
  return { _: (value) => value, display };
}

export function auditAdmissionLabel(event: RuntimeAuditEvent): string {
  return event.admission === 'admitted' ? 'Admitted' : 'Not admitted';
}

export function auditLibraryReference(event: RuntimeAuditEvent | undefined, libraries: readonly ResourceRow[]): { id: string; name?: string; detail?: string } {
  if (!event?.library) return { id: 'Not admitted', detail: 'No Library build graph was admitted.' };
  const matches = libraries.filter((library) => library.libraryId === event.library!.id);
  return matches.length === 1
    ? { id: event.library.id, name: matches[0]!.name }
    : { id: event.library.id, detail: matches.length > 1 ? 'Multiple host Libraries share this identity; no location was assumed.' : 'This historical Library is not available in the host inventory.' };
}

export function auditRuntimeReference(event: RuntimeAuditEvent | undefined, currentId?: string, currentName?: string): string | undefined {
  return event?.runtime.id && event.runtime.id === currentId ? currentName : undefined;
}

export function auditPipelineAvailable(event: RuntimeAuditEvent | undefined, targets: readonly PipelineTarget[]): boolean {
  return Boolean(event?.pipeline && targets.some((target) => target.name === event.pipeline!.target
    && target.evidenceProfileDigest === event.pipeline!.evidenceProfileDigest
    && target.retrievalProfileDigest === event.pipeline!.retrievalProfileDigest
    && target.compatibilityDigest === event.pipeline!.compatibilityDigest));
}

export function auditPackageAvailable(id: string, version: string, packages: readonly AuditInstalledPackage[]): boolean {
  return packages.some((pkg) => pkg.id === id && pkg.version === version && pkg.status === 'installed');
}

export function safeAuditCitationUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function auditDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Recorded time unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function auditElapsed(timing: unknown): string {
  const elapsed = timing && typeof timing === 'object' && 'elapsedMs' in timing ? timing.elapsedMs : undefined;
  return typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0 ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(elapsed)} ms` : 'Not recorded';
}

export function auditJson(value: unknown): string { return JSON.stringify(value, null, 2) ?? 'Not recorded'; }
