/**
 * HoneySQL TypeScript Port
 *
 * A TypeScript implementation of HoneySQL - representing SQL as data structures.
 *
 * @example
 * ```ts
 * import { format, select, from, where, merge } from 'honey-ts';
 *
 * // Data-first approach
 * const query = {
 *   select: ["id", "name"],
 *   from: "users",
 *   where: ["=", "active", true]
 * };
 * const [sql, ...params] = format(query);
 * // => ["SELECT id, name FROM users WHERE active = $1", true]
 *
 * // Builder approach
 * const query2 = merge(
 *   select("id", "name"),
 *   from("users"),
 *   where(["=", "active", true])
 * );
 * const [sql2, ...params2] = format(query2);
 * ```
 *
 * Port of: https://github.com/seancorfield/honeysql
 * Original Copyright (c) 2020-2025 Sean Corfield
 */

// Core SQL formatting
export {
  format,
  format as toSql,  // Alias for symmetry with fromSql
  formatExpr,
  formatDsl,
  formatExprList,
  formatEntity,
  sqlKw,
  registerClause,
  registerFn,
  registerOp,
  clauseOrder,
  raw,
  param,
  lift,
  mapEquals,
} from "./sql.js";

// SQL parsing
export { fromSql, fromSqlMulti, normalizeSql } from "./parser.js";

// Helper functions (builder pattern)
export {
  // SELECT
  select,
  selectDistinct,
  selectDistinctOn,
  // FROM
  from,
  // WHERE / HAVING
  where,
  having,
  // JOIN
  join,
  leftJoin,
  rightJoin,
  innerJoin,
  outerJoin,
  fullJoin,
  crossJoin,
  // GROUP BY / ORDER BY
  groupBy,
  orderBy,
  // LIMIT / OFFSET
  limit,
  offset,
  // INSERT
  insertInto,
  replaceInto,
  values,
  columns,
  // UPDATE
  update,
  set,
  // DELETE
  delete_ as del,
  delete_,
  deleteFrom,
  truncate,
  // WITH (CTE)
  with_ as withCte,
  with_,
  withRecursive,
  // Set operations
  union,
  unionAll,
  intersect,
  except,
  // UPSERT
  onConflict,
  onConstraint,
  doNothing,
  doUpdateSet,
  // RETURNING
  returning,
  // Locking
  for_ as forLock,
  for_,
  lock,
  // Window
  window,
  partitionBy,
  // DDL
  createTable,
  withColumns,
  dropTable,
  alterTable,
  addColumn,
  dropColumn,
  // Utility
  merge,
  // Tree walking
  walkClauses,
  injectWhere,
} from "./helpers.js";

// Types
export type {
  SqlExpr,
  SqlClause,
  SqlIdent,
  SqlParam,
  SqlRaw,
  SqlLift,
  FormatResult,
  FormatOptions,
  DialectConfig,
  SelectClause,
  FromClause,
  JoinClause,
  WhereClause,
  OrderByClause,
  GroupByClause,
  ValuesClause,
  SetClause,
  WithClause,
  OnConflictClause,
  ReturningClause,
} from "./types.js";

// Type guards
export {
  isIdent,
  isParam,
  isRaw,
  isLift,
  isClause,
  isExprArray,
} from "./types.js";

// Zod schemas for runtime validation
export {
  SqlIdentSchema,
  SqlParamSchema,
  SqlRawSchema,
  SqlLiftSchema,
  SqlExprSchema,
  SqlClauseSchema,
  FormatOptionsSchema,
} from "./types.js";

// PostgreSQL operators (import separately to register)
// import 'honey-ts/pg-ops' to register PG-specific operators
