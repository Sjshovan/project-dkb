import type { SQLInputValue } from 'node:sqlite';
import { DkbError } from '@dkb/protocol/errors.js';
import type { DkbEvidence, DkbReadOperator, DkbReadQuery, KnowledgeQueryable } from '@dkb/protocol/types.js';
import type { DkbReadPlanResult } from './adapter.js';

export interface SqlColumnInfo {
  name: string;
  type: string;
}

export function sqliteType(value: string): 'string' | 'number' | 'boolean' | 'date' | 'unknown' {
  const normalized = value.toLowerCase();

  if (normalized.includes('int') || normalized.includes('real') || normalized.includes('num') || normalized.includes('double') || normalized.includes('float') || normalized.includes('decimal')) {
    return 'number';
  }

  if (normalized.includes('bool')) {
    return 'boolean';
  }

  if (normalized.includes('date') || normalized.includes('time')) {
    return 'date';
  }

  if (normalized.includes('text') || normalized.includes('char') || normalized.includes('clob') || normalized.includes('json') || normalized === '') {
    return 'string';
  }

  return 'unknown';
}

export function operatorsForType(value: string): DkbReadOperator[] {
  const type = sqliteType(value);

  if (type === 'number' || type === 'date') {
    return ['equals', 'gt', 'lt', 'gte', 'lte', 'between'];
  }

  if (type === 'string') {
    return ['equals', 'contains'];
  }

  return ['equals'];
}

export function fieldsForColumns(columns: SqlColumnInfo[]): NonNullable<KnowledgeQueryable['fields']> {
  return Object.fromEntries(columns.map((column) => [column.name, {
    type: sqliteType(column.type),
    operators: operatorsForType(column.type),
    searchable: sqliteType(column.type) === 'string',
    returnable: true,
  }]));
}

export function validateDkbReadQuery(query: DkbReadQuery, queryable: KnowledgeQueryable | undefined): { reason: DkbReadPlanResult['reason']; message: string } | null {
  if (!query.id || !query.target || !query.operation) {
    return {
      reason: 'validation_failed',
      message: 'DKB read query requires id, target, and operation.',
    };
  }

  if (!queryable || !queryable.operations.includes(query.operation)) {
    return {
      reason: 'unsupported_operation',
      message: `Operation ${query.operation} is not allowed for ${query.target}.`,
    };
  }

  if (query.limit !== undefined) {
    const max = queryable.maxLimit ?? 100;

    if (!Number.isInteger(query.limit) || query.limit < 1) {
      return {
        reason: 'validation_failed',
        message: `Limit must be a positive integer for ${query.target}.`,
      };
    }

    if (query.limit > max) {
      return {
        reason: 'validation_failed',
        message: `Limit ${query.limit} exceeds maxLimit ${max} for ${query.target}.`,
      };
    }
  }

  for (const field of query.return ?? []) {
    const descriptor = queryable.fields?.[field];

    if (!descriptor || descriptor.returnable === false) {
      return {
        reason: 'unsupported_field',
        message: `Return field ${field} is not allowed for ${query.target}.`,
      };
    }
  }

  for (const filter of query.filters ?? []) {
    const descriptor = queryable.fields?.[filter.field];

    if (!descriptor) {
      return {
        reason: 'unsupported_field',
        message: `Filter field ${filter.field} is not allowed for ${query.target}.`,
      };
    }

    if (!descriptor.operators.includes(filter.op)) {
      return {
        reason: 'unsupported_operator',
        message: `Operator ${filter.op} is not allowed for ${filter.field}.`,
      };
    }
  }

  return null;
}

export function whereClause(query: DkbReadQuery, queryable: KnowledgeQueryable | undefined, placeholder: (index: number) => string = () => '?'): { where: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];

  for (const filter of query.filters ?? []) {
    if (!queryable?.fields?.[filter.field]) {
      throw new DkbError(`Unsupported filter field: ${filter.field}`);
    }

    if (filter.op === 'between') {
      const values = Array.isArray(filter.value) ? filter.value : null;

      if (!values || values.length !== 2) {
        throw new DkbError(`Between filter requires two values for field ${filter.field}`);
      }

      clauses.push(`${quoteIdentifier(filter.field)} between ${placeholder(params.length + 1)} and ${placeholder(params.length + 2)}`);
      params.push(sqlParam(values[0]), sqlParam(values[1]));
      continue;
    }

    clauses.push(`${quoteIdentifier(filter.field)} ${operatorSql(filter.op)} ${placeholder(params.length + 1)}`);
    params.push(filter.op === 'contains' ? `%${String(filter.value)}%` : sqlParam(filter.value));
  }

  return {
    where: clauses.length > 0 ? ` where ${clauses.join(' and ')}` : '',
    params,
  };
}

export function returnFields(query: DkbReadQuery, queryable: KnowledgeQueryable | undefined): string[] {
  const requested = query.return?.length
    ? query.return
    : Object.entries(queryable?.fields ?? {})
      .filter(([, field]) => field.returnable !== false)
      .map(([field]) => field);

  return requested.length > 0 ? requested.slice(0, 20) : ['rowid'];
}

export function boundedLimit(limit: number | undefined, queryable: KnowledgeQueryable | undefined): number {
  const max = queryable?.maxLimit ?? 100;
  const fallback = queryable?.defaultLimit ?? 10;
  const requested = limit ?? fallback;

  return Math.max(1, Math.min(requested, max));
}

export function complete(query: DkbReadQuery, evidence: DkbEvidence[], trace: Record<string, unknown>): DkbReadPlanResult {
  return {
    id: query.id,
    target: query.target,
    status: 'complete',
    reason: null,
    message: 'DKB read query completed.',
    evidence,
    trace,
  };
}

export function blocked(query: DkbReadQuery, reason: DkbReadPlanResult['reason'], message: string, trace: Record<string, unknown>): DkbReadPlanResult {
  return {
    id: query.id || 'unknown',
    target: query.target || '',
    status: 'blocked',
    reason,
    message,
    evidence: [],
    trace,
  };
}

export function sqlParam(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) {
    return value;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  return String(value);
}

export function operatorSql(operator: DkbReadOperator): string {
  if (operator === 'equals') {
    return '=';
  }

  if (operator === 'contains') {
    return 'like';
  }

  if (operator === 'gt') {
    return '>';
  }

  if (operator === 'gte') {
    return '>=';
  }

  if (operator === 'lt') {
    return '<';
  }

  if (operator === 'lte') {
    return '<=';
  }

  throw new DkbError(`Unsupported SQL operator: ${operator}`);
}

export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
