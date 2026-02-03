/**
 * HoneySQL TypeScript - Schema-Aware Query Builder
 *
 * Provides context-aware suggestions and granular manipulation
 * for building SQL queries. Designed as a foundation for UI components.
 */

import type { SqlClause, SqlExpr } from "./types.js";

// ============================================================================
// Schema Types
// ============================================================================

/**
 * Column definition from database schema.
 */
export interface ColumnSchema {
  name: string;
  type: string;  // PostgreSQL type: integer, text, timestamp, jsonb, etc.
  nullable: boolean;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  references?: {
    table: string;
    column: string;
  };
}

/**
 * Table definition from database schema.
 */
export interface TableSchema {
  name: string;
  schema: string;  // "public", "staging", etc.
  columns: ColumnSchema[];
}

/**
 * Full database schema.
 */
export interface DatabaseSchema {
  tables: TableSchema[];
}

// ============================================================================
// Query Builder
// ============================================================================

/**
 * Schema-aware query builder for UI components.
 */
export interface QueryBuilder {
  schema: DatabaseSchema;

  // === Table Suggestions ===

  /** Get all tables available for FROM clause */
  getTablesForFrom(): TableSchema[];

  /** Get tables that can be joined to the current query */
  getJoinableTables(clause: SqlClause): Array<{
    table: TableSchema;
    suggestedOn: SqlExpr;  // suggested join condition based on FKs
    joinType: "inner" | "left";
  }>;

  // === Column Suggestions ===

  /** Get columns available for SELECT (from tables in FROM/JOIN) */
  getColumnsForSelect(clause: SqlClause): Array<{
    column: ColumnSchema;
    table: TableSchema;
    qualified: string;  // "users.email"
  }>;

  /** Get columns available for WHERE */
  getColumnsForWhere(clause: SqlClause): Array<{
    column: ColumnSchema;
    table: TableSchema;
    qualified: string;
  }>;

  /** Get columns available for ORDER BY */
  getColumnsForOrderBy(clause: SqlClause): Array<{
    column: ColumnSchema;
    table: TableSchema;
    qualified: string;
  }>;

  /** Get columns available for GROUP BY */
  getColumnsForGroupBy(clause: SqlClause): Array<{
    column: ColumnSchema;
    table: TableSchema;
    qualified: string;
  }>;

  // === Operator/Function Suggestions ===

  /** Get valid operators for a column type */
  getOperatorsForType(type: string): OperatorInfo[];

  /** Get valid functions for a column type */
  getFunctionsForType(type: string): FunctionInfo[];

  /** Get aggregate functions */
  getAggregateFunctions(): FunctionInfo[];

  // === Clause Manipulation ===

  /** Add a table to FROM clause */
  addFrom(clause: SqlClause, table: string, alias?: string): SqlClause;

  /** Add a column to SELECT */
  addSelect(clause: SqlClause, column: string | SqlExpr, alias?: string): SqlClause;

  /** Remove a column from SELECT by alias */
  removeSelect(clause: SqlClause, alias: string): SqlClause;

  /** Add a JOIN */
  addJoin(
    clause: SqlClause,
    table: string,
    on: SqlExpr,
    type?: "inner" | "left" | "right" | "full",
    alias?: string
  ): SqlClause;

  /** Add a WHERE condition (ANDs with existing) */
  addWhere(clause: SqlClause, condition: SqlExpr): SqlClause;

  /** Remove a WHERE condition */
  removeWhere(clause: SqlClause, index: number): SqlClause;

  /** Set ORDER BY */
  setOrderBy(clause: SqlClause, orderBy: Array<[string, "asc" | "desc"]>): SqlClause;

  /** Add to ORDER BY */
  addOrderBy(clause: SqlClause, column: string, direction?: "asc" | "desc"): SqlClause;

  /** Set GROUP BY */
  setGroupBy(clause: SqlClause, columns: string[]): SqlClause;

  /** Set LIMIT */
  setLimit(clause: SqlClause, limit: number): SqlClause;

  /** Set OFFSET */
  setOffset(clause: SqlClause, offset: number): SqlClause;

  /** Clear a clause key */
  clear(clause: SqlClause, key: "where" | "order-by" | "group-by" | "limit" | "offset"): SqlClause;

  // === Query Analysis ===

  /** Get tables currently in the query (FROM + JOINs) */
  getTablesInQuery(clause: SqlClause): Array<{
    table: TableSchema;
    alias: string;
  }>;

  /** Validate query against schema */
  validate(clause: SqlClause): ValidationResult;
}

/**
 * Operator info for UI display.
 */
export interface OperatorInfo {
  op: string;           // "=", "<>", "like", etc.
  label: string;        // "equals", "not equals", "contains", etc.
  valueType: "single" | "none" | "list" | "range";  // what kind of value input
  valueInputType?: string;  // "text", "number", "date", "select", etc.
}

/**
 * Function info for UI display.
 */
export interface FunctionInfo {
  name: string;         // "%lower", "%count", etc.
  label: string;        // "LOWER", "COUNT", etc.
  description: string;  // "Convert to lowercase"
  returnType: string;   // return type
  args: Array<{
    name: string;
    type: string;
    optional?: boolean;
  }>;
}

/**
 * Validation result.
 */
export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;       // "select[0]", "where", etc.
    message: string;
    code: string;       // "unknown_column", "type_mismatch", etc.
  }>;
  warnings: Array<{
    path: string;
    message: string;
    code: string;
  }>;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a schema-aware query builder.
 */
export function createQueryBuilder(schema: DatabaseSchema): QueryBuilder {
  const tableMap = new Map<string, TableSchema>();
  for (const table of schema.tables) {
    tableMap.set(table.name, table);
    tableMap.set(`${table.schema}.${table.name}`, table);
  }

  function getTable(name: string): TableSchema | undefined {
    return tableMap.get(name);
  }

  function getTablesInClause(clause: SqlClause): Array<{ table: TableSchema; alias: string }> {
    const result: Array<{ table: TableSchema; alias: string }> = [];

    // FROM clause
    if (clause.from) {
      const fromItems = Array.isArray(clause.from) ? clause.from : [clause.from];
      for (const item of fromItems) {
        if (typeof item === "string") {
          const t = getTable(item);
          if (t) result.push({ table: t, alias: item });
        } else if (Array.isArray(item) && item.length === 2) {
          const [name, alias] = item;
          if (typeof name === "string" && typeof alias === "string") {
            const t = getTable(name);
            if (t) result.push({ table: t, alias });
          }
        }
      }
    }

    // JOINs
    for (const joinType of ["join", "left-join", "right-join", "inner-join", "full-join"] as const) {
      const joins = clause[joinType] as [SqlExpr, SqlExpr][] | undefined;
      if (joins) {
        for (const [tableExpr] of joins) {
          if (typeof tableExpr === "string") {
            const t = getTable(tableExpr);
            if (t) result.push({ table: t, alias: tableExpr });
          } else if (Array.isArray(tableExpr) && tableExpr.length === 2) {
            const [name, alias] = tableExpr;
            if (typeof name === "string" && typeof alias === "string") {
              const t = getTable(name);
              if (t) result.push({ table: t, alias });
            }
          }
        }
      }
    }

    return result;
  }

  function getAvailableColumns(clause: SqlClause): Array<{
    column: ColumnSchema;
    table: TableSchema;
    qualified: string;
  }> {
    const tables = getTablesInClause(clause);
    const result: Array<{ column: ColumnSchema; table: TableSchema; qualified: string }> = [];

    for (const { table, alias } of tables) {
      for (const column of table.columns) {
        result.push({
          column,
          table,
          qualified: `${alias}.${column.name}`,
        });
      }
    }

    return result;
  }

  return {
    schema,

    // === Table Suggestions ===

    getTablesForFrom(): TableSchema[] {
      return schema.tables;
    },

    getJoinableTables(clause: SqlClause) {
      const inQuery = getTablesInClause(clause);
      const inQueryNames = new Set(inQuery.map(t => t.table.name));
      const result: Array<{ table: TableSchema; suggestedOn: SqlExpr; joinType: "inner" | "left" }> = [];

      for (const table of schema.tables) {
        if (inQueryNames.has(table.name)) continue;

        // Check for FK relationships
        for (const col of table.columns) {
          if (col.references) {
            const refTable = inQuery.find(t => t.table.name === col.references!.table);
            if (refTable) {
              result.push({
                table,
                suggestedOn: ["=", `${table.name}.${col.name}`, `${refTable.alias}.${col.references.column}`],
                joinType: col.nullable ? "left" : "inner",
              });
            }
          }
        }

        // Check if tables in query have FKs to this table
        for (const { table: queryTable, alias } of inQuery) {
          for (const col of queryTable.columns) {
            if (col.references?.table === table.name) {
              result.push({
                table,
                suggestedOn: ["=", `${alias}.${col.name}`, `${table.name}.${col.references.column}`],
                joinType: col.nullable ? "left" : "inner",
              });
            }
          }
        }
      }

      return result;
    },

    // === Column Suggestions ===

    getColumnsForSelect(clause: SqlClause) {
      return getAvailableColumns(clause);
    },

    getColumnsForWhere(clause: SqlClause) {
      return getAvailableColumns(clause);
    },

    getColumnsForOrderBy(clause: SqlClause) {
      return getAvailableColumns(clause);
    },

    getColumnsForGroupBy(clause: SqlClause) {
      return getAvailableColumns(clause);
    },

    // === Operator/Function Suggestions ===

    getOperatorsForType(type: string): OperatorInfo[] {
      const common: OperatorInfo[] = [
        { op: "=", label: "equals", valueType: "single" },
        { op: "<>", label: "not equals", valueType: "single" },
        { op: "is", label: "is null", valueType: "none" },
        { op: "is-not", label: "is not null", valueType: "none" },
        { op: "in", label: "in list", valueType: "list" },
        { op: "not-in", label: "not in list", valueType: "list" },
      ];

      const numeric: OperatorInfo[] = [
        { op: "<", label: "less than", valueType: "single", valueInputType: "number" },
        { op: "<=", label: "less or equal", valueType: "single", valueInputType: "number" },
        { op: ">", label: "greater than", valueType: "single", valueInputType: "number" },
        { op: ">=", label: "greater or equal", valueType: "single", valueInputType: "number" },
        { op: "between", label: "between", valueType: "range", valueInputType: "number" },
      ];

      const text: OperatorInfo[] = [
        { op: "like", label: "contains", valueType: "single", valueInputType: "text" },
        { op: "ilike", label: "contains (case insensitive)", valueType: "single", valueInputType: "text" },
        { op: "~", label: "matches regex", valueType: "single", valueInputType: "text" },
        { op: "~*", label: "matches regex (case insensitive)", valueType: "single", valueInputType: "text" },
      ];

      const json: OperatorInfo[] = [
        { op: "->", label: "get JSON field", valueType: "single", valueInputType: "text" },
        { op: "->>", label: "get JSON field as text", valueType: "single", valueInputType: "text" },
        { op: "@>", label: "contains JSON", valueType: "single", valueInputType: "text" },
        { op: "?", label: "has key", valueType: "single", valueInputType: "text" },
      ];

      const array: OperatorInfo[] = [
        { op: "@>", label: "contains", valueType: "list" },
        { op: "<@", label: "contained by", valueType: "list" },
        { op: "&&", label: "overlaps", valueType: "list" },
      ];

      const normalized = type.toLowerCase();

      if (["integer", "bigint", "smallint", "numeric", "decimal", "real", "double precision"].includes(normalized)) {
        return [...common, ...numeric];
      }

      if (["text", "varchar", "char", "character varying"].includes(normalized)) {
        return [...common, ...numeric, ...text];
      }

      if (["timestamp", "timestamptz", "date", "time"].includes(normalized)) {
        return [...common, ...numeric];
      }

      if (["json", "jsonb"].includes(normalized)) {
        return [...common, ...json];
      }

      if (normalized.endsWith("[]") || normalized === "array") {
        return [...common, ...array];
      }

      return common;
    },

    getFunctionsForType(type: string): FunctionInfo[] {
      const text: FunctionInfo[] = [
        { name: "%lower", label: "LOWER", description: "Convert to lowercase", returnType: "text", args: [{ name: "text", type: "text" }] },
        { name: "%upper", label: "UPPER", description: "Convert to uppercase", returnType: "text", args: [{ name: "text", type: "text" }] },
        { name: "%trim", label: "TRIM", description: "Remove whitespace", returnType: "text", args: [{ name: "text", type: "text" }] },
        { name: "%length", label: "LENGTH", description: "String length", returnType: "integer", args: [{ name: "text", type: "text" }] },
        { name: "%substring", label: "SUBSTRING", description: "Extract substring", returnType: "text", args: [{ name: "text", type: "text" }, { name: "start", type: "integer" }, { name: "length", type: "integer", optional: true }] },
        { name: "%concat", label: "CONCAT", description: "Concatenate strings", returnType: "text", args: [{ name: "values", type: "text[]" }] },
      ];

      const numeric: FunctionInfo[] = [
        { name: "%abs", label: "ABS", description: "Absolute value", returnType: "numeric", args: [{ name: "n", type: "numeric" }] },
        { name: "%round", label: "ROUND", description: "Round to nearest", returnType: "numeric", args: [{ name: "n", type: "numeric" }, { name: "places", type: "integer", optional: true }] },
        { name: "%floor", label: "FLOOR", description: "Round down", returnType: "numeric", args: [{ name: "n", type: "numeric" }] },
        { name: "%ceil", label: "CEIL", description: "Round up", returnType: "numeric", args: [{ name: "n", type: "numeric" }] },
      ];

      const datetime: FunctionInfo[] = [
        { name: "%date_trunc", label: "DATE_TRUNC", description: "Truncate to precision", returnType: "timestamp", args: [{ name: "precision", type: "text" }, { name: "timestamp", type: "timestamp" }] },
        { name: "%extract", label: "EXTRACT", description: "Extract date part", returnType: "numeric", args: [{ name: "field", type: "text" }, { name: "timestamp", type: "timestamp" }] },
        { name: "%age", label: "AGE", description: "Difference between timestamps", returnType: "interval", args: [{ name: "timestamp1", type: "timestamp" }, { name: "timestamp2", type: "timestamp", optional: true }] },
      ];

      const json: FunctionInfo[] = [
        { name: "%jsonb_extract_path", label: "JSONB_EXTRACT_PATH", description: "Extract JSON path", returnType: "jsonb", args: [{ name: "json", type: "jsonb" }, { name: "path", type: "text[]" }] },
        { name: "%jsonb_array_elements", label: "JSONB_ARRAY_ELEMENTS", description: "Expand JSON array", returnType: "setof jsonb", args: [{ name: "json", type: "jsonb" }] },
      ];

      const general: FunctionInfo[] = [
        { name: "%coalesce", label: "COALESCE", description: "Return first non-null", returnType: "any", args: [{ name: "values", type: "any[]" }] },
        { name: "%nullif", label: "NULLIF", description: "Return null if equal", returnType: "any", args: [{ name: "value1", type: "any" }, { name: "value2", type: "any" }] },
      ];

      const normalized = type.toLowerCase();

      if (["text", "varchar", "char", "character varying"].includes(normalized)) {
        return [...general, ...text];
      }

      if (["integer", "bigint", "smallint", "numeric", "decimal", "real", "double precision"].includes(normalized)) {
        return [...general, ...numeric];
      }

      if (["timestamp", "timestamptz", "date", "time"].includes(normalized)) {
        return [...general, ...datetime];
      }

      if (["json", "jsonb"].includes(normalized)) {
        return [...general, ...json];
      }

      return general;
    },

    getAggregateFunctions(): FunctionInfo[] {
      return [
        { name: "%count", label: "COUNT", description: "Count rows", returnType: "bigint", args: [{ name: "column", type: "any", optional: true }] },
        { name: "%count-distinct", label: "COUNT DISTINCT", description: "Count unique values", returnType: "bigint", args: [{ name: "column", type: "any" }] },
        { name: "%sum", label: "SUM", description: "Sum values", returnType: "numeric", args: [{ name: "column", type: "numeric" }] },
        { name: "%avg", label: "AVG", description: "Average value", returnType: "numeric", args: [{ name: "column", type: "numeric" }] },
        { name: "%min", label: "MIN", description: "Minimum value", returnType: "any", args: [{ name: "column", type: "any" }] },
        { name: "%max", label: "MAX", description: "Maximum value", returnType: "any", args: [{ name: "column", type: "any" }] },
        { name: "%array_agg", label: "ARRAY_AGG", description: "Aggregate into array", returnType: "array", args: [{ name: "column", type: "any" }] },
        { name: "%string_agg", label: "STRING_AGG", description: "Concatenate with delimiter", returnType: "text", args: [{ name: "column", type: "text" }, { name: "delimiter", type: "text" }] },
      ];
    },

    // === Clause Manipulation ===

    addFrom(clause: SqlClause, table: string, alias?: string): SqlClause {
      const tableExpr: SqlExpr = alias ? [table, alias] : table;
      const existing = clause.from;

      if (!existing) {
        return { ...clause, from: tableExpr };
      }

      const fromArray = Array.isArray(existing) ? existing : [existing];
      return { ...clause, from: [...fromArray, tableExpr] };
    },

    addSelect(clause: SqlClause, column: string | SqlExpr, alias?: string): SqlClause {
      const selectExpr: SqlExpr = alias ? [column, alias] : column;
      const existing = clause.select;

      if (!existing) {
        return { ...clause, select: [selectExpr] };
      }

      const selectArray = Array.isArray(existing) ? existing : [existing];
      return { ...clause, select: [...selectArray, selectExpr] };
    },

    removeSelect(clause: SqlClause, alias: string): SqlClause {
      if (!clause.select) return clause;

      const selectArray = Array.isArray(clause.select) ? clause.select : [clause.select];
      const filtered = selectArray.filter((item) => {
        if (typeof item === "string") return item !== alias;
        if (Array.isArray(item) && item.length === 2 && typeof item[1] === "string") {
          return item[1] !== alias;
        }
        return true;
      });

      return { ...clause, select: filtered.length > 0 ? filtered : undefined };
    },

    addJoin(
      clause: SqlClause,
      table: string,
      on: SqlExpr,
      type: "inner" | "left" | "right" | "full" = "inner",
      alias?: string
    ): SqlClause {
      const tableExpr: SqlExpr = alias ? [table, alias] : table;
      const joinKey = type === "inner" ? "join" : `${type}-join`;
      const existing = clause[joinKey] as [SqlExpr, SqlExpr][] | undefined;

      return {
        ...clause,
        [joinKey]: [...(existing ?? []), [tableExpr, on]],
      };
    },

    addWhere(clause: SqlClause, condition: SqlExpr): SqlClause {
      if (!clause.where) {
        return { ...clause, where: condition };
      }
      return { ...clause, where: ["and", clause.where, condition] };
    },

    removeWhere(clause: SqlClause, index: number): SqlClause {
      if (!clause.where) return clause;

      // If it's an AND, remove from the list
      if (Array.isArray(clause.where) && clause.where[0] === "and") {
        const conditions = clause.where.slice(1);
        if (index >= 0 && index < conditions.length) {
          const remaining = conditions.filter((_, i) => i !== index);
          if (remaining.length === 0) {
            const { where, ...rest } = clause;
            return rest;
          }
          if (remaining.length === 1) {
            return { ...clause, where: remaining[0] as SqlExpr };
          }
          return { ...clause, where: ["and", ...remaining] };
        }
      }

      // Single condition - just remove it
      if (index === 0) {
        const { where, ...rest } = clause;
        return rest;
      }

      return clause;
    },

    setOrderBy(clause: SqlClause, orderBy: Array<[string, "asc" | "desc"]>): SqlClause {
      if (orderBy.length === 0) {
        const { "order-by": _, ...rest } = clause;
        return rest;
      }
      return { ...clause, "order-by": orderBy };
    },

    addOrderBy(clause: SqlClause, column: string, direction: "asc" | "desc" = "asc"): SqlClause {
      const existing = clause["order-by"] as Array<[string, "asc" | "desc"]> | undefined;
      return {
        ...clause,
        "order-by": [...(existing ?? []), [column, direction]],
      };
    },

    setGroupBy(clause: SqlClause, columns: string[]): SqlClause {
      if (columns.length === 0) {
        const { "group-by": _, ...rest } = clause;
        return rest;
      }
      return { ...clause, "group-by": columns };
    },

    setLimit(clause: SqlClause, limit: number): SqlClause {
      return { ...clause, limit: { $: limit } };
    },

    setOffset(clause: SqlClause, offset: number): SqlClause {
      return { ...clause, offset: { $: offset } };
    },

    clear(clause: SqlClause, key: "where" | "order-by" | "group-by" | "limit" | "offset"): SqlClause {
      const { [key]: _, ...rest } = clause;
      return rest;
    },

    // === Query Analysis ===

    getTablesInQuery(clause: SqlClause) {
      return getTablesInClause(clause);
    },

    validate(clause: SqlClause): ValidationResult {
      const errors: ValidationResult["errors"] = [];
      const warnings: ValidationResult["warnings"] = [];

      const tablesInQuery = getTablesInClause(clause);
      const tableAliases = new Set(tablesInQuery.map(t => t.alias));
      const allColumns = getAvailableColumns(clause);
      const columnSet = new Set(allColumns.map(c => c.qualified));

      // Check SELECT columns exist
      if (clause.select) {
        const selectItems = Array.isArray(clause.select) ? clause.select : [clause.select];
        selectItems.forEach((item, i) => {
          if (typeof item === "string" && item !== "*" && !item.endsWith(".*")) {
            if (item.includes(".")) {
              if (!columnSet.has(item)) {
                const [tableAlias] = item.split(".");
                if (!tableAliases.has(tableAlias!)) {
                  errors.push({
                    path: `select[${i}]`,
                    message: `Unknown table alias: ${tableAlias}`,
                    code: "unknown_table",
                  });
                } else {
                  errors.push({
                    path: `select[${i}]`,
                    message: `Unknown column: ${item}`,
                    code: "unknown_column",
                  });
                }
              }
            }
          }
        });
      }

      // Check FROM exists for SELECT
      if (clause.select && !clause.from) {
        warnings.push({
          path: "from",
          message: "SELECT without FROM clause",
          code: "missing_from",
        });
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    },
  };
}
