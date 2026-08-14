import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { DkbError } from '../protocol/errors.js';
import { resolveFrom } from '../protocol/paths.js';
import type { DkbEvidence, KnowledgeRegion, KnowledgeSourceUnit, LoadedDkb } from '../protocol/types.js';
import { sourceUnitsFromKnowledgeRegion } from '../indexes/sourceIndex.js';
import type { DkbCompileRegionsInput, DkbCompileSourceUnitsInput, DkbExecuteReadPlanInput, DkbReader, DkbReadPlanResult, DkbWriter } from './adapter.js';
import { blocked, boundedLimit, complete, fieldsForColumns, quoteIdentifier, returnFields, sqliteType, sqlParam, validateDkbReadQuery, whereClause } from './sqlShared.js';

interface SqliteRecordRow {
  id: string;
  title: string;
  content: string;
  source: string | null;
  metadata_json: string | null;
}

export class SqliteAdapter implements DkbReader, DkbWriter {
  async readRecords(dkb: LoadedDkb): Promise<KnowledgeRegion[]> {
    const databasePath = resolveFrom(dkb.root, dkb.manifest.entrypoint);
    const database = new DatabaseSync(databasePath, { readOnly: true });

    try {
      const rows = database
        .prepare('select id, title, content, source, metadata_json from records order by id')
        .all() as unknown as SqliteRecordRow[];

      return rows.map((row) => ({
        ...normalizeRow(row, databasePath),
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      throw new DkbError(`Unable to read SQLite records from ${databasePath}: ${reason}`);
    } finally {
      database.close();
    }
  }

  async compileSourceUnits(input: DkbCompileSourceUnitsInput) {
    const regions = await this.compileRegions(input);

    return regions.flatMap(sourceUnitsFromKnowledgeRegion);
  }

  async compileRegions({ dkb, store }: DkbCompileRegionsInput) {
    if (!store.path) {
      throw new DkbError(`SQLite store ${store.id} requires path`);
    }

    const databasePath = resolveFrom(dkb.root, store.path);
    const database = new DatabaseSync(databasePath, { readOnly: true });

    try {
      const entries = database
        .prepare("select name, type from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name")
        .all() as Array<{ name: string; type: 'table' | 'view' }>;
      const tableNames = entries.filter((entry) => entry.type === 'table').map((entry) => entry.name);
      const tableGroups = tableComponents(database, tableNames);
      const viewGroups = entries
        .filter((entry) => entry.type === 'view')
        .map((entry) => [entry.name]);
      const groups = [...tableGroups, ...viewGroups];

      return groups.map((group) => {
        const primary = group[0];
        const entry = entries.find((candidate) => candidate.name === primary)!;
        const columns = database.prepare(`pragma table_info(${quoteIdentifier(primary)})`).all() as Array<{ name: string; type: string }>;
        const allColumns = group.flatMap((table) => {
          const tableColumns = database.prepare(`pragma table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; type: string }>;

          return tableColumns.map((column) => `${table}.${column.name}`);
        });
        const sample = group.flatMap((table) => {
          const tableColumns = database.prepare(`pragma table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; type: string }>;

          return sampleTextValues(database, table, tableColumns);
        });
        const regionType = entry.type === 'view' ? 'view' as const : group.length > 1 ? 'table_group' as const : 'table' as const;
        const regionId = regionType === 'table_group' ? `table_group:${group.join('+')}` : `${entry.type}:${primary}`;
        const sourceUnits = group.flatMap((table) => {
          const tableColumns = database.prepare(`pragma table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; type: string; pk?: number }>;

          return rowSourceUnits(database, table, tableColumns, dkb.manifest.id, store.id, regionId);
        });
        const fields = fieldsForColumns(columns);
        const summary = [
          `${regionType === 'view' ? 'SQLite view' : regionType === 'table_group' ? 'SQLite FK table group' : 'SQLite table'} ${group.join(', ')} with primary table ${primary}.`,
          `Queryable primary columns: ${columns.map((column) => column.name).join(', ')}.`,
          group.length > 1 ? `Grouped columns: ${allColumns.join(', ')}.` : null,
          sample.length > 0 ? `Search sample: ${sample.join(' ')}` : null,
        ].filter(Boolean).join(' ');
        const schemaHash = stableHash({ tables: group, type: regionType, columns, allColumns, sample });

        return {
          id: regionId,
          dkbId: dkb.manifest.id,
          title: group.length > 1 ? group.join(' + ') : primary,
          content: summary,
          source: `${path.relative(dkb.root, databasePath).replace(/\\/g, '/')}#${group.join('+')}`,
          topics: unique([...(dkb.manifest.domains ?? []), ...group]),
          entities: unique([...columns.map((column) => column.name), ...allColumns]),
          updatedAt: schemaHash,
          aliases: unique(group),
          regionType,
          relatedRegionIds: [],
          ancestry: [path.relative(dkb.root, databasePath).replace(/\\/g, '/')],
          relationships: group.length > 1
            ? group.slice(1).map((table) => ({ type: 'foreign_key' as const, regionId: `table:${table}` }))
            : [],
          grouping: {
            strategy: group.length > 1 ? 'database_foreign_keys' as const : 'single_source' as const,
            reason: group.length > 1
              ? 'SQLite tables share foreign-key relationships and compile into one adapter-bounded Knowledge Region.'
              : 'SQLite relation has no compiled FK partner and remains a standalone Knowledge Region.',
          },
          sourceRef: {
            storeId: store.id,
            type: 'sqlite' as const,
            locator: {
              table: primary,
              primaryTable: primary,
              tables: group,
              type: regionType,
            },
            hash: schemaHash,
          },
          queryable: {
            operations: ['lookup' as const, 'search' as const, 'aggregate' as const],
            fields,
            defaultLimit: 20,
            maxLimit: 100,
          },
          sourceUnits,
          storeIds: [store.id],
        };
      });
    } finally {
      database.close();
    }
  }

  async executeReadPlan({ dkb, store, record, query, sourceUnits }: DkbExecuteReadPlanInput): Promise<DkbReadPlanResult> {
    if (!store.path) {
      return blocked(query, 'missing_connection', `SQLite store ${store.id} has no path`, { storeId: store.id });
    }

    const table = typeof record.sourceRef?.locator.table === 'string' ? record.sourceRef.locator.table : null;

    if (!table) {
      return blocked(query, 'source_unavailable', `SQLite target has no table locator: ${dkb.manifest.id}/${record.id}`, { target: record.id });
    }

    const validation = validateDkbReadQuery(query, record.queryable);

    if (validation) {
      return blocked(query, validation.reason, validation.message, { target: `${dkb.manifest.id}/${record.id}` });
    }

    const databasePath = resolveFrom(dkb.root, store.path);
    const database = new DatabaseSync(databasePath, { readOnly: true });

    try {
      if (sourceUnits?.length && query.operation !== 'aggregate') {
        const selected = selectedRowEvidence(database, record, query, sourceUnits);

        return selected.rows.length > 0
          ? complete(query, [{
              type: 'rows',
              label: record.title,
              rows: selected.rows,
              source: record.sourceRef!,
            } satisfies DkbEvidence], {
              adapter: 'sqlite',
              dkbId: dkb.manifest.id,
              storeId: store.id,
              selectedSourceUnits: sourceUnits.length,
              rowsRead: selected.rows.length,
              tablesRead: selected.tables,
              sourceSelection: 'source.index',
            })
          : blocked(query, 'no_results', 'Selected SQLite source units returned no rows.', {
              adapter: 'sqlite',
              dkbId: dkb.manifest.id,
              storeId: store.id,
              selectedSourceUnits: sourceUnits.length,
              sourceSelection: 'source.index',
            });
      }

      const { where, params } = whereClause(query, record.queryable);
      const limit = boundedLimit(query.limit, record.queryable);

      if (query.operation === 'aggregate') {
        if (query.metric !== 'count') {
          return blocked(query, 'unsupported_operation', 'Only count aggregates are currently supported', { metric: query.metric ?? null });
        }

        const row = database.prepare(`select count(*) as count from ${quoteIdentifier(table)}${where}`).get(...params) as { count: number };

        return complete(query, [{
          type: 'aggregate',
          label: `count:${table}`,
          value: row.count,
          source: record.sourceRef!,
        }], {
          adapter: 'sqlite',
          dkbId: dkb.manifest.id,
          storeId: store.id,
          table,
          rowsRead: 1,
        });
      }

      const fields = returnFields(query, record.queryable);
      const rows = database
        .prepare(`select ${fields.map(quoteIdentifier).join(', ')} from ${quoteIdentifier(table)}${where} limit ?`)
        .all(...params, limit) as Array<Record<string, unknown>>;

      return rows.length > 0
        ? complete(query, [{
            type: 'rows',
            label: table,
            rows,
            source: record.sourceRef!,
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

  async appendRecord(dkb: LoadedDkb, record: KnowledgeRegion): Promise<KnowledgeRegion> {
    const databasePath = resolveFrom(dkb.root, dkb.manifest.entrypoint);
    const database = new DatabaseSync(databasePath);

    try {
      database
        .prepare(`
          insert into records (id, title, content, source, metadata_json)
          values (?, ?, ?, ?, ?)
        `)
        .run(
          record.id,
          record.title,
          record.content,
          record.source || `${databasePath}#records/${record.id}`,
          JSON.stringify({
            topics: record.topics,
            entities: record.entities,
            updatedAt: record.updatedAt,
            aliases: record.aliases ?? [],
          }),
        );

      return {
        ...record,
        source: record.source || `${databasePath}#records/${record.id}`,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      throw new DkbError(`Unable to append SQLite record ${record.id} in ${databasePath}: ${reason}`);
    } finally {
      database.close();
    }
  }
}

function selectedRowEvidence(
  database: DatabaseSync,
  record: DkbExecuteReadPlanInput['record'],
  query: DkbExecuteReadPlanInput['query'],
  sourceUnits: NonNullable<DkbExecuteReadPlanInput['sourceUnits']>,
): { rows: Array<Record<string, unknown>>; tables: string[] } {
  const allowedTables = new Set(tablesForRecord(record));
  const result: Array<Record<string, unknown>> = [];
  const tables = new Set<string>();
  const limit = boundedLimit(query.limit, record.queryable);

  for (const unit of sourceUnits) {
    if (result.length >= limit) {
      break;
    }

    const table = typeof unit.locator.table === 'string' ? unit.locator.table : null;

    if (!table || !allowedTables.has(table)) {
      continue;
    }

    const columns = database.prepare(`pragma table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; type: string }>;
    const scalarColumns = columns
      .filter((column) => sqliteType(column.type) !== 'unknown')
      .map((column) => column.name)
      .slice(0, 20);

    if (scalarColumns.length === 0) {
      continue;
    }

    const requestedFields = table === record.sourceRef?.locator.table
      ? returnFields(query, record.queryable).filter((field) => scalarColumns.includes(field))
      : [];
    const fields = requestedFields.length > 0 ? requestedFields : scalarColumns;
    const selector = rowSelector(unit.locator, columns);

    if (!selector) {
      continue;
    }

    const rows = database
      .prepare(`select ${fields.map(quoteIdentifier).join(', ')} from ${quoteIdentifier(table)} where ${selector.sql} limit 1`)
      .all(sqlParam(selector.value)) as Array<Record<string, unknown>>;

    for (const row of rows) {
      result.push(row);
      tables.add(table);
    }
  }

  return {
    rows: result,
    tables: [...tables].sort((left, right) => left.localeCompare(right)),
  };
}

function tablesForRecord(record: DkbExecuteReadPlanInput['record']): string[] {
  const locator = record.sourceRef?.locator ?? {};
  const tables = Array.isArray(locator.tables)
    ? locator.tables.filter((item): item is string => typeof item === 'string')
    : [];
  const table = typeof locator.table === 'string' ? locator.table : null;

  return tables.length > 0 ? tables : table ? [table] : [];
}

function rowSelector(locator: Record<string, unknown>, columns: Array<{ name: string }>): { sql: string; value: unknown } | null {
  if (typeof locator.rowid === 'number') {
    return {
      sql: 'rowid = ?',
      value: locator.rowid,
    };
  }

  const primaryKey = locator.primaryKey;

  if (primaryKey && typeof primaryKey === 'object' && !Array.isArray(primaryKey)) {
    const field = 'field' in primaryKey ? primaryKey.field : undefined;
    const value = 'value' in primaryKey ? primaryKey.value : undefined;

    if (typeof field === 'string' && columns.some((column) => column.name === field)) {
      return {
        sql: `${quoteIdentifier(field)} = ?`,
        value,
      };
    }
  }

  return null;
}

function rowSourceUnits(
  database: DatabaseSync,
  table: string,
  columns: Array<{ name: string; type: string; pk?: number }>,
  dkbId: string,
  storeId: string,
  regionId: string,
): KnowledgeSourceUnit[] {
  const scalarColumns = columns
    .filter((column) => sqliteType(column.type) !== 'unknown')
    .map((column) => column.name)
    .slice(0, 32);

  if (scalarColumns.length === 0) {
    return [];
  }

  const primaryKey = columns
    .filter((column) => typeof column.pk === 'number' && column.pk > 0)
    .sort((left, right) => (left.pk ?? 0) - (right.pk ?? 0))[0]?.name;
  const selectFields = ['rowid as __dkb_rowid', ...scalarColumns.map(quoteIdentifier)].join(', ');
  let rows: Array<Record<string, unknown>>;

  try {
    rows = database.prepare(`select ${selectFields} from ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>;
  } catch {
    rows = database
      .prepare(`select ${scalarColumns.map(quoteIdentifier).join(', ')} from ${quoteIdentifier(table)}`)
      .all() as Array<Record<string, unknown>>;
  }

  return rows.flatMap((row, index) => {
    const rowid = row.__dkb_rowid;
    const pkValue = primaryKey ? row[primaryKey] : undefined;
    const hasRowid = typeof rowid === 'number' || typeof rowid === 'bigint';
    const hasPrimaryKey = Boolean(primaryKey && pkValue !== undefined);

    if (!hasRowid && !hasPrimaryKey) {
      return [];
    }

    const locator = {
      table,
      type: 'row',
      ...(hasRowid ? { rowid: Number(rowid) } : {}),
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

    return [{
      locator,
      title: `${table} row ${primaryKey && pkValue !== undefined ? String(pkValue) : index + 1}`,
      text,
      hash: stableHash({
        dkbId,
        storeId,
        regionId,
        table,
        locator,
        text,
      }),
    }];
  });
}

function parseMetadata(value: string | null, databasePath: string, id: string): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new DkbError(`Invalid metadata_json for SQLite record ${id} in ${databasePath}`);
  }
}

function normalizeRow(row: SqliteRecordRow, databasePath: string): KnowledgeRegion {
  const metadata = parseMetadata(row.metadata_json, databasePath, row.id);
  const topics = normalizeStringArray(metadata?.topics ?? metadata?.topic);
  const entities = normalizeStringArray(metadata?.entities ?? metadata?.entity);
  const updatedAt = typeof metadata?.updatedAt === 'string' ? metadata.updatedAt : null;

  if (topics.length === 0 || entities.length === 0 || !updatedAt) {
    throw new DkbError(`Invalid SQLite record ${row.id} in ${databasePath}: topics, entities, and updatedAt are required`);
  }

  return {
    id: row.id,
    title: row.title,
    content: row.content,
    source: row.source || `${databasePath}#records/${row.id}`,
    topics,
    entities,
    updatedAt,
    aliases: normalizeStringArray(metadata?.aliases),
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))].sort((a, b) => a.localeCompare(b));
  }

  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function sampleTextValues(database: DatabaseSync, table: string, columns: Array<{ name: string; type: string }>): string[] {
  const textColumns = columns
    .filter((column) => sqliteType(column.type) === 'string')
    .map((column) => column.name)
    .slice(0, 8);

  if (textColumns.length === 0) {
    return [];
  }

  const rows = database
    .prepare(`select ${textColumns.map(quoteIdentifier).join(', ')} from ${quoteIdentifier(table)} limit 12`)
    .all() as Array<Record<string, unknown>>;

  return unique(rows.flatMap((row) => textColumns.flatMap((column) => {
    const value = row[column];

    if (typeof value !== 'string') {
      return [];
    }

    const trimmed = value.replace(/\s+/g, ' ').trim();

    return trimmed ? [`${table}.${column}: ${trimmed.slice(0, 180)}`] : [];
  }))).slice(0, 24);
}

function tableComponents(database: DatabaseSync, tableNames: string[]): string[][] {
  const neighbors = new Map(tableNames.map((table) => [table, new Set<string>()]));
  const knownTables = new Set(tableNames);

  for (const table of tableNames) {
    const foreignKeys = database.prepare(`pragma foreign_key_list(${quoteIdentifier(table)})`).all() as Array<{ table: string }>;

    for (const foreignKey of foreignKeys) {
      if (!knownTables.has(foreignKey.table)) {
        continue;
      }

      neighbors.get(table)?.add(foreignKey.table);
      neighbors.get(foreignKey.table)?.add(table);
    }
  }

  const visited = new Set<string>();
  const groups: string[][] = [];

  for (const table of tableNames) {
    if (visited.has(table)) {
      continue;
    }

    const group: string[] = [];
    const stack = [table];

    while (stack.length > 0) {
      const current = stack.pop()!;

      if (visited.has(current)) {
        continue;
      }

      visited.add(current);
      group.push(current);

      for (const neighbor of neighbors.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }

    groups.push(group.sort((a, b) => a.localeCompare(b)));
  }

  return groups.sort((a, b) => a[0].localeCompare(b[0]));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
