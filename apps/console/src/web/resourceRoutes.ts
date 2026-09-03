export type HostResourceKind = 'library' | 'runtime' | 'registry' | 'stack';

export function hostResourceRoute(kind: HostResourceKind, name: string): string {
  const encoded = encodeURIComponent(name);
  if (kind === 'library') return `/libraries/${encoded}`;
  if (kind === 'runtime') return `/runtimes/${encoded}`;
  if (kind === 'registry') return `/registries/${encoded}`;
  return `/stacks/${encoded}`;
}

export function pipelineRoute(name: string, runtime?: string): string {
  return `/pipelines/${encodeURIComponent(name)}${runtime ? `?runtime=${encodeURIComponent(runtime)}` : ''}`;
}

export function installedEntryRoute(library: string, identity: string): string | undefined {
  const match = /^@([^/]+)\/(.+)$/u.exec(identity);
  return match ? `/libraries/${encodeURIComponent(library)}/entries/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}` : undefined;
}

export interface InstalledBuildSelection { version: string; kind: 'evidence' | 'retrieval'; buildDigest: string }

export function installedBuildRoute(library: string, identity: string, selection: InstalledBuildSelection): string | undefined {
  const entry = installedEntryRoute(library, identity);
  const parsed = parseInstalledBuildSelection({ version: selection.version, buildKind: selection.kind, build: selection.buildDigest });
  if (!entry || !parsed.selection) return undefined;
  return `${entry}?${new URLSearchParams({ view: 'builds', version: selection.version, buildKind: selection.kind, build: selection.buildDigest })}`;
}

export function parseInstalledBuildSelection(query: Record<string, unknown>): { selection?: InstalledBuildSelection; error?: string } {
  if (query.build === undefined && query.buildKind === undefined && query.version === undefined) return {};
  if (typeof query.version !== 'string' || !query.version || query.version.length > 256 || /[\0\r\n]/u.test(query.version)
    || (query.buildKind !== 'evidence' && query.buildKind !== 'retrieval')
    || typeof query.build !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(query.build)) {
    return { error: 'This build link is incomplete or invalid. Select an exact retained build below; no substitute was opened.' };
  }
  return { selection: { version: query.version, kind: query.buildKind, buildDigest: query.build } };
}

export function registryEntryRoute(registry: string, identity: string, kind: 'dkb' | 'collection'): string | undefined {
  const match = /^@([^/]+)\/(.+)$/u.exec(identity);
  return match ? `/registries/${encodeURIComponent(registry)}/${kind === 'dkb' ? 'dkbs' : 'collections'}/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}` : undefined;
}
