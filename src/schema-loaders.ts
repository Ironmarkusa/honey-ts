/**
 * Schema introspection loaders — build a `DatabaseSchema` from a live
 * database, so the query builder and validators run against reality instead
 * of a hand-maintained schema object.
 *
 * Driver-agnostic by design: you pass an executor function, not a client, so
 * honey-ts takes no dependency on pg / postgres.js / @duckdb/node-api. The
 * executor runs a SQL string and resolves to an array of row objects:
 *
 * ```ts
 * import { Client } from "pg";
 * const client = new Client(...);
 * const schema = await schemaFromPostgres(async (sql) =>
 *   (await client.query(sql)).rows
 * );
 *
 * import { DuckDBInstance } from "@duckdb/node-api";
 * const conn = await (await DuckDBInstance.create("db.duckdb")).connect();
 * const schema = await schemaFromDuckDb(async (sql) =>
 *   (await conn.run(sql)).getRowObjectsJson()
 * );
 * ```
 */

import type { DatabaseSchema, TableSchema, ColumnSchema } from "./builder.js";

/** Runs SQL, resolves to row objects. Provided by the caller's driver. */
export type SchemaExecutor = (
  sql: string
) => Promise<Array<Record<string, unknown>>>;

export interface SchemaLoadOptions {
  /** Schemas to introspect. Default: every non-system schema. */
  schemas?: string[];
}

interface RawColumn {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string | boolean;
}

interface RawKey {
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema?: string | null;
  foreign_table_name?: string | null;
  foreign_column_name?: string | null;
}

function schemaFilter(column: string, schemas?: string[]): string {
  if (schemas?.length) {
    return `${column} IN (${schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ")})`;
  }
  return `${column} NOT IN ('information_schema', 'pg_catalog', 'pg_toast', 'system', 'temp', 'main_system')`;
}

function assemble(
  columns: RawColumn[],
  primaryKeys: RawKey[],
  foreignKeys: RawKey[]
): DatabaseSchema {
  const pk = new Set(
    primaryKeys.map((k) => `${k.table_schema}.${k.table_name}.${k.column_name}`)
  );
  const fk = new Map(
    foreignKeys.map((k) => [
      `${k.table_schema}.${k.table_name}.${k.column_name}`,
      { table: String(k.foreign_table_name), column: String(k.foreign_column_name) },
    ])
  );

  const tables = new Map<string, TableSchema>();
  for (const c of columns) {
    const key = `${c.table_schema}.${c.table_name}`;
    let table = tables.get(key);
    if (!table) {
      table = { name: c.table_name, schema: c.table_schema, columns: [] };
      tables.set(key, table);
    }
    const colKey = `${c.table_schema}.${c.table_name}.${c.column_name}`;
    const column: ColumnSchema = {
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === "YES" || c.is_nullable === true,
    };
    if (pk.has(colKey)) column.isPrimaryKey = true;
    const ref = fk.get(colKey);
    if (ref) {
      column.isForeignKey = true;
      column.references = ref;
    }
    table.columns.push(column);
  }

  return { tables: [...tables.values()] };
}

/**
 * Introspect a PostgreSQL database via information_schema.
 */
export async function schemaFromPostgres(
  execute: SchemaExecutor,
  options: SchemaLoadOptions = {}
): Promise<DatabaseSchema> {
  const where = schemaFilter("table_schema", options.schemas);

  const columns = (await execute(`
    SELECT table_schema, table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE ${where}
    ORDER BY table_schema, table_name, ordinal_position
  `)) as unknown as RawColumn[];

  const primaryKeys = (await execute(`
    SELECT tc.table_schema, tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY' AND ${schemaFilter("tc.table_schema", options.schemas)}
  `)) as unknown as RawKey[];

  const foreignKeys = (await execute(`
    SELECT
      tc.table_schema, tc.table_name, kcu.column_name,
      ccu.table_schema AS foreign_table_schema,
      ccu.table_name  AS foreign_table_name,
      ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ${schemaFilter("tc.table_schema", options.schemas)}
  `)) as unknown as RawKey[];

  return assemble(columns, primaryKeys, foreignKeys);
}

/**
 * Introspect a DuckDB database via its catalog functions. DuckDB has no
 * enforced foreign keys by default, so FK metadata comes from
 * duckdb_constraints() when present.
 */
export async function schemaFromDuckDb(
  execute: SchemaExecutor,
  options: SchemaLoadOptions = {}
): Promise<DatabaseSchema> {
  const where = schemaFilter("schema_name", options.schemas);

  const columns = (await execute(`
    SELECT schema_name AS table_schema, table_name, column_name,
           data_type, is_nullable
    FROM duckdb_columns()
    WHERE internal = false AND ${where}
    ORDER BY schema_name, table_name, column_index
  `)) as unknown as RawColumn[];

  // duckdb_constraints() exposes constraint_column_names as a LIST.
  const primaryKeys = (await execute(`
    SELECT schema_name AS table_schema, table_name,
           unnest(constraint_column_names) AS column_name
    FROM duckdb_constraints()
    WHERE constraint_type = 'PRIMARY KEY' AND ${where}
  `)) as unknown as RawKey[];

  const foreignKeys = (await execute(`
    SELECT schema_name AS table_schema, table_name,
           unnest(constraint_column_names) AS column_name,
           NULL AS foreign_table_schema,
           referenced_table AS foreign_table_name,
           unnest(referenced_column_names) AS foreign_column_name
    FROM duckdb_constraints()
    WHERE constraint_type = 'FOREIGN KEY' AND ${where}
  `)) as unknown as RawKey[];

  return assemble(columns, primaryKeys, foreignKeys);
}
