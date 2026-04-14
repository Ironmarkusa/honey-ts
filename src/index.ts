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
  literal,
} from "./sql.js";

// SQL parsing
export { fromSql, fromSqlMulti, normalizeSql } from "./parser.js";

// Query manipulation
export {
  walkClauses,
  injectWhere,
  overrideSelects,
  getTableAliases,
  getSelectAliases,
  analyzeSelects,
  getReferencedColumns,
} from "./helpers.js";

export type { AliasScope, SelectItemAnalysis, SelectAnalysisScope } from "./helpers.js";

// Schema-aware query builder
export { createQueryBuilder } from "./builder.js";

export type {
  ColumnSchema,
  TableSchema,
  DatabaseSchema,
  QueryBuilder,
  OperatorInfo,
  FunctionInfo,
  ValidationResult,
} from "./builder.js";

// SQL guard (LLM validation)
export {
  guardSql,
  getOperation,
  collectTables,
  isTautology,
} from "./guard.js";

export type { GuardConfig, GuardResult, SqlOperation } from "./guard.js";

// Types
export type {
  SqlExpr,
  SqlClause,
  SqlIdent,
  SqlParam,
  SqlRaw,
  SqlLift,
  SqlLiteral,
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
  isLiteral,
  isClause,
  isExprArray,
} from "./types.js";

// Zod schemas for runtime validation
export {
  SqlIdentSchema,
  SqlParamSchema,
  SqlRawSchema,
  SqlLiftSchema,
  SqlLiteralSchema,
  SqlExprSchema,
  SqlClauseSchema,
  FormatOptionsSchema,
} from "./types.js";

// PostgreSQL operators (auto-registered)
import "./pg-ops.js";

// Re-export PG helper functions
export {
  jsonbContains,
  jsonbPath,
  arrayOverlaps,
  regexMatch,
  textSearch,
} from "./pg-ops.js";

// ============================================================================
// Rewrites layer — find/rewrite/modify/apply helpers for clause trees.
// Power the "parse → a couple of helpers → unparse" philosophy for dynamic SQL.
// ============================================================================

export * as matchers from "./rewrites/matchers.js";
export * as find from "./rewrites/find.js";
export * as rewrite from "./rewrites/rewrite.js";
export * as modify from "./rewrites/modify.js";

export { apply, applyWith } from "./rewrites/apply.js";
export type { ClauseTransform, ApplyOptions } from "./rewrites/apply.js";

export {
  rewriteDateRange,
  describeDatePredicates,
} from "./rewrites/date-range.js";
export type {
  DatePredicate,
  RangeStrategy,
  RewriteDateRangeSpec,
} from "./rewrites/date-range.js";

export type { Matcher, MatchContext } from "./rewrites/matchers.js";
export type {
  Hit,
  TableHit,
  JoinHit,
  SelectHit,
} from "./rewrites/find.js";
export type { Replacement } from "./rewrites/rewrite.js";
export type {
  AddWhereOptions,
  AddOrderByOptions,
} from "./rewrites/modify.js";
