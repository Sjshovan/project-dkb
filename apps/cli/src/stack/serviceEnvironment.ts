import type { DkbDistributionService } from '@sjshovan/dkb-pipeline/host.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

/** Only distribution-declared, non-secret provider settings may cross the owner boundary. */
export function validateStackServiceEnvironment(value: unknown, services?: readonly DkbDistributionService[], selected?: readonly string[]): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) invalid();
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries) {
    // Values are written to an unquoted Compose env file. Do not admit interpolation,
    // comments, quoting or extra assignments whose meaning differs from these bytes.
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(key) || typeof item !== 'string' || item.length > 4096
      || /[\s\u0000-\u001f\u007f#$'"`]/u.test(item)) invalid();
  }
  if (services) {
    const secrets = new Set(services.flatMap(service => service.stack?.secretEnvironment ?? []));
    const allowed = new Set(services.filter(service => service.providerId && service.stack && selected?.includes(service.id))
      .flatMap(service => [service.stack!.imageEnvironment, ...Object.values(service.stack!.optionEnvironment ?? {})]));
    for (const [key] of entries) if (!allowed.has(key) || secrets.has(key)) invalid();
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function invalid(): never {
  throw new DkbError('Stack service settings must be bounded literal values from the selected distribution services, never credentials or arbitrary environment variables.', 'invalid_stack_service_environment');
}
