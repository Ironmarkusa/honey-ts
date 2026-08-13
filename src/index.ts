/**
 * honey-ts — SQL as data structures for TypeScript.
 *
 * The API is organized in layers:
 *
 *   1. **Core**: `fromSql` parses SQL into a plain-data clause map;
 *      `toSql`/`format` turns a clause map back into parameterized SQL.
 *      Both take a dialect (`postgres` default, `duckdb` fully supported).
 *   2. **Value constructors**: `$()`, `literal()`, `raw()`, `param()`,
 *      `lift()`, `ident()` — build the special value shapes without
 *      hand-writing wrapper objects.
 *   3. **Manipulation** (the `find` / `modify` / `rewrite` / `matchers`
 *      namespaces + `apply`): matcher-based, immutable, subquery-aware
 *      transforms. This is THE way to manipulate clause trees.
 *   4. **Analysis** (the `analyze` namespace): read-only introspection —
 *      aliases, select provenance, referenced columns.
 *   5. **Guard**: allow-list validation for LLM-generated SQL.
 *   6. **Builder**: schema-aware suggestions for query-building UIs.
 *   7. **Dialects**: `duckdb.*` typed constructs, `registerDialect`.
 *
 * @example
 * ```ts
 * import { fromSql, toSql, modify, matchers, $ } from 'honey-ts';
 *
 * const clause = fromSql("SELECT u.email FROM users u WHERE status = 'active'");
 *
 * // Inject tenant isolation into every subquery (joins included)
 * const secured = modify.addWhere(clause, ["=", "tenant_id", $(tenantId)]);
 *
 * const [sql, ...params] = toSql(secured);
 * ```
 *
 * Port of: https://github.com/seancorfield/honeysql
 * Original Copyright (c) 2020-2025 Sean Corfield
 */

// ============================================================================
// 1. Core — parse and format
// ============================================================================

export { format, format as toSql } from "./sql.js";
export { fromSql, fromSqlMulti, normalizeSql } from "./parser.js";
export type { FromSqlOptions } from "./parser.js";

// ============================================================================
// 2. Value constructors
// ============================================================================

export { $, raw, param, lift, literal, ident, sql, mapEquals } from "./sql.js";

// ============================================================================
// 3. Manipulation — matcher-based, immutable, subquery-aware
// ============================================================================

export * as find from "./rewrites/find.js";
export * as modify from "./rewrites/modify.js";
export * as rewrite from "./rewrites/rewrite.js";
export * as matchers from "./rewrites/matchers.js";

export { apply, applyWith } from "./rewrites/apply.js";
export type { ClauseTransform, ApplyOptions } from "./rewrites/apply.js";

// Walk primitives, for transforms the namespaces don't cover.
export { walkClauseTree, mapClauseTree, mapExprTree } from "./rewrites/walk.js";
export type { ClauseVisitor } from "./rewrites/walk.js";

export { rewriteDateRange, describeDatePredicates } from "./rewrites/date-range.js";
export type {
  DatePredicate,
  RangeStrategy,
  RewriteDateRangeSpec,
} from "./rewrites/date-range.js";

export type { Matcher, MatchContext } from "./rewrites/matchers.js";
export type { Hit, TableHit, JoinHit, SelectHit } from "./rewrites/find.js";
export type { Replacement } from "./rewrites/rewrite.js";
export type { AddWhereOptions, AddOrderByOptions } from "./rewrites/modify.js";

// ============================================================================
// 4. Analysis — read-only introspection
// ============================================================================

export * as analyze from "./analyze.js";
export type {
  AliasScope,
  SelectItemAnalysis,
  SelectAnalysisScope,
} from "./analyze.js";

// ============================================================================
// 4b. Query-builder foundation — schema loading, type inference, deep
//     validation, and stable node addressing for UIs
// ============================================================================

export { schemaFromPostgres, schemaFromDuckDb } from "./schema-loaders.js";
export type { SchemaExecutor, SchemaLoadOptions } from "./schema-loaders.js";

export { createInferrer, normalizeType, baseType, typesComparable } from "./infer.js";
export type { Inferrer, InferredType, InferrerOptions } from "./infer.js";

export { validateQuery } from "./validate.js";
export type { Problem, ProblemSeverity, ValidationOutcome, ValidateOptions } from "./validate.js";

export * as paths from "./paths.js";
export type { Path, PathStep, PathHit } from "./paths.js";

// ============================================================================
// 5. Guard — allow-list validation for LLM-generated SQL
// ============================================================================

export { guardSql, getOperation, collectTables, isTautology } from "./guard.js";
export type { GuardConfig, GuardResult, SqlOperation } from "./guard.js";

// ============================================================================
// 6. Builder — schema-aware suggestions for UIs
// ============================================================================

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

// ============================================================================
// 7. Dialects
// ============================================================================

export { registerDialect, getDialect } from "./sql.js";

// DuckDB construct types, guards and typed constructors. Namespaced because
// the constructor names (list, struct, star, ...) are too generic to export
// bare: `duckdb.list(1, 2)` reads better than a colliding top-level `list`.
export * as duckdb from "./duckdb-types.js";
export type {
  DuckDBClause,
  DuckDBExpr,
  DuckDBStarSpec,
  DuckDBListExpr,
  DuckDBStructExpr,
  DuckDBLambdaExpr,
  DuckDBStarExpr,
  DuckDBSliceExpr,
  DuckDBNamedArgExpr,
  DuckDBTryCastExpr,
  DuckDBAggOrderByExpr,
  DuckDBMapExpr,
  DuckDBFieldExpr,
  DuckDBExportStateExpr,
  DuckDBIntDivExpr,
  DuckDBCollateExpr,
  DuckDBNullsModifierExpr,
  DuckDBGroupingSetsExpr,
  DuckDBWindowFrame,
  DuckDBSampleSpec,
  DuckDBPivotSpec,
} from "./duckdb-types.js";

// PostgreSQL operators (auto-registered) and expression helpers.
import "./pg-ops.js";
export {
  jsonbContains,
  jsonbPath,
  arrayOverlaps,
  regexMatch,
  textSearch,
} from "./pg-ops.js";

// ============================================================================
// Types and runtime validation
// ============================================================================

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

export {
  isIdent,
  isParam,
  isRaw,
  isLift,
  isLiteral,
  isClause,
  isExprArray,
} from "./types.js";

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

// ============================================================================
// Extension API — for registering custom clauses, functions, and operators.
// These expose formatter internals; most applications never need them.
// ============================================================================

export {
  registerClause,
  registerFn,
  registerOp,
  clauseOrder,
  formatExpr,
  formatDsl,
  formatExprList,
  formatEntity,
  sqlKw,
} from "./sql.js";
