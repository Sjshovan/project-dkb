import { DkbError } from './errors.js';

export type DkbJsonValue = null | boolean | number | string | DkbJsonValue[] | { [key: string]: DkbJsonValue };

/** Reject values that JSON serialization would discard, coerce, or execute. */
export function assertJsonData(value: unknown, label = 'JSON data'): asserts value is DkbJsonValue {
  visit(value, label, new Set<object>());
}

function visit(value: unknown, label: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(label, 'contains a non-finite number');
    return;
  }
  if (!value || typeof value !== 'object') throw invalid(label, 'is not JSON-safe');
  if (ancestors.has(value)) throw invalid(label, 'contains a cycle');
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) throw invalid(label, 'contains symbol keys');
    if (Array.isArray(value)) {
      if (Object.keys(descriptors).some((key) => key !== 'length'
        && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) {
        throw invalid(label, 'contains non-index array properties');
      }
      for (let index = 0; index < value.length; index += 1) {
        const item = descriptors[String(index)];
        if (!item) throw invalid(`${label}[${index}]`, 'is a sparse array entry');
        visit(dataValue(item, `${label}[${index}]`), `${label}[${index}]`, ancestors);
      }
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype) throw invalid(label, 'contains a non-plain object');
      for (const [key, descriptor] of Object.entries(descriptors)) {
        visit(dataValue(descriptor, `${label}.${key}`), `${label}.${key}`, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

function dataValue(descriptor: PropertyDescriptor, label: string): unknown {
  if (!Object.hasOwn(descriptor, 'value')) throw invalid(label, 'contains an accessor');
  if (!descriptor.enumerable) throw invalid(label, 'is not enumerable JSON data');
  return descriptor.value;
}

function invalid(label: string, detail: string): DkbError {
  return new DkbError(`${label} ${detail}`, 'invalid_json');
}
