import { humanSummary } from '../presentation.js';
import { humanStatus } from './utils.js';

export function summarizeStackStatus(value: unknown): string[] {
  const stack = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const services = Array.isArray(stack.services)
    ? stack.services.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const checks = Array.isArray(stack.checks)
    ? stack.checks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];

  return [
    `stack: ${String(stack.name ?? 'local')}`,
    stack.status ? `status: ${humanStatus(stack.status)}` : '',
    stack.target ? `target: ${String(stack.target)}` : '',
    stack.runtimeTarget && stack.runtimeTarget !== stack.target
      ? `runtime target: ${String(stack.runtimeTarget)}`
      : '',
    stack.registryUrl ? `registry: ${String(stack.registryUrl)}` : '',
    stack.runtimeUrl ? `runtime: ${String(stack.runtimeUrl)}` : '',
    stack.stateRoot ? `state: ${String(stack.stateRoot)}` : '',
    ...(services.length > 0 ? [
      '',
      ...humanSummary({ results: services.map((service) => ({
        service: service.name ?? '-',
        status: humanStatus(service.status ?? '-').toUpperCase(),
        health: humanStatus(service.health ?? '-').toUpperCase(),
      })) }),
    ] : []),
    ...(checks.length > 0 ? [
      '',
      ...humanSummary({ results: checks.map((check) => ({
        component: stackComponentLabel(check.component),
        status: humanStatus(check.status ?? '-').toUpperCase(),
        message: check.message ?? '-',
      })) }),
    ] : []),
  ];
}

export function summarizeStackListing(value: unknown): string[] {
  const listing = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const stacks = Array.isArray(listing.stacks)
    ? listing.stacks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  return humanSummary({
    results: stacks.map((stack) => ({
      default: stack.default ? '*' : '',
      name: stack.name ?? '-',
      status: humanStatus(stack.status ?? '-').toUpperCase(),
      target: stack.target ?? '-',
      library: stack.library ?? '-',
      runtime: stack.runtime ?? '-',
      state: stack.stateRoot ?? '-',
    })),
  });
}

function stackComponentLabel(value: unknown): string {
  switch (String(value)) {
    case 'registry-web': return 'Registry';
    case 'dkb-runtime': return 'Runtime';
    case 'dkb-tei': return 'TEI';
    case 'dkb-embedder': return 'FastEmbed';
    case 'dkb-faiss': return 'FAISS';
    case 'meilisearch': return 'Meilisearch';
    case 'docker': return 'Docker';
    case 'compose': return 'Compose';
    case 'secrets': return 'Secrets';
    default: return String(value ?? '-').split(/[-_]/u)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(' ');
  }
}

export function summarizeCompilerStatus(value: unknown): string[] {
  const status = value as {
    available?: unknown;
    docker?: unknown;
    image?: unknown;
    running?: unknown;
    ready?: unknown;
    serviceReady?: unknown;
    url?: unknown;
    serviceUrl?: unknown;
    drift?: unknown;
    serviceVersion?: unknown;
    actions?: unknown;
    status?: unknown;
  };
  const actual = status.status && typeof status.status === 'object'
    ? status.status as typeof status
    : status;
  const actions = Array.isArray(status.actions) ? status.actions : [];
  const ready = Boolean(actual.ready ?? actual.serviceReady);
  const running = Boolean(actual.running ?? actual.available);
  const url = actual.url ?? actual.serviceUrl;
  const drift = Array.isArray(actual.drift) ? actual.drift : [];

  return [
    `docker: ${actual.docker ? 'available' : 'unavailable'}`,
    `image: ${String(actual.image ?? 'unknown')}`,
    `service: ${ready ? 'ready' : running ? 'starting' : 'stopped'}`,
    typeof url === 'string' ? `url: ${url}` : '',
    typeof actual.serviceVersion === 'string' ? `service version: ${actual.serviceVersion}` : '',
    drift.length > 0 ? `drift: ${drift.join(', ')}` : 'drift: none',
    ...actions.map((item) => `action: ${String(item)}`),
  ];
}
