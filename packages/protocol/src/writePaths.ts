import { DkbError } from './errors.js';
import type { DkbWrite } from './types.js';

// Deliberately bounded glob language, not a .gitignore parser. No dependency or
// host filesystem semantics can change authorization across operating systems.
export function writePattern(pattern: string): RegExp {
  if (!pattern || pattern.length > 512 || pattern !== pattern.trim()
    || /[\\!#\[\]{}():|<>\u0000-\u001f]/u.test(pattern)) invalid('Unsupported write path pattern');
  const anchored = pattern.startsWith('/');
  const folder = pattern.endsWith('/');
  const body = pattern.replace(/^\//u, '').replace(/\/$/u, '');
  const parts = body.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
    || (part.includes('**') && part !== '**'))) invalid('Ambiguous write path pattern');
  const prefix = anchored || body.includes('/') ? '^' : '(?:^|/)';
  const expression = parts.map((part, index) => {
    if (part === '**') return index === parts.length - 1 ? '.+' : '(?:[^/]+/)*';
    const segment = [...part].map(char => char === '*' ? '[^/]*' : char === '?' ? '[^/]'
      : char.replace(/[.*+?^$()|[\]\\]/gu, '\\$&')).join('');
    return segment + (index < parts.length - 1 ? '/' : '');
  }).join('');
  return new RegExp(prefix + expression + (folder ? '/.+' : '') + '$', 'iu');
}

export function assertSupportedWritePolicy(write: DkbWrite | undefined): void {
  if (!write) invalid('A write policy is required');
  if (write.schema || write.dedupe === 'required'
    || Object.values(write.accepts ?? {}).some(values => values?.length)) {
    invalid('Native writes do not implement write.schema, required semantic dedupe, or nonempty write.accepts; remove unsupported constraints only through operator review');
  }
  for (const patterns of Object.values(write.paths ?? {})) {
    if (!Array.isArray(patterns) || patterns.length > 100) invalid('Write path lists are limited to 100 patterns');
    for (const pattern of patterns) writePattern(pattern);
  }
}

export function assertSourceWritePath(value: string): void {
  if (typeof value !== 'string' || value.length > 512 || value.startsWith('/')
    || /[\\<>:"|?*\u0000-\u001f]/u.test(value)) invalid('Use a portable package-relative source path');
  const parts = value.split('/');
  if (parts.some(part => !part || part.startsWith('.') || /[. ]$/u.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    || /^(node_modules|vendor|dist|build|archives)$/iu.test(part)
    || /^(dkb(?:[-.].*)?\.json|package(?:-lock)?\.json|agents(?:\.override)?\.md|skill\.md)$/iu.test(part))) {
    invalid('Source path is reserved or unsafe');
  }
  if (!/\.(md|txt)$/iu.test(value)) invalid('Targeted writes support only UTF-8 .md and .txt sources');
}

export function permitsSourceWrite(write: DkbWrite, operation: 'append' | 'create', target: string): boolean {
  assertSupportedWritePolicy(write);
  assertSourceWritePath(target);
  const rules = write.paths;
  return !!rules && !rules.exclude?.some(pattern => writePattern(pattern).test(target))
    && !!rules[operation]?.some(pattern => writePattern(pattern).test(target));
}

function invalid(message: string): never {
  throw new DkbError(message, 'write_policy_invalid');
}
