import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { parse, type Node } from 'acorn';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

type SyntaxNode = Node & Record<string, unknown>;

/** Inspect syntax only. Computed module specifiers remain trusted operator code. */
export function literalPluginImports(source: string, filename: string, packageType?: string): string[] {
  const extension = path.extname(filename);
  const commonjs = extension === '.cjs' || extension === '.cts'
    || (!['.mjs', '.mts'].includes(extension) && packageType === 'commonjs');
  let tree: Node;
  try {
    const javascript = ['.ts', '.mts', '.cts'].includes(extension)
      ? stripTypeScriptTypes(source, { mode: 'strip' })
      : source;
    tree = parse(javascript, {
      ecmaVersion: 'latest', sourceType: commonjs ? 'commonjs' : 'module',
      allowHashBang: true,
    });
  } catch {
    throw new DkbError(`Cannot inspect imports in plugin file ${path.basename(filename)}. Use supported Node.js syntax and an explicit module format; TypeScript helpers must support native type stripping.`, 'invalid_plugin_imports');
  }

  const imports = new Set<string>();
  const pending: Node[] = [tree];
  while (pending.length) {
    const node = pending.pop()! as SyntaxNode;
    let sourceNode: unknown;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration' || node.type === 'ImportExpression') {
      sourceNode = node.source;
    } else if (node.type === 'CallExpression' && isRequire(node.callee) && Array.isArray(node.arguments)) {
      sourceNode = node.arguments[0];
    }
    const specifier = literalSpecifier(sourceNode);
    if (specifier !== undefined) imports.add(specifier);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) pending.push(child);
      } else if (isNode(value)) pending.push(value);
    }
  }
  return [...imports];
}

function isNode(value: unknown): value is SyntaxNode {
  return typeof value === 'object' && value !== null
    && typeof (value as Node).type === 'string' && typeof (value as Node).start === 'number';
}

function literalSpecifier(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value.type === 'TemplateLiteral' && Array.isArray(value.expressions) && value.expressions.length === 0
    && Array.isArray(value.quasis) && value.quasis.length === 1) {
    const cooked = (value.quasis[0] as { value?: { cooked?: unknown } }).value?.cooked;
    if (typeof cooked === 'string') return cooked;
  }
  return undefined;
}

function isRequire(value: unknown): boolean {
  if (!isNode(value)) return false;
  if (value.type === 'Identifier') return value.name === 'require';
  return value.type === 'MemberExpression' && isNode(value.object)
    && value.object.type === 'Identifier' && value.object.name === 'module'
    && (value.computed ? literalSpecifier(value.property) === 'require'
      : isNode(value.property) && value.property.type === 'Identifier' && value.property.name === 'require');
}
