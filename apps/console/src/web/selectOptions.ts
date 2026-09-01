import type { ResourceRow } from './types.js';

export function isHostDefault(resource: Pick<ResourceRow, 'selected' | 'default'>): boolean {
  return Boolean(resource.selected ?? resource.default);
}

export function selectOptionLabel(primary: string, qualifiers: ReadonlyArray<string | false | null | undefined> = []): string {
  return [primary, ...qualifiers.filter((value): value is string => typeof value === 'string' && value.length > 0)].join(' · ');
}

export function defaultOptionLabel(primary: string, isDefault: boolean): string {
  return selectOptionLabel(primary, [isDefault ? 'Default' : undefined]);
}
