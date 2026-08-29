export function humanStatus(value: unknown): string {
  return String(value).replace(/_/g, ' ');
}
