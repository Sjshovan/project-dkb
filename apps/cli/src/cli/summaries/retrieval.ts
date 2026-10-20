import { humanSummary } from '../presentation.js';
import { humanStatus } from './utils.js';

export function summarizeRetrievalResult(value: unknown): string[] {
  const outer = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const response = outer.response && typeof outer.response === 'object'
    ? outer.response as Record<string, unknown>
    : outer;
  const sufficiency = response.sufficiency && typeof response.sufficiency === 'object'
    ? response.sufficiency as Record<string, unknown>
    : {};
  const evidence = Array.isArray(response.evidence)
    ? response.evidence.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const lines = [
    `status: ${humanStatus(response.status ?? 'unknown')}`,
    `evidence: ${evidence.length} ${evidence.length === 1 ? 'item' : 'items'}`,
    sufficiency.reason ? `sufficiency: ${humanStatus(sufficiency.reason)}` : '',
    typeof sufficiency.confidence === 'number' ? `confidence: ${(sufficiency.confidence * 100).toFixed(1)}%` : '',
  ];

  for (const [index, item] of evidence.entries()) {
    const source = item.source && typeof item.source === 'object' ? item.source as Record<string, unknown> : {};
    const locator = source.locator && typeof source.locator === 'object'
      ? source.locator as Record<string, unknown>
      : {};
    const citation = source.evidenceId ?? source.chunkId ?? `${index + 1}`;
    const location = typeof locator.path === 'string'
      ? `${locator.path}${locator.line ? `:${String(locator.line)}` : ''}`
      : Object.keys(locator).length > 0
        ? JSON.stringify(locator)
        : '-';
    const text = typeof item.text === 'string'
      ? item.text
      : item.value !== undefined
        ? JSON.stringify(item.value)
        : item.rows !== undefined
          ? JSON.stringify(item.rows)
          : '';

    lines.push(
      '',
      `[${String(citation)}] ${String(item.label ?? 'Evidence')}`,
      `  Package: ${String(source.dkbId ?? '-')}${source.packageVersion ? `@${String(source.packageVersion)}` : ''}`,
      `  Source: ${location}`,
      ...clipText(text, 800).split('\n').map((line) => `  ${line}`),
    );
  }

  return lines;
}

export function summarizeQueryResult(value: unknown): string[] {
  const response = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const items = Array.isArray(response.results)
    ? response.results.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const results = items.map((item) => ({
    score: typeof item.score === 'number' ? item.score.toFixed(4) : '-',
    package: item.dkbId ?? '-',
    id: item.id ?? '-',
    title: item.title ?? '-',
    source: item.source ?? '-',
  }));

  return [
    typeof response.query === 'string' ? `query: ${response.query}` : '',
    `results: ${results.length}`,
    '',
    ...humanSummary({ results }),
  ];
}

function clipText(value: string, maximum: number): string {
  const compact = value.trim();

  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1).trimEnd()}…`;
}
