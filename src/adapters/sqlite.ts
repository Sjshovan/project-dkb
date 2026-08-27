import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import { DkbError } from '@dkb/protocol/errors.js';
import { resolveFrom } from '@dkb/protocol/paths.js';
import type { DkbEvidence, DkbRecord, LoadedDkb } from '@dkb/protocol/types.js';
import { chunkSourceUnit } from '../indexes/chunking.js';
import { capabilitiesForSourceType, type IndexedSourceUnit } from '../indexes/sourceIndex.js';
import type { DkbCompileSourceUnitsInput, DkbExecuteReadPlanInput, DkbReader, DkbReadPlanResult, DkbWriter } from './adapter.js';
import { blocked, boundedLimit, complete, fieldsForColumns, quoteIdentifier, returnFields, sqliteType, sqlParam, validateDkbReadQuery, whereClause } from './sqlShared.js';

export class SqliteAdapter implements DkbReader, DkbWriter {
  async readRecords(_dkb: LoadedDkb): Promise<DkbRecord[]> {
    return [];
  }

  async compileSourceUnits({ dkb, store }: DkbCompileSourceUnitsInput): Promise<IndexedSourceUnit[]> {
    if (!store.path) {
      throw new DkbError(`SQLite store ${store.id} requires path`);
    }

    const databasePath = resolveFrom(dkb.root, store.path);
    const database = new DatabaseSync(databasePath, { readOnly: true });

    try {
      const entries = database
        .prepare("select name, type from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name")
        .all() as Array<{ name: string; type: 'table' | 'view' }>;

      return entries.flatMap((entry) => {
        const columns = database.prepare(`pragma table_info(${quoteIdentifier(entry.name)})`).all() as Array<{ name: string; type: string; pk?: number }>;

        return rowChunks(database, entry.name, columns, {
          dkbId: dkb.manifest.id,
          storeId: store.id,
          databasePath: path.relative(dkb.root, databasePath).replace(/\\/g, '/'),
        });
      }).sort((left, right) => left.id.localeCompare(right.id));
    } finally {
      database.close();
    }
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

function rowChunks(
  database: DatabaseSync,
  table: string,
  columns: Array<{ name: string; type: string; pk?: number }>,
  input: { dkbId: string; storeId: string; databasePath: string },
): IndexedSourceUnit[] {
  const scalarColumns = columns
    .filter((column) => sqliteType(column.type) !== 'unknown')
    .filter((column) => isModelVisibleSourceColumn(column.name))
    .map((column) => column.name)
    .slice(0, 32);

  if (scalarColumns.length === 0) {
    return [];
  }

  const primaryKey = columns
    .filter((column) => typeof column.pk === 'number' && column.pk > 0)
    .sort((left, right) => (left.pk ?? 0) - (right.pk ?? 0))[0]?.name;
  const selectFields = ['rowid as __dkb_rowid', ...scalarColumns.map(quoteIdentifier)].join(', ');
  const rows = database.prepare(`select ${selectFields} from ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>;

  return rows.flatMap((row, index) => {
    const rowid = row.__dkb_rowid;
    const pkValue = primaryKey ? row[primaryKey] : undefined;
    const locator = {
      path: input.databasePath,
      table,
      type: 'row',
      ...(typeof rowid === 'number' || typeof rowid === 'bigint' ? { rowid: Number(rowid) } : {}),
      ...(primaryKey && pkValue !== undefined ? { primaryKey: { field: primaryKey, value: pkValue } } : {}),
      ordinal: index,
    };
    const text = scalarColumns
      .map((column) => {
        const value = row[column];

        return value === null || value === undefined ? null : `${table}.${column}: ${String(value).replace(/\s+/g, ' ').slice(0, 500)}`;
      })
      .filter((value): value is string => Boolean(value))
      .join(' ');
    const title = `${table} row ${primaryKey && pkValue !== undefined ? String(pkValue) : index + 1}`;
    const updatedAt = stableHash({ dkbId: input.dkbId, storeId: input.storeId, table, locator, text });

    return chunkSourceUnit({
      dkbId: input.dkbId,
      storeId: input.storeId,
      type: 'sqlite',
      unit: {
        locator,
        title,
        text,
        hash: updatedAt,
        updatedAt,
      },
      fallbackTitle: title,
      fallbackUpdatedAt: updatedAt,
    }).map((chunk) => ({
      ...chunk,
      dkbId: input.dkbId,
      storeId: input.storeId,
      type: 'sqlite' as const,
      assetLocator: { path: input.databasePath, table },
      capabilities: capabilitiesForSourceType('sqlite'),
      queryable: {
        operations: ['lookup', 'search', 'aggregate'],
        fields: fieldsForColumns(columns),
        defaultLimit: 20,
        maxLimit: 100,
      },
    }));
  });
}

function selectedRowEvidence(
  database: DatabaseSync,
  query: DkbExecuteReadPlanInput['query'],
  sourceUnits: IndexedSourceUnit[],
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

function isModelVisibleSourceColumn(column: string): boolean {
  const normalized = column.toLowerCase();

  return normalized !== 'source'
    && normalized !== 'metadata'
    && normalized !== 'metadata_json'
    && normalized !== 'locator'
    && normalized !== 'path'
    && !normalized.endsWith('_path')
    && !normalized.endsWith('_locator')
    && !normalized.startsWith('__dkb_');
}
