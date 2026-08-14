
import { Pool } from 'pg';
import { stableHash } from '../contracts/hash.js';
import { DkbError } from '../protocol/errors.js';
import type { DkbEvidence, KnowledgeRegion, LoadedDkb } from '../protocol/types.js';
import { sourceUnitsFromKnowledgeRegion } from '../indexes/sourceIndex.js';
import type { DkbCompileRegionsInput, DkbCompileSourceUnitsInput, DkbExecuteReadPlanInput, DkbReader, DkbReadPlanResult } from './adapter.js';
import { blocked, boundedLimit, complete, fieldsForColumns, quoteIdentifier, returnFields, sqliteType, validateDkbReadQuery, whereClause } from './sqlShared.js';

interface PgRelation {
  table_schema: string;
  table_name: string;
  table_type: 'BASE TABLE' | 'VIEW';
}

interface PgColumn {
  column_name: string;
  data_type: string;
}

interface PgFkEdge {
  source_schema: string;
  source_table: string;
  target_schema: string;
  target_table: string;
}

export class PostgresAdapter implements DkbReader {
  async readRecords(_dkb: LoadedDkb): Promise<KnowledgeRegion[]> {
    throw new DkbError('Postgres adapter does not expose readRecords; use compileRegions and DKB Read API execution');
  }

  async compileSourceUnits(input: DkbCompileSourceUnitsInput) {
    const regions = await this.compileRegions(input);

    return regions.flatMap(sourceUnitsFromKnowledgeRegion);
  }

  async compileRegions({ dkb, store }: DkbCompileRegionsInput) {
    const connectionString = connectionStringFor(store.connectionRef);
    const pool = new Pool({ connectionString });

    try {
      const relations = (await pool.query<PgRelation>(`
        select table_schema, table_name, table_type
        from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
          and table_type in ('BASE TABLE', 'VIEW')
        order by table_schema, table_name
      `)).rows;

      const fkEdges = (await pool.query<PgFkEdge>(`
        select
          tc.table_schema as source_schema,
          tc.table_name as source_table,
          ccu.table_schema as target_schema,
          ccu.table_name as target_table
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on tc.constraint_name = kcu.constraint_name
         and tc.table_schema = kcu.table_schema
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = tc.constraint_name
         and ccu.table_schema = tc.table_schema
        where tc.constraint_type = 'FOREIGN KEY'
      `)).rows;
      const tableRelations = relations.filter((relation) => relation.table_type === 'BASE TABLE');
      const tableGroups = relationComponents(tableRelations, fkEdges);
      const viewGroups = relations
        .filter((relation) => relation.table_type === 'VIEW')
        .map((relation) => [relation]);
      const groups = [...tableGroups, ...viewGroups];
      const records = [];

      for (const group of groups) {
        const relation = group[0];
        const columns = (await pool.query<PgColumn>(`
          select column_name, data_type
          from information_schema.columns
          where table_schema = $1 and table_name = $2
          order by ordinal_position
        `, [relation.table_schema, relation.table_name])).rows;
        const allColumns = (await Promise.all(group.map(async (item) => {
          const tableColumns = (await pool.query<PgColumn>(`
            select column_name, data_type
            from information_schema.columns
            where table_schema = $1 and table_name = $2
            order by ordinal_position
          `, [item.table_schema, item.table_name])).rows;

          return tableColumns.map((column) => `${item.table_schema}.${item.table_name}.${column.column_name}`);
        }))).flat();
        const sample = await sampleTextValues(pool, relation.table_schema, relation.table_name, columns);
        const fields = fieldsForColumns(columns.map((column) => ({
          name: column.column_name,
          type: column.data_type,
        })));
        const relationKind = relation.table_type === 'VIEW' ? 'view' as const : group.length > 1 ? 'table_group' as const : 'table' as const;
        const groupNames = group.map((item) => `${item.table_schema}.${item.table_name}`);
        const summary = [
          `Postgres ${relationKind === 'table_group' ? 'FK table group' : relationKind} ${groupNames.join(', ')} with primary table ${relation.table_schema}.${relation.table_name}.`,
          `Queryable primary columns: ${columns.map((column) => column.column_name).join(', ')}.`,
          group.length > 1 ? `Grouped columns: ${allColumns.join(', ')}.` : null,
          sample.length > 0 ? `Search sample: ${sample.join(' ')}` : null,
        ].filter(Boolean).join(' ');
        const schemaHash = stableHash({ group: groupNames, relationKind, columns, allColumns, sample });

        records.push({
          id: relationKind === 'table_group'
            ? `table_group:${groupNames.join('+')}`
            : `${relationKind}:${relation.table_schema}.${relation.table_name}`,
          dkbId: dkb.manifest.id,
          title: groupNames.join(' + '),
          content: summary,
          source: `${store.connectionRef ?? 'postgres'}#${groupNames.join('+')}`,
          topics: unique([...(dkb.manifest.domains ?? []), ...group.flatMap((item) => [item.table_schema, item.table_name])]),
          entities: unique([...columns.map((column) => column.column_name), ...allColumns]),
          updatedAt: schemaHash,
          aliases: unique(groupNames),
          regionType: relationKind,
          relationships: group.length > 1
            ? group.slice(1).map((item) => ({ type: 'foreign_key' as const, regionId: `table:${item.table_schema}.${item.table_name}` }))
            : [],
          grouping: {
            strategy: group.length > 1 ? 'database_foreign_keys' as const : 'single_source' as const,
            reason: group.length > 1
              ? 'Postgres tables share foreign-key relationships and compile into one adapter-bounded Knowledge Region.'
              : 'Postgres relation has no compiled FK partner and remains a standalone Knowledge Region.',
          },
          sourceRef: {
            storeId: store.id,
            type: 'postgres' as const,
            locator: {
              schema: relation.table_schema,
              table: relation.table_name,
              primaryTable: relation.table_name,
              tables: groupNames,
              type: relationKind,
            },
            hash: schemaHash,
          },
          queryable: {
            operations: ['lookup' as const, 'search' as const, 'aggregate' as const],
            fields,
            defaultLimit: 20,
            maxLimit: 100,
          },
          storeIds: [store.id],
        });
      }

      return records;
    } finally {
      await pool.end();
    }
  }

  async executeReadPlan({ dkb, store, record, query }: DkbExecuteReadPlanInput): Promise<DkbReadPlanResult> {
    const connectionStringResult = tryConnectionStringFor(store.connectionRef);

    if (!connectionStringResult.ok) {
      return blocked(query, 'missing_connection', connectionStringResult.message, { storeId: store.id, connectionRef: store.connectionRef ?? null });
    }

    const schema = typeof record.sourceRef?.locator.schema === 'string' ? record.sourceRef.locator.schema : 'public';
    const table = typeof record.sourceRef?.locator.table === 'string' ? record.sourceRef.locator.table : null;

    if (!table) {
      return blocked(query, 'source_unavailable', `Postgres target has no table locator: ${dkb.manifest.id}/${record.id}`, { target: record.id });
    }

    const validation = validateDkbReadQuery(query, record.queryable);

    if (validation) {
      return blocked(query, validation.reason, validation.message, { target: `${dkb.manifest.id}/${record.id}` });
    }

    const pool = new Pool({ connectionString: connectionStringResult.value });

    try {
      const { where, params } = whereClause(query, record.queryable, (index) => `$${index}`);
      const limit = boundedLimit(query.limit, record.queryable);
      const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

      if (query.operation === 'aggregate') {
        if (query.metric !== 'count') {
          return blocked(query, 'unsupported_operation', 'Only count aggregates are currently supported', { metric: query.metric ?? null });
        }

        const result = await pool.query<{ count: string }>(`select count(*)::text as count from ${relation}${where}`, [...params]);

        return complete(query, [{
          type: 'aggregate',
          label: `count:${schema}.${table}`,
          value: Number.parseInt(result.rows[0]?.count ?? '0', 10),
          source: record.sourceRef!,
        }], {
          adapter: 'postgres',
          dkbId: dkb.manifest.id,
          storeId: store.id,
          schema,
          table,
          rowsRead: 1,
        });
      }

      const fields = returnFields(query, record.queryable);
      const limitPlaceholder = `$${params.length + 1}`;
      const result = await pool.query<Record<string, unknown>>(
        `select ${fields.map(quoteIdentifier).join(', ')} from ${relation}${where} limit ${limitPlaceholder}`,
        [...params, limit],
      );

      return result.rows.length > 0
        ? complete(query, [{
            type: 'rows',
            label: `${schema}.${table}`,
            rows: result.rows,
            source: record.sourceRef!,
          } satisfies DkbEvidence], {
            adapter: 'postgres',
            dkbId: dkb.manifest.id,
            storeId: store.id,
            schema,
            table,
            fields,
            filters: query.filters ?? [],
            rowsRead: result.rowCount ?? result.rows.length,
          })
        : blocked(query, 'no_results', 'DKB read query returned no rows.', {
            adapter: 'postgres',
            dkbId: dkb.manifest.id,
            storeId: store.id,
            schema,
            table,
            fields,
            filters: query.filters ?? [],
            rowsRead: 0,
          });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      return blocked(query, 'source_unavailable', `Postgres DKB read query failed: ${reason}`, {
        adapter: 'postgres',
        dkbId: dkb.manifest.id,
        storeId: store.id,
      });
    } finally {
      await pool.end();
    }
  }
}

async function sampleTextValues(pool: Pool, schema: string, table: string, columns: PgColumn[]): Promise<string[]> {
  const textColumns = columns
    .filter((column) => sqliteType(column.data_type) === 'string')
    .map((column) => column.column_name)
    .slice(0, 8);

  if (textColumns.length === 0) {
    return [];
  }

  const result = await pool.query<Record<string, unknown>>(
    `select ${textColumns.map(quoteIdentifier).join(', ')} from ${quoteIdentifier(schema)}.${quoteIdentifier(table)} limit 12`,
  );

  return unique(result.rows.flatMap((row) => textColumns.flatMap((column) => {
    const value = row[column];

    if (typeof value !== 'string') {
      return [];
    }

    const trimmed = value.replace(/\s+/g, ' ').trim();

    return trimmed ? [trimmed.slice(0, 180)] : [];
  }))).slice(0, 24);
}

function relationComponents(relations: PgRelation[], edges: PgFkEdge[]): PgRelation[][] {
  const byKey = new Map(relations.map((relation) => [relationKey(relation.table_schema, relation.table_name), relation]));
  const neighbors = new Map([...byKey.keys()].map((key) => [key, new Set<string>()]));

  for (const edge of edges) {
    const source = relationKey(edge.source_schema, edge.source_table);
    const target = relationKey(edge.target_schema, edge.target_table);

    if (!byKey.has(source) || !byKey.has(target)) {
      continue;
    }

    neighbors.get(source)?.add(target);
    neighbors.get(target)?.add(source);
  }

  const visited = new Set<string>();
  const groups: PgRelation[][] = [];

  for (const key of [...byKey.keys()].sort((a, b) => a.localeCompare(b))) {
    if (visited.has(key)) {
      continue;
    }

    const group: PgRelation[] = [];
    const stack = [key];

    while (stack.length > 0) {
      const current = stack.pop()!;

      if (visited.has(current)) {
        continue;
      }

      visited.add(current);
      group.push(byKey.get(current)!);

      for (const neighbor of neighbors.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }

    groups.push(group.sort((a, b) => relationKey(a.table_schema, a.table_name).localeCompare(relationKey(b.table_schema, b.table_name))));
  }

  return groups;
}

function relationKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function connectionStringFor(connectionRef: string | undefined): string {
  const result = tryConnectionStringFor(connectionRef);

  if (!result.ok) {
    throw new DkbError(result.message);
  }

  return result.value;
}

function tryConnectionStringFor(connectionRef: string | undefined): { ok: true; value: string } | { ok: false; message: string } {
  if (!connectionRef) {
    return {
      ok: false,
      message: 'Postgres store requires connectionRef',
    };
  }

  const match = connectionRef.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);

  if (!match) {
    return {
      ok: false,
      message: `Unsupported Postgres connectionRef: ${connectionRef}`,
    };
  }

  const value = process.env[match[1]];

  if (!value) {
    return {
      ok: false,
      message: `Missing Postgres connection environment variable: ${match[1]}`,
    };
  }

  return {
    ok: true,
    value,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
