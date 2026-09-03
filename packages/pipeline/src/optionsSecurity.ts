import { DkbSdkError } from './sdk.js';

const INLINE_SECRET = /^(api[_-]?(key|token)|access[_-]?token|bearer[_-]?token|token|password|secret|client[_-]?secret|private[_-]?key|credentials?|authorization)$/iu;

/** Apply to raw configuration and schema output, including defaults and nested arrays. */
export function assertNoInlineSecrets(value: unknown, source: string, prefix = ''): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (INLINE_SECRET.test(key)) {
      throw new DkbSdkError('invalid_plugin_options', `${source} cannot store ${field}; use an environment or secret reference option instead`);
    }
    assertNoInlineSecrets(nested, source, field);
  }
}
