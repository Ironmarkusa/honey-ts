/**
 * HoneySQL TypeScript Port - Type Definitions
 *
 * Following HoneySQL's data-as-SQL philosophy:
 * - Maps represent SQL statements
 * - Arrays represent expressions (first element is operator/function)
 * - Strings starting with ":" are treated as identifiers (we use symbols/strings)
 */

import { z } from "zod";

// ============================================================================
// Core Value Types
// ============================================================================

/** SQL identifier - column names, table names, etc. */
export type SqlIdent = string | symbol;

/** Inline SQL keyword (like HoneySQL's :foo -> FOO) */
export type SqlKeyword = string;

/** Parameter placeholder */
export type SqlParam = { __param: string };

/** Raw SQL fragment */
export type SqlRaw = { __raw: string | (string | SqlExpr)[] };

/** Lifted value (prevent DSL interpretation) */
export type SqlLift = { __lift: unknown };

/**
 * Typed value - becomes a parameterized value with optional cast
 * {$: "active"} → $1
 * {text: "hello"} → $1::text
 * {jsonb: {foo: "bar"}} → $1::jsonb
 */
export type SqlTypedValue = { [type: string]: unknown };

/**
 * SQL Expression - recursive type for SQL expressions
 * Can be: identifier, literal value, or [operator, ...args]
 */
export type SqlExpr =
  | SqlIdent
  | number
  | string
  | boolean
  | null
  | undefined
  | SqlParam
  | SqlRaw
  | SqlLift
  | Date
  | SqlExpr[]
  | SqlClause;

/** Format result: [sqlString, ...params] */
export type FormatResult = [string, ...unknown[]];

// ============================================================================
// Clause Types (matching HoneySQL's clause structure)
// ============================================================================

/** SELECT clause value */
export type SelectClause = SqlExpr | SqlExpr[];

/** FROM clause value */
export type FromClause = SqlExpr | SqlExpr[];

/** JOIN clause value: [[table, condition], ...] */
export type JoinClause = [SqlExpr, SqlExpr][];

/** WHERE clause value */
export type WhereClause = SqlExpr;

/** ORDER BY clause value: [expr] or [[expr, 'asc'|'desc'], ...] */
export type OrderByClause = SqlExpr | [SqlExpr, "asc" | "desc"][];

/** GROUP BY clause value */
export type GroupByClause = SqlExpr | SqlExpr[];

/** VALUES clause value */
export type ValuesClause = Record<string, SqlExpr>[] | SqlExpr[][];

/** SET clause value (for UPDATE) */
export type SetClause = Record<string, SqlExpr>;

/** WITH clause value */
export type WithClause = [SqlExpr, SqlClause][];

/** ON CONFLICT clause value */
export type OnConflictClause = SqlExpr | SqlExpr[];

/** RETURNING clause value */
export type ReturningClause = SqlExpr | SqlExpr[];

// ============================================================================
// SQL Statement (DSL Map)
// ============================================================================

/**
 * SQL Clause Map - the core DSL structure
 * Mirrors HoneySQL's hash map structure
 */
export interface SqlClause {
  // DDL
  "alter-table"?: SqlExpr;
  "add-column"?: SqlExpr[];
  "drop-column"?: SqlExpr | SqlExpr[];
  "alter-column"?: SqlExpr[];
  "modify-column"?: SqlExpr[];
  "rename-column"?: [SqlExpr, SqlExpr];
  "add-index"?: SqlExpr;
  "drop-index"?: SqlExpr;
  "rename-table"?: SqlExpr;
  "create-table"?: SqlExpr;
  "create-table-as"?: SqlExpr;
  "with-columns"?: SqlExpr[];
  "create-view"?: SqlExpr;
  "create-materialized-view"?: SqlExpr;
  "drop-table"?: SqlExpr | SqlExpr[];
  "drop-view"?: SqlExpr | SqlExpr[];
  "drop-materialized-view"?: SqlExpr | SqlExpr[];
  "refresh-materialized-view"?: SqlExpr;
  "create-index"?: [SqlExpr, SqlExpr[]];
  "create-extension"?: SqlExpr;
  "drop-extension"?: SqlExpr;

  // DML
  raw?: string | SqlExpr[];
  nest?: SqlClause;
  with?: WithClause;
  "with-recursive"?: WithClause;
  intersect?: SqlClause[];
  union?: SqlClause[];
  "union-all"?: SqlClause[];
  except?: SqlClause[];
  "except-all"?: SqlClause[];
  select?: SelectClause;
  "select-distinct"?: SelectClause;
  "select-distinct-on"?: [SqlExpr[], ...SqlExpr[]];
  distinct?: SqlExpr;
  expr?: SqlExpr;
  into?: SqlExpr;
  "bulk-collect-into"?: [SqlExpr, SqlExpr?];
  "insert-into"?: SqlExpr;
  "replace-into"?: SqlExpr;
  update?: SqlExpr;
  delete?: SqlExpr;
  "delete-from"?: SqlExpr;
  truncate?: SqlExpr | SqlExpr[];
  columns?: SqlExpr[];
  set?: SetClause;
  from?: FromClause;
  using?: SqlExpr[];
  "join-by"?: SqlExpr[];
  join?: JoinClause;
  "left-join"?: JoinClause;
  "right-join"?: JoinClause;
  "inner-join"?: JoinClause;
  "outer-join"?: JoinClause;
  "full-join"?: JoinClause;
  "cross-join"?: SqlExpr[];
  where?: WhereClause;
  "group-by"?: GroupByClause;
  having?: SqlExpr;
  window?: SqlExpr[];
  "partition-by"?: SqlExpr[];
  "order-by"?: OrderByClause;
  limit?: SqlExpr;
  offset?: SqlExpr;
  fetch?: SqlExpr;
  for?: SqlExpr | SqlExpr[];
  lock?: SqlExpr | SqlExpr[];
  values?: ValuesClause;
  "on-conflict"?: OnConflictClause;
  "on-constraint"?: SqlExpr;
  "do-nothing"?: boolean;
  "do-update-set"?: SetClause | SqlExpr[] | { fields: SqlExpr[] | SetClause; where?: SqlExpr };
  "on-duplicate-key-update"?: SetClause;
  returning?: ReturningClause;
  "with-data"?: boolean;

  // Allow arbitrary keys for extensibility
  [key: string]: unknown;
}

// ============================================================================
// Format Options
// ============================================================================

export interface FormatOptions {
  /** SQL dialect */
  dialect?: "ansi" | "postgres" | "mysql" | "sqlite" | "sqlserver" | "oracle";
  /** Quote all identifiers */
  quoted?: boolean;
  /** Convert dashes to underscores even when quoted */
  quotedSnake?: boolean;
  /** Always quote identifiers matching this regex */
  quotedAlways?: RegExp;
  /** Inline all values (no parameters) */
  inline?: boolean;
  /** Use numbered parameters ($1, $2) instead of ? */
  numbered?: boolean;
  /** Named parameters map */
  params?: Record<string, unknown>;
  /** Checking mode: 'none' | 'basic' | 'strict' */
  checking?: "none" | "basic" | "strict";
  /** Transform [:= x nil] to "x IS NULL" */
  transformNullEquals?: boolean;
  /** Pretty print with newlines */
  pretty?: boolean;
}

// ============================================================================
// Dialect Configuration
// ============================================================================

export interface DialectConfig {
  /** Function to quote an identifier */
  quote: (s: string) => string;
  /** Custom clause ordering function */
  clauseOrderFn?: (order: string[]) => string[];
  /** Whether to use AS for aliases */
  as?: boolean;
  /** Auto-lift boolean values to parameters */
  autoLiftBoolean?: boolean;
}

// ============================================================================
// Zod Schemas for Runtime Validation (optional)
// ============================================================================

export const SqlIdentSchema = z.union([z.string(), z.symbol()]);

export const SqlParamSchema = z.object({ __param: z.string() });

export const SqlRawSchema = z.object({
  __raw: z.union([z.string(), z.array(z.any())]),
});

export const SqlLiftSchema = z.object({ __lift: z.unknown() });

// Recursive schema for expressions
export const SqlExprSchema: z.ZodType<SqlExpr> = z.lazy(() =>
  z.union([
    SqlIdentSchema,
    z.number(),
    z.string(),
    z.boolean(),
    z.null(),
    z.undefined(),
    SqlParamSchema,
    SqlRawSchema,
    SqlLiftSchema,
    z.date(),
    z.array(SqlExprSchema),
    SqlClauseSchema,
  ])
);

export const SqlClauseSchema: z.ZodType<SqlClause> = z.record(z.string(), z.unknown());

export const FormatOptionsSchema = z.object({
  dialect: z.enum(["ansi", "postgres", "mysql", "sqlite", "sqlserver", "oracle"]).optional(),
  quoted: z.boolean().optional(),
  quotedSnake: z.boolean().optional(),
  quotedAlways: z.instanceof(RegExp).optional(),
  inline: z.boolean().optional(),
  numbered: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  checking: z.enum(["none", "basic", "strict"]).optional(),
  transformNullEquals: z.boolean().optional(),
  pretty: z.boolean().optional(),
});

// ============================================================================
// Helper Type Guards
// ============================================================================

/**
 * Check if a value is a SQL identifier (column/table name).
 *
 * ALL plain strings are identifiers.
 * Values must be wrapped: {$: "value"} or {type: value}
 *
 * Valid identifiers:
 * - Simple names: "users", "id", "created_at"
 * - Qualified names: "users.id", "schema.table"
 * - Select all: "*"
 * - Function shorthand: "%count", "%sum"
 */
export function isIdent(x: unknown): x is SqlIdent {
  if (typeof x === "symbol") return true;
  if (typeof x !== "string") return false;
  if (x === "") return false;
  if (x === "*") return true;
  if (x.startsWith("%")) return true;

  // Valid SQL identifier pattern: letters, digits, underscores, dots, slashes
  const validIdentPattern = /^[a-zA-Z_][a-zA-Z0-9_]*(?:[./][a-zA-Z_][a-zA-Z0-9_]*)*$/;
  return validIdentPattern.test(x);
}

export function isParam(x: unknown): x is SqlParam {
  return typeof x === "object" && x !== null && "__param" in x;
}

export function isRaw(x: unknown): x is SqlRaw {
  return typeof x === "object" && x !== null && "__raw" in x;
}

export function isLift(x: unknown): x is SqlLift {
  return typeof x === "object" && x !== null && "__lift" in x;
}

// SQL clause keys - these are NOT typed values
const clauseKeys = new Set([
  "select", "select-distinct", "select-distinct-on",
  "from", "join", "left-join", "right-join", "inner-join", "outer-join", "full-join", "cross-join",
  "where", "group-by", "having", "order-by", "limit", "offset",
  "insert-into", "replace-into", "values", "columns", "set", "update", "delete", "delete-from",
  "on-conflict", "on-constraint", "do-nothing", "do-update-set",
  "returning", "with", "with-recursive",
  "union", "union-all", "intersect", "except", "except-all",
  "create-table", "drop-table", "alter-table", "truncate",
  "raw", "nest", "for", "lock", "window", "partition-by",
]);

/**
 * Check if value is a typed value like {$: "active"} or {jsonb: {...}}
 * Must be an object with exactly one key that's not a special key or clause key
 */
export function isTypedValue(x: unknown): x is SqlTypedValue {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const keys = Object.keys(x);
  if (keys.length !== 1) return false;
  const key = keys[0]!;
  // Not a special internal type or a SQL clause key
  return !key.startsWith("__") && !clauseKeys.has(key);
}

export function isClause(x: unknown): x is SqlClause {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    !isParam(x) &&
    !isRaw(x) &&
    !isLift(x) &&
    !isTypedValue(x)
  );
}

export function isExprArray(x: unknown): x is SqlExpr[] {
  return Array.isArray(x);
}
