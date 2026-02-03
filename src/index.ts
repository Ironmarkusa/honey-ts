/**
 * HoneySQL TypeScript Port
 *
 * A TypeScript implementation of HoneySQL - representing SQL as data structures.
 *
 * @example
 * ```ts
 * import { toSql, fromSql, injectWhere, overrideSelects, raw } from 'honey-ts';
 *
 * // LLM generates SQL
 * const clause = fromSql("SELECT u.email FROM users u WHERE status = 'active'");
 *
 * // Override computed columns using schema table names
 * const fixed = overrideSelects(clause, {
 *   "users.email": raw("SHA256(LOWER(TRIM(u.email)))")
 * });
 *
 * // Inject tenant isolation into all subqueries
 * const secured = injectWhere(fixed, ["=", "tenant_id", { $: tenantId }]);
 *
 * // Back to parameterized SQL
 * const [sql, ...params] = toSql(secured);
 * ```
 *
 * Port of: https://github.com/seancorfield/honeysql
 * Original Copyright (c) 2020-2025 Sean Corfield
 */

// Core SQL formatting
export {
  format,
  format as toSql,
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
} from "./sql.js";

// SQL parsing
export { fromSql, fromSqlMulti, normalizeSql } from "./parser.js";

// Query manipulation
export {
  walkClauses,
  injectWhere,
  overrideSelects,
  getTableAliases,
} from "./helpers.js";

export type { AliasScope } from "./helpers.js";

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
