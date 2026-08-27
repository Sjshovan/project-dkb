import { createHash } from 'node:crypto';

export function stableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function stableStringify(value: unknown): string {
  return canonicalJson(value);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodePoints(left, right));

    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Canonical JSON does not support non-finite numbers');
  }

  return JSON.stringify(value);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    const diff = leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!;

    if (diff !== 0) {
      return diff;
    }
  }

  return leftPoints.length - rightPoints.length;
}
