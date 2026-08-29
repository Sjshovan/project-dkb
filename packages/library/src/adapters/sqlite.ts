import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbEvidence, DkbRecord, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbExecuteReadPlanInput, DkbReader, DkbReadPlanResult, DkbWriter } from './adapter.js';
import { blocked, boundedLimit, complete, fieldsForColumns, quoteIdentifier, returnFields, sqliteType, sqlParam, validateDkbReadQuery, whereClause } from './sqlShared.js';

export class SqliteAdapter implements DkbReader, DkbWriter {
  async readRecords(_dkb: LoadedDkb): Promise<DkbRecord[]> {
    return [];
  }

  async executeReadPlan({ dkb, store, record, query, sourceUnits }: DkbExecuteReadPlanInput): Promise<DkbReadPlanResult> {
    if (!store.path) {
      return blocked(query, 'missing_connection', `SQLite store ${store.id} has no path`, { storeId: store.id });
    }

    const validation = validateDkbReadQuery(query, record.queryable);

    if (validation) {
      return blocked(query, validation.reason, validation.message, { target: `${dkb.manifest.id}/${record.id}` });
    }

    const databasePath = resolveFrom(dkb.root, store.path);
    const database = new DatabaseSync(databasePath, { readOnly: true });

    try {
      const selected = selectedRowEvidence(database, query, sourceUnits ?? []);

      if (selected.rows.length > 0) {
        return complete(query, [{
          type: 'rows',
          label: selected.tables.join(', '),
          rows: selected.rows,
          source: {
            storeId: store.id,
            type: 'sqlite',
            locator: { tables: selected.tables },
          },
        } satisfies DkbEvidence], {
          adapter: 'sqlite',
          dkbId: dkb.manifest.id,
          storeId: store.id,
          selectedSourceUnits: sourceUnits?.length ?? 0,
          rowsRead: selected.rows.length,
          tablesRead: selected.tables,
          sourceSelection: 'compiled-chunks',
        });
      }

      const table = typeof record.locator?.table === 'string' ? record.locator.table : null;

      if (!table) {
        return blocked(query, 'source_unavailable', `SQLite target has no table locator: ${dkb.manifest.id}/${record.id}`, { target: record.id });
      }

      const { where, params } = whereClause(query, record.queryable);
      const limit = boundedLimit(query.limit, record.queryable);
      const fields = returnFields(query, record.queryable);
      const rows = database
        .prepare(`select ${fields.map(quoteIdentifier).join(', ')} from ${quoteIdentifier(table)}${where} limit ?`)
        .all(...params, limit) as Array<Record<string, unknown>>;

      return rows.length > 0
        ? complete(query, [{
            type: 'rows',
            label: table,
            rows,
            source: {
              storeId: store.id,
              type: 'sqlite',
              locator: { table },
            },
          } satisfies DkbEvidence], {
            adapter: 'sqlite',
            dkbId: dkb.manifest.id,
            storeId: store.id,
            table,
            fields,
            filters: query.filters ?? [],
            rowsRead: rows.length,
          })
        : blocked(query, 'no_results', 'DKB read query returned no rows.', {
            adapter: 'sqlite',
            dkbId: dkb.manifest.id,
            storeId: store.id,
            table,
            fields,
            filters: query.filters ?? [],
            rowsRead: rows.length,
          });
    } finally {
      database.close();
    }
  }

  async appendRecord(_dkb: LoadedDkb, _record: DkbRecord): Promise<DkbRecord> {
    throw new DkbError('SQLite append is not implemented for direct chunk runtime.');
  }
}

function selectedRowEvidence(
  database: DatabaseSync,
  query: DkbExecuteReadPlanInput['query'],
  sourceUnits: NonNullable<DkbExecuteReadPlanInput['sourceUnits']>,
): { rows: Array<Record<string, unknown>>; tables: string[] } {
  const result: Array<Record<string, unknown>> = [];
  const tables = new Set<string>();
  const limit = Math.max(1, Math.min(query.limit ?? 20, 100));

  for (const unit of sourceUnits) {
    if (result.length >= limit) {
      break;
    }

    const table = typeof unit.locator.table === 'string' ? unit.locator.table : null;

    if (!table) {
      continue;
    }

    const columns = database.prepare(`pragma table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; type: string }>;
    const selector = rowSelector(unit.locator, columns);

    if (!selector) {
      continue;
    }

    const fields = columns
      .filter((column) => sqliteType(column.type) !== 'unknown')
      .map((column) => column.name)
      .slice(0, 20);
    const rows = database
      .prepare(`select ${fields.map(quoteIdentifier).join(', ')} from ${quoteIdentifier(table)} where ${selector.sql} limit 1`)
      .all(sqlParam(selector.value)) as Array<Record<string, unknown>>;

    for (const row of rows) {
      result.push(row);
      tables.add(table);
    }
  }

  return { rows: result, tables: [...tables].sort((left, right) => left.localeCompare(right)) };
}

function rowSelector(locator: Record<string, unknown>, columns: Array<{ name: string }>): { sql: string; value: unknown } | null {
  if (typeof locator.rowid === 'number') {
    return { sql: 'rowid = ?', value: locator.rowid };
  }

  const primaryKey = locator.primaryKey;

  if (primaryKey && typeof primaryKey === 'object' && !Array.isArray(primaryKey)) {
    const field = 'field' in primaryKey ? primaryKey.field : undefined;
    const value = 'value' in primaryKey ? primaryKey.value : undefined;

    if (typeof field === 'string' && columns.some((column) => column.name === field)) {
      return { sql: `${quoteIdentifier(field)} = ?`, value };
    }
  }

  return null;
}
