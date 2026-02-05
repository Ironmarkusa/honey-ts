/**
 * HoneySQL TypeScript Port - Core SQL Formatting
 *
 * Primary API: format() function that converts data structures to SQL
 *
 * Port of: https://github.com/seancorfield/honeysql
 * Copyright (c) 2020-2025 Sean Corfield (original Clojure implementation)
 */

import type {
  SqlExpr,
  SqlClause,
  SqlIdent,
  FormatResult,
  FormatOptions,
  DialectConfig,
} from "./types.js";
import { isIdent, isParam, isRaw, isLift, isClause, isExprArray, isTypedValue } from "./types.js";
import { format as sqlFormat } from "sql-formatter";

// ============================================================================
// String Utilities (ported from honey.sql.util)
// ============================================================================

function strop(start: string, x: string, end: string): string {
  return start + x.replace(new RegExp(end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), end + end) + end;
}

function dehyphen(s: string): string {
  if (s.includes("-")) {
    return s.replace(/(\w)-(?=\w)/g, "$1 ");
  }
  return s;
}

function splitBySeparator(s: string, sep: string): string[] {
  const result: string[] = [];
  let start = 0;
  let idx = s.indexOf(sep, start);
  while (idx !== -1) {
    result.push(s.substring(start, idx));
    start = idx + 1;
    idx = s.indexOf(sep, start);
  }
  result.push(s.substring(start));
  return result;
}

// ============================================================================
// Dialect Configuration
// ============================================================================

const dialects = new Map<string, DialectConfig & { dialect: string }>([
  ["ansi", { dialect: "ansi", quote: (s) => strop('"', s, '"') }],
  ["postgres", { dialect: "postgres", quote: (s) => strop('"', s, '"') }],
  ["mysql", {
    dialect: "mysql",
    quote: (s) => strop("`", s, "`"),
    clauseOrderFn: (order) => addClauseBefore(order, "set", "where"),
  }],
  ["sqlite", { dialect: "sqlite", quote: (s) => strop('"', s, '"') }],
  ["sqlserver", { dialect: "sqlserver", quote: (s) => strop("[", s, "]"), autoLiftBoolean: true }],
  ["oracle", { dialect: "oracle", quote: (s) => strop('"', s, '"'), as: false }],
]);

// ============================================================================
// Default Clause Order (matching HoneySQL)
// ============================================================================

const defaultClauseOrder: string[] = [
  // DDL first
  "alter-table", "add-column", "drop-column",
  "alter-column", "modify-column", "rename-column",
  "add-index", "drop-index", "rename-table",
  "create-table", "create-table-as", "with-columns",
  "create-view", "create-or-replace-view", "create-materialized-view",
  "create-extension",
  "drop-table", "drop-view", "drop-materialized-view", "drop-extension",
  "refresh-materialized-view",
  "create-index",
  // SQL clauses in priority order
  "raw", "nest", "with", "with-recursive", "intersect", "union", "union-all", "except", "except-all",
  // DML statements must come before SELECT for INSERT...SELECT, UPDATE...FROM, etc.
  "insert-into", "replace-into", "update", "delete", "delete-from", "truncate",
  "select", "select-distinct", "select-distinct-on", "select-top", "select-distinct-top",
  "distinct", "expr", "exclude", "rename",
  "into", "bulk-collect-into",
  "columns", "set", "from", "using",
  "join-by",
  "join", "left-join", "right-join", "inner-join", "outer-join", "full-join",
  "cross-join",
  "where", "group-by", "having",
  "window", "partition-by",
  "order-by", "limit", "offset", "fetch", "for", "lock", "values",
  "on-conflict", "on-constraint", "do-nothing", "do-update-set", "on-duplicate-key-update",
  "returning",
  "with-data",
];

let currentClauseOrder = [...defaultClauseOrder];

function addClauseBefore(order: string[], clause: string, before: string | null): string[] {
  const clauses = new Set(order);
  let newOrder = order.filter((k) => k !== clause);

  if (before) {
    if (!clauses.has(before)) {
      throw new Error(`Unrecognized clause: ${before}`);
    }
    const idx = newOrder.indexOf(before);
    newOrder = [...newOrder.slice(0, idx), clause, ...newOrder.slice(idx)];
  } else {
    newOrder.push(clause);
  }
  return newOrder;
}

// ============================================================================
// Formatting Context (replaces Clojure's dynamic vars)
// ============================================================================

interface FormatContext {
  dialect: DialectConfig & { dialect: string };
  options: {
    quoted: boolean;
    quotedSnake: boolean;
    quotedAlways: RegExp | undefined;
    inline: boolean;
    params: Record<string, unknown>;
    checking: "none" | "basic" | "strict";
    transformNullEquals: boolean;
    pretty: boolean;
    clauseOrder: string[];
    dsl: SqlClause | null;
    numbered: unknown[] | null;
  };
}

function createContext(opts: FormatOptions): FormatContext {
  const dialectName = opts.dialect ?? "postgres";
  const dialect = dialects.get(dialectName) ?? dialects.get("ansi")!;

  const clauseOrder = dialect.clauseOrderFn
    ? dialect.clauseOrderFn([...defaultClauseOrder])
    : [...currentClauseOrder];

  const useNumbered = opts.numbered ?? (dialectName === "postgres");

  return {
    dialect,
    options: {
      quoted: opts.quoted ?? (opts.dialect !== undefined),
      quotedSnake: opts.quotedSnake ?? false,
      quotedAlways: opts.quotedAlways,
      inline: opts.inline ?? false,
      params: opts.params ?? {},
      checking: opts.checking ?? "none",
      transformNullEquals: opts.transformNullEquals ?? true,
      pretty: opts.pretty ?? false,
      clauseOrder,
      dsl: null,
      numbered: useNumbered ? [] : null,
    },
  };
}

// ============================================================================
// SQL Keyword Conversion
// ============================================================================

/**
 * Convert identifier to SQL (uppercase, dashes to spaces)
 * :insert-into -> INSERT INTO
 */
export function sqlKw(k: string | symbol | null | undefined): string {
  if (k == null) return "";
  let n = typeof k === "symbol" ? k.description ?? "" : k;

  // Handle quoted identifiers (start with ')
  if (n.startsWith("'")) {
    return n.substring(1);
  }

  // Strip leading % (function call indicator)
  if (n.startsWith("%")) {
    n = n.substring(1);
  }

  return dehyphen(n).toUpperCase();
}

/**
 * Convert to underscore-separated name
 */
function nameUnderscore(x: string): string {
  return x.replace(/-/g, "_");
}

// ============================================================================
// Infix Operators Registry
// ============================================================================

const infixOps = new Set<string>([
  "and", "or", "xor", "<>", "<=", ">=", "||", "<->",
  "like", "not-like", "regexp", "~", "&&",
  "ilike", "not-ilike", "similar-to", "not-similar-to",
  "is", "is-not", "not=", "!=", "regex",
  "is-distinct-from", "is-not-distinct-from",
  "with-ordinality",
  "+", "-", "*", "%", "|", "&", "^", "=", "<", ">", "/",
]);

const infixAliases = new Map<string, string>([
  ["not=", "<>"],
  ["!=", "<>"],
  ["regex", "regexp"],
]);

const opIgnoreNil = new Set<string>(["and", "or"]);
const opCanBeUnary = new Set<string>(["+", "-", "~"]);

// ============================================================================
// Entity Formatting
// ============================================================================

const alphanumeric = /^(?:[0-9_]+|[A-Za-z_][A-Za-z0-9_]*)$/;

export function formatEntity(
  e: SqlIdent | string,
  ctx: FormatContext,
  opts: { aliased?: boolean; dropNs?: boolean } = {}
): string {
  const { dialect, options } = ctx;
  const { quoted, quotedSnake, quotedAlways } = options;

  const name = typeof e === "symbol" ? (e.description ?? "") : e;

  // Handle quoted alias (starts with ')
  if (opts.aliased && name.startsWith("'")) {
    return name.substring(1);
  }

  // Column name transformation
  const colName = quoted || typeof e === "string" ? (quotedSnake ? nameUnderscore(name) : name) : nameUnderscore(name);

  // Quote function
  const quoteFn = (part: string): string => {
    if (quoted || typeof e === "string") {
      return dialect.quote(part);
    }
    if (quotedAlways?.test(part)) {
      return dialect.quote(part);
    }
    if (alphanumeric.test(part)) {
      return part;
    }
    return dialect.quote(part);
  };

  // Split by namespace (/) or dot (.)
  let parts: string[];
  if (!opts.dropNs && name.includes("/")) {
    const [ns, n] = name.split("/", 2);
    parts = [nameUnderscore(ns!), n!];
  } else if (!opts.aliased) {
    parts = splitBySeparator(colName, ".");
  } else {
    parts = [colName];
  }

  // Quote non-* parts and join with .
  const entity = parts.map((p) => (p === "*" ? p : quoteFn(p))).join(".");

  // Check for suspicious characters
  if (entity.includes(";")) {
    throw new Error(`Suspicious character found in entity: ${entity}`);
  }

  return entity;
}

// ============================================================================
// Inline Value Conversion
// ============================================================================

function sqlizeValue(x: unknown): string {
  if (x === null || x === undefined) return "NULL";
  if (typeof x === "string") return "'" + x.replace(/'/g, "''") + "'";
  if (typeof x === "boolean") return x ? "TRUE" : "FALSE";
  if (typeof x === "number") return String(x);
  if (x instanceof Date) return "'" + x.toISOString() + "'";
  if (Array.isArray(x)) return "[" + x.map(sqlizeValue).join(", ") + "]";
  if (typeof x === "object") {
    return (
      "{" +
      Object.entries(x as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${sqlizeValue(v)}`)
        .join(", ") +
      "}"
    );
  }
  return String(x);
}

// ============================================================================
// Format Expression
// ============================================================================

type ClauseFormatter = (k: string, x: unknown, ctx: FormatContext) => FormatResult;

export function formatExpr(expr: SqlExpr, ctx: FormatContext, opts: { nested?: boolean } = {}): FormatResult {
  const { options, dialect } = ctx;

  // Identifier (string that doesn't look like a value)
  if (isIdent(expr)) {
    return formatVar(expr, ctx);
  }

  // Clause map -> format as nested DSL
  if (isClause(expr)) {
    return formatDsl(expr, ctx, { nested: true });
  }

  // Expression array
  if (isExprArray(expr)) {
    if (expr.length === 0) {
      return [""];
    }

    const op = normalizeOp(expr[0]);

    if (typeof op === "string") {
      // Infix operator
      if (infixOps.has(op)) {
        if (op === "=" || op === "<>") {
          return formatEqualityExpr(op, expr, ctx, opts.nested ?? false);
        }
        return formatInfixExpr(op, expr, ctx, opts.nested ?? false);
      }

      // Special operators
      if (op === "in" || op === "not-in") {
        return formatIn(op, expr.slice(1) as [SqlExpr, SqlExpr], ctx, opts.nested ?? false);
      }

      // Special syntax
      const specialFn = specialSyntax.get(op);
      if (specialFn) {
        return specialFn(op, expr.slice(1), ctx);
      }

      // Function call
      return formatFnCall(op, expr, ctx);
    }

    // Tuple of expressions
    const [sqls, params] = formatExprList(expr, ctx);
    return [`(${sqls.join(", ")})`, ...params];
  }

  // Boolean — always inline as SQL keyword, like NULL
  if (typeof expr === "boolean") {
    return [expr ? "TRUE" : "FALSE"];
  }

  // Null
  if (expr === null || expr === undefined) {
    return ["NULL"];
  }

  // Raw SQL
  if (isRaw(expr)) {
    return rawRender(expr.__raw, ctx);
  }

  // Parameter reference
  if (isParam(expr)) {
    return formatParamRef(expr.__param, ctx);
  }

  // Lifted value
  if (isLift(expr)) {
    if (options.inline) {
      return [sqlizeValue(expr.__lift)];
    }
    if (options.numbered) {
      return addNumberedParam(expr.__lift, ctx);
    }
    return ["?", expr.__lift];
  }

  // Typed value: {$: value} or {type: value}
  if (isTypedValue(expr)) {
    const keys = Object.keys(expr);
    const type = keys[0]!;
    let value = (expr as Record<string, unknown>)[type];

    // Booleans are SQL keywords, always inline (like NULL)
    if (type === "$" && typeof value === "boolean") {
      return [value ? "TRUE" : "FALSE"];
    }

    // Auto-stringify objects for jsonb
    if (type === "jsonb" && typeof value === "object" && value !== null) {
      value = JSON.stringify(value);
    }

    if (options.inline) {
      const sqlVal = sqlizeValue(value);
      return type === "$" ? [sqlVal] : [`${sqlVal}::${type}`];
    }
    if (options.numbered) {
      const [sql, ...params] = addNumberedParam(value, ctx);
      return type === "$" ? [sql, ...params] : [`${sql}::${type}`, ...params];
    }
    return type === "$" ? ["?", value] : [`?::${type}`, value];
  }

  // Literal value (numbers, booleans - strings are now identifiers)
  if (options.inline) {
    return [sqlizeValue(expr)];
  }
  if (options.numbered) {
    return addNumberedParam(expr, ctx);
  }
  return ["?", expr];
}

function normalizeOp(x: unknown): string | null {
  if (typeof x === "string") {
    const op = x.toLowerCase();
    return infixAliases.get(op) ?? op;
  }
  if (typeof x === "symbol") {
    const op = (x.description ?? "").toLowerCase();
    return infixAliases.get(op) ?? op;
  }
  return null;
}

function formatVar(x: SqlIdent, ctx: FormatContext, opts: { aliased?: boolean; dropNs?: boolean } = {}): FormatResult {
  const name = typeof x === "symbol" ? (x.description ?? "") : x;

  // %function.arg.arg shorthand
  if (name.startsWith("%")) {
    const parts = splitBySeparator(name.substring(1), ".");
    const fn = parts[0]!.toUpperCase().replace(/-/g, "_");
    const args = parts.slice(1).map((p) => formatEntity(p, ctx));
    return [`${fn}(${args.join(", ")})`];
  }

  // Regular entity
  return [formatEntity(x, ctx, opts)];
}

function formatParamRef(paramName: string, ctx: FormatContext): FormatResult {
  const { options } = ctx;

  if (!(paramName in options.params)) {
    throw new Error(`Missing parameter value for ${paramName}`);
  }

  const value = options.params[paramName];

  if (options.inline) {
    return [sqlizeValue(value)];
  }
  if (options.numbered) {
    return addNumberedParam(value, ctx);
  }
  return ["?", value];
}

function addNumberedParam(value: unknown, ctx: FormatContext): FormatResult {
  const numbered = ctx.options.numbered as unknown[];
  numbered.push(value);
  return [`$${numbered.length}`, value];
}

// ============================================================================
// Format Expression List
// ============================================================================

export function formatExprList(exprs: SqlExpr[], ctx: FormatContext): [string[], unknown[]] {
  const sqls: string[] = [];
  const params: unknown[] = [];

  for (const expr of exprs) {
    const [sql, ...p] = formatExpr(expr, ctx);
    sqls.push(sql);
    params.push(...p);
  }

  return [sqls, params];
}

// ============================================================================
// Infix Expression Formatting
// ============================================================================

function formatEqualityExpr(
  op: string,
  expr: SqlExpr[],
  ctx: FormatContext,
  nested: boolean
): FormatResult {
  const [, a, b, ...rest] = expr;
  if (rest.length > 0) {
    throw new Error(`Only binary ${op} is supported`);
  }

  const [s1, ...p1] = formatExpr(a as SqlExpr, ctx, { nested: true });
  const [s2, ...p2] = formatExpr(b as SqlExpr, ctx, { nested: true });

  const transform = ctx.options.transformNullEquals;

  let sql: string;
  if (transform && (a === null || b === null)) {
    const nonNull = a === null ? s2 : s1;
    sql = op === "=" ? `${nonNull} IS NULL` : `${nonNull} IS NOT NULL`;
  } else {
    sql = `${s1} ${sqlKw(op)} ${s2}`;
  }

  if (nested) sql = `(${sql})`;
  return [sql, ...p1, ...p2];
}

function formatInfixExpr(
  op: string,
  expr: SqlExpr[],
  ctx: FormatContext,
  nested: boolean
): FormatResult {
  let args = expr.slice(1) as SqlExpr[];

  // Filter nil for AND/OR
  if (opIgnoreNil.has(op)) {
    args = args.filter((x) => x != null);
  }

  // Handle empty AND/OR
  if (args.length === 0) {
    if (op === "and") return ["TRUE"];
    if (op === "or") return ["FALSE"];
    throw new Error(`No operands found for ${op}`);
  }

  // Format each argument with nesting
  const formattedParts: string[] = [];
  const allParams: unknown[] = [];
  for (const arg of args) {
    const [s, ...p] = formatExpr(arg, ctx, { nested: true });
    formattedParts.push(s);
    allParams.push(...p);
  }

  let sql: string;
  if (opCanBeUnary.has(op) && formattedParts.length === 1) {
    sql = `${sqlKw(op)} ${formattedParts[0]}`;
  } else {
    sql = formattedParts.join(` ${sqlKw(op)} `);
  }

  if (nested) sql = `(${sql})`;
  return [sql, ...allParams];
}

// ============================================================================
// IN Expression Formatting
// ============================================================================

function formatIn(
  op: string,
  [x, y]: [SqlExpr, SqlExpr],
  ctx: FormatContext,
  nested: boolean
): FormatResult {
  const { options } = ctx;
  const [sqlX, ...paramsX] = formatExpr(x, ctx, { nested: true });

  // Check for empty collection
  if (options.checking !== "none") {
    if (Array.isArray(y) && y.length === 0) {
      throw new Error("IN () empty collection is illegal");
    }
  }

  // Expand array of values
  if (Array.isArray(y) && y.length > 0 && !isIdent(y[0]) && !isExprArray(y[0])) {
    const [sqls, params] = formatExprList(y, ctx);
    const sql = `${sqlX} ${sqlKw(op)} (${sqls.join(", ")})`;
    return [nested ? `(${sql})` : sql, ...paramsX, ...params];
  }

  // Otherwise format as expression (could be subquery, param reference, etc.)
  const [sqlY, ...paramsY] = formatExpr(y, ctx, { nested: true });
  const sql = `${sqlX} ${sqlKw(op)} ${sqlY}`;
  return [nested ? `(${sql})` : sql, ...paramsX, ...paramsY];
}

// ============================================================================
// Function Call Formatting
// ============================================================================

function formatFnCall(fn: string, expr: SqlExpr[], ctx: FormatContext): FormatResult {
  const args = expr.slice(1);
  let fnSql = sqlKw(fn).replace(/ /g, "_");

  // Handle DISTINCT aggregates: %count-distinct -> COUNT(DISTINCT ...)
  let distinctPrefix = "";
  if (fnSql.endsWith("_DISTINCT")) {
    fnSql = fnSql.slice(0, -9); // Remove _DISTINCT suffix
    distinctPrefix = "DISTINCT ";
  }

  if (args.length === 0) {
    return [`${fnSql}()`];
  }

  const [sqls, params] = formatExprList(args as SqlExpr[], ctx);
  return [`${fnSql}(${distinctPrefix}${sqls.join(", ")})`, ...params];
}

// ============================================================================
// Raw SQL Rendering
// ============================================================================

function rawRender(s: string | (string | SqlExpr)[], ctx: FormatContext): FormatResult {
  if (typeof s === "string") {
    return [s];
  }

  const sqls: string[] = [];
  const params: unknown[] = [];

  for (const part of s) {
    if (typeof part === "string") {
      sqls.push(part);
    } else {
      const [sql, ...p] = formatExpr(part as SqlExpr, ctx);
      sqls.push(sql);
      params.push(...p);
    }
  }

  return [sqls.join(""), ...params];
}

// ============================================================================
// Special Syntax Registry
// ============================================================================

type SpecialSyntaxFn = (k: string, args: SqlExpr[], ctx: FormatContext) => FormatResult;

const specialSyntax = new Map<string, SpecialSyntaxFn>([
  // CASE expression
  ["case", (k, args, ctx) => {
    const pairs: [SqlExpr, SqlExpr][] = [];
    for (let i = 0; i < args.length; i += 2) {
      pairs.push([args[i]!, args[i + 1]!]);
    }

    const parts: string[] = ["CASE"];
    const params: unknown[] = [];

    for (const [cond, val] of pairs) {
      if (cond === "else" || (typeof cond === "string" && cond.toLowerCase() === "else")) {
        const [sqlV, ...pV] = formatExpr(val, ctx);
        parts.push("ELSE", sqlV);
        params.push(...pV);
      } else {
        const [sqlC, ...pC] = formatExpr(cond, ctx);
        const [sqlV, ...pV] = formatExpr(val, ctx);
        parts.push("WHEN", sqlC, "THEN", sqlV);
        params.push(...pC, ...pV);
      }
    }
    parts.push("END");

    return [parts.join(" "), ...params];
  }],

  // CASE with expression
  ["case-expr", (k, args, ctx) => {
    const [expr, ...rest] = args;
    const [sqlE, ...pE] = formatExpr(expr!, ctx);

    const pairs: [SqlExpr, SqlExpr][] = [];
    for (let i = 0; i < rest.length; i += 2) {
      pairs.push([rest[i]!, rest[i + 1]!]);
    }

    const parts: string[] = ["CASE", sqlE];
    const params: unknown[] = [...pE];

    for (const [cond, val] of pairs) {
      if (cond === "else" || (typeof cond === "string" && cond.toLowerCase() === "else")) {
        const [sqlV, ...pV] = formatExpr(val, ctx);
        parts.push("ELSE", sqlV);
        params.push(...pV);
      } else {
        const [sqlC, ...pC] = formatExpr(cond, ctx);
        const [sqlV, ...pV] = formatExpr(val, ctx);
        parts.push("WHEN", sqlC, "THEN", sqlV);
        params.push(...pC, ...pV);
      }
    }
    parts.push("END");

    return [parts.join(" "), ...params];
  }],

  // CAST
  ["cast", (k, [x, type], ctx) => {
    const [sqlX, ...pX] = formatExpr(x!, ctx);
    const typeSql = isIdent(type) ? sqlKw(type as string) : formatExpr(type!, ctx)[0];
    return [`CAST(${sqlX} AS ${typeSql})`, ...pX];
  }],

  // BETWEEN
  ["between", (k, [x, a, b], ctx) => {
    const [sqlX, ...pX] = formatExpr(x!, ctx, { nested: true });
    const [sqlA, ...pA] = formatExpr(a!, ctx, { nested: true });
    const [sqlB, ...pB] = formatExpr(b!, ctx, { nested: true });
    return [`${sqlX} BETWEEN ${sqlA} AND ${sqlB}`, ...pX, ...pA, ...pB];
  }],

  ["not-between", (k, [x, a, b], ctx) => {
    const [sqlX, ...pX] = formatExpr(x!, ctx, { nested: true });
    const [sqlA, ...pA] = formatExpr(a!, ctx, { nested: true });
    const [sqlB, ...pB] = formatExpr(b!, ctx, { nested: true });
    return [`${sqlX} NOT BETWEEN ${sqlA} AND ${sqlB}`, ...pX, ...pA, ...pB];
  }],

  // NOT
  ["not", (k, [x], ctx) => {
    const [sql, ...p] = formatExpr(x!, ctx, { nested: true });
    return [`NOT ${sql}`, ...p];
  }],

  // DISTINCT (in SELECT context)
  ["distinct", (k, [x], ctx) => {
    const [sql, ...p] = formatExpr(x!, ctx, { nested: true });
    return [`DISTINCT ${sql}`, ...p];
  }],

  // FILTER clause: ["filter", fnCall, condition]
  ["filter", (k, [fnCall, condition], ctx) => {
    const [fnSql, ...fnParams] = formatExpr(fnCall!, ctx);
    const [condSql, ...condParams] = formatExpr(condition!, ctx);
    return [`${fnSql} FILTER (WHERE ${condSql})`, ...fnParams, ...condParams];
  }],

  // Composite tuple
  ["composite", (k, args, ctx) => {
    const [sqls, params] = formatExprList(args, ctx);
    return [`(${sqls.join(", ")})`, ...params];
  }],

  // ARRAY - handles both ["array", el1, el2, ...] and ["array", [elements], type?]
  ["array", (k, args, ctx) => {
    // Check if first arg is a clause (subquery array)
    if (args.length === 1 && isClause(args[0])) {
      const [sql, ...p] = formatDsl(args[0] as SqlClause, ctx);
      return [`ARRAY(${sql})`, ...p];
    }

    // Check if first arg is an array (old format: ["array", [elements], type?])
    if (args.length >= 1 && Array.isArray(args[0]) && !isClause(args[0])) {
      const [arr, type] = args;
      const [sqls, params] = formatExprList(arr as SqlExpr[], ctx);
      const typeSuffix = type ? `::${sqlKw(type as string)}[]` : "";
      return [`ARRAY[${sqls.join(", ")}]${typeSuffix}`, ...params];
    }

    // New format from parser: ["array", el1, el2, el3, ...]
    const [sqls, params] = formatExprList(args as SqlExpr[], ctx);
    return [`ARRAY[${sqls.join(", ")}]`, ...params];
  }],

  // NEST (parenthesize)
  ["nest", (k, [x], ctx) => {
    const [sql, ...p] = formatExpr(x!, ctx);
    return [`(${sql})`, ...p];
  }],

  // RAW SQL
  ["raw", (k, args, ctx) => {
    if (args.length === 1) {
      return rawRender(args[0] as string | (string | SqlExpr)[], ctx);
    }
    return rawRender(args as (string | SqlExpr)[], ctx);
  }],

  // INLINE (force inline values)
  ["inline", (k, args, ctx) => {
    const inlineCtx = { ...ctx, options: { ...ctx.options, inline: true } };
    const sqls = args.map((a) => formatExpr(a, inlineCtx)[0]);
    return [sqls.join(" ")];
  }],

  // PARAM reference
  ["param", (k, [name], ctx) => {
    const paramName = typeof name === "symbol" ? (name.description ?? "") : String(name);
    return formatParamRef(paramName, ctx);
  }],

  // LIFT (prevent DSL interpretation)
  ["lift", (k, [x], ctx) => {
    if (ctx.options.inline) {
      return [sqlizeValue(x)];
    }
    if (ctx.options.numbered) {
      return addNumberedParam(x, ctx);
    }
    return ["?", x];
  }],

  // LATERAL
  ["lateral", (k, [x], ctx) => {
    if (isClause(x)) {
      const [sql, ...p] = formatDsl(x, ctx);
      return [`LATERAL (${sql})`, ...p];
    }
    const [sql, ...p] = formatExpr(x!, ctx);
    return [`LATERAL ${sql}`, ...p];
  }],

  // OVER (window function)
  // Format: ["over", fnCall, overSpec] where overSpec has partition-by and order-by
  ["over", (k, args, ctx) => {
    const [fnCall, overSpec] = args as [SqlExpr, SqlClause?];

    // Format the function call
    const [fnSql, ...fnParams] = formatExpr(fnCall, ctx);

    // Format the OVER clause parts
    const overParts: string[] = [];
    const overParams: unknown[] = [];

    if (overSpec) {
      // PARTITION BY
      const partitionBy = overSpec["partition-by"] as SqlExpr[] | undefined;
      if (partitionBy && partitionBy.length > 0) {
        const [sqls, params] = formatExprList(partitionBy, ctx);
        overParts.push(`PARTITION BY ${sqls.join(", ")}`);
        overParams.push(...params);
      }

      // ORDER BY
      const orderBy = overSpec["order-by"] as [SqlExpr, string][] | undefined;
      if (orderBy && orderBy.length > 0) {
        const orderParts: string[] = [];
        for (const [col, dir] of orderBy) {
          const [colSql, ...colParams] = formatExpr(col, ctx);
          // Only add DESC if specified (ASC is the SQL default)
          const dirStr = dir && dir.toLowerCase() === "desc" ? " DESC" : "";
          orderParts.push(`${colSql}${dirStr}`);
          overParams.push(...colParams);
        }
        overParts.push(`ORDER BY ${orderParts.join(", ")}`);
      }
    }

    const overClause = overParts.length > 0 ? `(${overParts.join(" ")})` : "()";
    return [`${fnSql} OVER ${overClause}`, ...fnParams, ...overParams];
  }],

  // INTERVAL
  ["interval", (k, args, ctx) => {
    if (args.length === 1) {
      const inlineCtx = { ...ctx, options: { ...ctx.options, inline: true } };
      const [sql, ...p] = formatExpr(args[0]!, inlineCtx);
      return [`INTERVAL ${sql}`, ...p];
    }
    const [n, ...units] = args;
    const [sql, ...p] = formatExpr(n!, ctx);
    const unitsSql = units.map((u) => sqlKw(u as string)).join(" ");
    return [`INTERVAL ${sql} ${unitsSql}`, ...p];
  }],

  // Entity (force as SQL entity, not keyword)
  ["entity", (k, [e], ctx) => {
    return [formatEntity(e as SqlIdent, ctx)];
  }],

  // Alias
  ["alias", (k, [e], ctx) => {
    return [formatEntity(e as SqlIdent, ctx, { aliased: true })];
  }],

  // Dot navigation
  [".", (k, args, ctx) => {
    const [expr, col, ...subcols] = args;
    const [sql, ...p] = formatExpr(expr!, ctx);
    const parts = [formatEntity(col as SqlIdent, ctx)];
    for (const sc of subcols) {
      parts.push(formatEntity(sc as SqlIdent, ctx));
    }
    return [`${sql}.${parts.join(".")}`, ...p];
  }],

  // AT TIME ZONE
  ["at-time-zone", (k, [expr, tz], ctx) => {
    const [sql, ...p] = formatExpr(expr!, ctx, { nested: true });
    const tzSql = isIdent(tz) ? String(tz) : formatExpr(tz!, { ...ctx, options: { ...ctx.options, inline: true } })[0];
    return [`${sql} AT TIME ZONE ${tzSql}`, ...p];
  }],
]);

// ============================================================================
// Clause Formatters
// ============================================================================

const clauseFormatters = new Map<string, ClauseFormatter>();

// SELECT
function formatSelects(k: string, xs: unknown, ctx: FormatContext): FormatResult {
  const prefix = sqlKw(k);
  const items = Array.isArray(xs) ? xs : [xs];

  const sqls: string[] = [];
  const params: unknown[] = [];

  for (const item of items) {
    // Check for [expr, alias] form - but NOT function calls like ["%count", "*"]
    // Alias form: [[expr], alias] or [column, alias] where first element is NOT a function/operator
    const isAliasForm = Array.isArray(item) &&
      item.length === 2 &&
      // Second element must be a valid alias identifier (not a function name)
      typeof item[1] === "string" &&
      isIdent(item[1]) &&
      !item[1].startsWith("%") &&
      // First element must NOT be a function/operator that takes item[1] as argument
      !(typeof item[0] === "string" && (item[0].startsWith("%") || infixOps.has(item[0])));

    if (isAliasForm) {
      // [expr, alias] form
      const [expr, alias] = item;
      const [sql, ...p] = formatExpr(expr as SqlExpr, ctx);
      const aliasSql = formatEntity(alias as SqlIdent, ctx, { aliased: true });
      sqls.push(`${sql} AS ${aliasSql}`);
      params.push(...p);
    } else {
      const [sql, ...p] = formatExpr(item as SqlExpr, ctx);
      sqls.push(sql);
      params.push(...p);
    }
  }

  return [`${prefix} ${sqls.join(", ")}`, ...params];
}

clauseFormatters.set("select", formatSelects);
clauseFormatters.set("select-distinct", (k, xs, ctx) => {
  const [sql, ...p] = formatSelects("select", xs, ctx);
  return [sql.replace("SELECT", "SELECT DISTINCT"), ...p];
});
clauseFormatters.set("select-distinct-on", (k, xs, ctx) => {
  // Format: [onExprs, ...selectExprs]
  const arr = xs as SqlExpr[];
  const onExprs = arr[0] as SqlExpr[];
  const selectExprs = arr.slice(1);

  const [onSqls, onParams] = formatExprList(onExprs, ctx);
  const [selectSql, ...selectParams] = formatSelects("select", selectExprs, ctx);

  return [
    selectSql.replace("SELECT", `SELECT DISTINCT ON (${onSqls.join(", ")})`),
    ...onParams,
    ...selectParams,
  ];
});
clauseFormatters.set("from", formatSelects);
clauseFormatters.set("returning", formatSelects);

// INSERT INTO
clauseFormatters.set("insert-into", (k, x, ctx) => {
  const items = Array.isArray(x) ? x : [x];
  const table = items[0];

  // Check for subquery: INSERT INTO table (subquery)
  if (items.length === 2 && isClause(items[1]) && !Array.isArray(items[1])) {
    const [tableSql] = formatExpr(table as SqlExpr, ctx);
    const [subSql, ...p] = formatDsl(items[1] as SqlClause, ctx);
    return [`INSERT INTO ${tableSql} ${subSql}`, ...p];
  }

  // Check for column list: INSERT INTO table (col1, col2, ...)
  if (items.length === 2 && Array.isArray(items[1])) {
    const [tableSql] = formatExpr(table as SqlExpr, ctx);
    const columns = (items[1] as string[]).map((col) => formatEntity(col, ctx)).join(", ");
    return [`INSERT INTO ${tableSql} (${columns})`];
  }

  const [sql] = formatExpr(table as SqlExpr, ctx);
  return [`INSERT INTO ${sql}`];
});

clauseFormatters.set("replace-into", (k, x, ctx) => {
  const [sql, ...p] = clauseFormatters.get("insert-into")!(k, x, ctx);
  return [sql.replace("INSERT INTO", "REPLACE INTO"), ...p];
});

// UPDATE
clauseFormatters.set("update", (k, x, ctx) => {
  if (ctx.options.checking !== "none" && !ctx.options.dsl?.where) {
    throw new Error("UPDATE without a non-empty WHERE clause is dangerous");
  }
  const [sql] = formatExpr(x as SqlExpr, ctx);
  return [`UPDATE ${sql}`];
});

// DELETE FROM
clauseFormatters.set("delete-from", (k, x, ctx) => {
  if (ctx.options.checking !== "none" && !ctx.options.dsl?.where) {
    throw new Error("DELETE without a non-empty WHERE clause is dangerous");
  }
  const [sql] = formatExpr(x as SqlExpr, ctx);
  return [`DELETE FROM ${sql}`];
});

clauseFormatters.set("delete", (k, xs, ctx) => {
  if (ctx.options.checking !== "none" && !ctx.options.dsl?.where) {
    throw new Error("DELETE without a non-empty WHERE clause is dangerous");
  }
  return formatSelects("delete", xs, ctx);
});

// TRUNCATE
clauseFormatters.set("truncate", (k, x, ctx) => {
  const tables = Array.isArray(x) ? x : [x];
  const sqls = tables.map((t) => formatEntity(t as SqlIdent, ctx));
  return [`TRUNCATE TABLE ${sqls.join(", ")}`];
});

// COLUMNS
clauseFormatters.set("columns", (k, xs, ctx) => {
  if (!Array.isArray(xs)) return [""];
  const sqls = (xs as SqlExpr[]).map((x) => formatEntity(x as SqlIdent, ctx, { dropNs: true }));
  return [`(${sqls.join(", ")})`];
});

// SET (for UPDATE)
clauseFormatters.set("set", (k, xs, ctx) => {
  const entries = Object.entries(xs as Record<string, SqlExpr>);
  const sqls: string[] = [];
  const params: unknown[] = [];

  for (const [col, val] of entries) {
    const colSql = formatEntity(col, ctx, { dropNs: true });
    const [valSql, ...p] = formatExpr(val, ctx);
    sqls.push(`${colSql} = ${valSql}`);
    params.push(...p);
  }

  return [`SET ${sqls.join(", ")}`, ...params];
});

// JOIN
function formatJoin(k: string, clauses: unknown, ctx: FormatContext): FormatResult {
  const joinType = k === "join" ? "INNER JOIN" : sqlKw(k);
  const pairs = clauses as [SqlExpr, SqlExpr][];

  const sqls: string[] = [];
  const params: unknown[] = [];

  for (const [table, condition] of pairs) {
    // Handle [table, alias] form
    let tableSql: string;
    let tableParams: unknown[] = [];

    if (Array.isArray(table) && table.length === 2 && isIdent(table[0]) && isIdent(table[1])) {
      // [table, alias] form
      const tableEntity = formatEntity(table[0] as SqlIdent, ctx);
      const aliasEntity = formatEntity(table[1] as SqlIdent, ctx, { aliased: true });
      tableSql = `${tableEntity} AS ${aliasEntity}`;
    } else {
      const result = formatExpr(table, ctx);
      tableSql = result[0];
      tableParams = result.slice(1);
    }

    // Check for USING clause
    if (Array.isArray(condition) && (condition[0] === "using" || condition[0] === Symbol.for("using"))) {
      const cols = condition.slice(1).map((c) => formatEntity(c as SqlIdent, ctx));
      sqls.push(`${joinType} ${tableSql} USING (${cols.join(", ")})`);
      params.push(...tableParams);
    } else {
      const [condSql, ...condParams] = formatExpr(condition, ctx);
      sqls.push(`${joinType} ${tableSql} ON ${condSql}`);
      params.push(...tableParams, ...condParams);
    }
  }

  return [sqls.join(" "), ...params];
}

clauseFormatters.set("join", formatJoin);
clauseFormatters.set("left-join", formatJoin);
clauseFormatters.set("right-join", formatJoin);
clauseFormatters.set("inner-join", formatJoin);
clauseFormatters.set("outer-join", formatJoin);
clauseFormatters.set("full-join", formatJoin);

clauseFormatters.set("cross-join", (k, xs, ctx) => {
  const tables = Array.isArray(xs) ? xs : [xs];
  const sqls = tables.map((t) => formatExpr(t as SqlExpr, ctx)[0]);
  return [`CROSS JOIN ${sqls.join(", ")}`];
});

// WHERE / HAVING
function formatOnExpr(k: string, e: unknown, ctx: FormatContext): FormatResult {
  if (e == null || (Array.isArray(e) && e.length === 0)) {
    return [""];
  }
  const [sql, ...p] = formatExpr(e as SqlExpr, ctx);
  return [`${sqlKw(k)} ${sql}`, ...p];
}

clauseFormatters.set("where", formatOnExpr);
clauseFormatters.set("having", formatOnExpr);

// GROUP BY
clauseFormatters.set("group-by", (k, xs, ctx) => {
  const items = Array.isArray(xs) ? xs : [xs];
  const [sqls, params] = formatExprList(items as SqlExpr[], ctx);
  return [`GROUP BY ${sqls.join(", ")}`, ...params];
});

// ORDER BY
clauseFormatters.set("order-by", (k, xs, ctx) => {
  const items = Array.isArray(xs) ? xs : [xs];
  const sqls: string[] = [];
  const params: unknown[] = [];

  for (const item of items) {
    if (Array.isArray(item) && item.length === 2 && typeof item[1] === "string") {
      const [expr, dir] = item as [SqlExpr, string];
      const [sql, ...p] = formatExpr(expr, ctx);
      // Only add direction if it's DESC (ASC is the SQL default)
      const dirStr = dir.toLowerCase() === "desc" ? " DESC" : "";
      sqls.push(`${sql}${dirStr}`);
      params.push(...p);
    } else {
      const [sql, ...p] = formatExpr(item as SqlExpr, ctx);
      sqls.push(sql);
      params.push(...p);
    }
  }

  return [`ORDER BY ${sqls.join(", ")}`, ...params];
});

// LIMIT / OFFSET
clauseFormatters.set("limit", formatOnExpr);
clauseFormatters.set("offset", formatOnExpr);

// VALUES
clauseFormatters.set("values", (k, xs, ctx) => {
  const rows = xs as Record<string, SqlExpr>[] | SqlExpr[][];

  if (rows.length === 0) {
    return ["VALUES ()"];
  }

  // Check if it's array of maps (INSERT with column names)
  const firstRow = rows[0];
  if (firstRow && typeof firstRow === "object" && !Array.isArray(firstRow)) {
    // [{a: 1, b: 2}, {a: 3, b: 4}]
    const cols = Object.keys(firstRow);
    const colsSql = cols.map((c) => formatEntity(c, ctx, { dropNs: true })).join(", ");

    const rowSqls: string[] = [];
    const params: unknown[] = [];

    for (const row of rows as Record<string, SqlExpr>[]) {
      const [vals, p] = formatExprList(cols.map((c) => row[c]!), ctx);
      rowSqls.push(`(${vals.join(", ")})`);
      params.push(...p);
    }

    return [`(${colsSql}) VALUES ${rowSqls.join(", ")}`, ...params];
  }

  // [[1, 2], [3, 4]]
  const rowSqls: string[] = [];
  const params: unknown[] = [];

  for (const row of rows as SqlExpr[][]) {
    const [vals, p] = formatExprList(row, ctx);
    rowSqls.push(`(${vals.join(", ")})`);
    params.push(...p);
  }

  return [`VALUES ${rowSqls.join(", ")}`, ...params];
});

// ON CONFLICT
clauseFormatters.set("on-conflict", (k, x, ctx) => {
  if (x == null) return [""];

  const items = Array.isArray(x) ? x : [x];
  const exprs = items.filter((i) => !isClause(i));
  const clause = items.find((i) => isClause(i)) as SqlClause | undefined;

  const sqls: string[] = ["ON CONFLICT"];
  const params: unknown[] = [];

  if (exprs.length > 0) {
    const [exprSqls, exprParams] = formatExprList(exprs as SqlExpr[], ctx);
    sqls.push(`(${exprSqls.join(", ")})`);
    params.push(...exprParams);
  }

  if (clause) {
    const [sql, ...p] = formatDsl(clause, ctx);
    sqls.push(sql);
    params.push(...p);
  }

  return [sqls.join(" "), ...params];
});

clauseFormatters.set("on-constraint", (k, x, ctx) => {
  const [sql] = formatExpr(x as SqlExpr, ctx);
  return [`ON CONSTRAINT ${sql}`];
});

clauseFormatters.set("do-nothing", () => ["DO NOTHING"]);

clauseFormatters.set("do-update-set", (k, x, ctx) => {
  if (typeof x === "object" && x !== null && "fields" in x) {
    const { fields, where } = x as { fields: SqlExpr[] | Record<string, SqlExpr>; where?: SqlExpr };

    let setSql: string;
    const params: unknown[] = [];

    if (Array.isArray(fields)) {
      // fields are column names to set from EXCLUDED
      const cols = fields.map((f) => {
        const col = formatEntity(f as SqlIdent, ctx, { dropNs: true });
        return `${col} = EXCLUDED.${col}`;
      });
      setSql = `DO UPDATE SET ${cols.join(", ")}`;
    } else {
      // fields is a SET map
      const [setResult, ...p] = clauseFormatters.get("set")!("set", fields, ctx);
      setSql = `DO UPDATE ${setResult}`;
      params.push(...p);
    }

    if (where) {
      const [whereSql, ...wp] = formatOnExpr("where", where, ctx);
      return [`${setSql} ${whereSql}`, ...params, ...wp];
    }

    return [setSql, ...params];
  }

  if (Array.isArray(x)) {
    // Array of columns
    const cols = x.map((f) => {
      const col = formatEntity(f as SqlIdent, ctx, { dropNs: true });
      return `${col} = EXCLUDED.${col}`;
    });
    return [`DO UPDATE SET ${cols.join(", ")}`];
  }

  // Record<string, SqlExpr>
  const [setResult, ...p] = clauseFormatters.get("set")!("set", x, ctx);
  return [`DO UPDATE ${setResult}`, ...p];
});

// WITH
clauseFormatters.set("with", (k, xs, ctx) => {
  const ctes = xs as [SqlExpr, SqlClause][];
  const sqls: string[] = [];
  const params: unknown[] = [];

  for (const [name, query] of ctes) {
    const nameSql = formatEntity(name as SqlIdent, ctx);
    const [querySql, ...p] = formatDsl(query, ctx);
    sqls.push(`${nameSql} AS (${querySql})`);
    params.push(...p);
  }

  return [`WITH ${sqls.join(", ")}`, ...params];
});

clauseFormatters.set("with-recursive", (k, xs, ctx) => {
  const [sql, ...p] = clauseFormatters.get("with")!("with", xs, ctx);
  return [sql.replace("WITH", "WITH RECURSIVE"), ...p];
});

// Set operations
function formatSetOp(k: string, xs: unknown, ctx: FormatContext): FormatResult {
  const queries = xs as SqlClause[];
  const sqls: string[] = [];
  const params: unknown[] = [];

  for (const q of queries) {
    const [sql, ...p] = formatDsl(q, ctx);
    sqls.push(sql);
    params.push(...p);
  }

  return [sqls.join(` ${sqlKw(k)} `), ...params];
}

clauseFormatters.set("union", formatSetOp);
clauseFormatters.set("union-all", formatSetOp);
clauseFormatters.set("intersect", formatSetOp);
clauseFormatters.set("except", formatSetOp);
clauseFormatters.set("except-all", formatSetOp);

// RAW
clauseFormatters.set("raw", (k, x, ctx) => rawRender(x as string | SqlExpr[], ctx));

// NEST
clauseFormatters.set("nest", (k, x, ctx) => formatDsl(x as SqlClause, ctx, { nested: true }));

// FOR (locking)
clauseFormatters.set("for", (k, xs, ctx) => {
  const items = Array.isArray(xs) ? xs : [xs];
  const [strength, ...rest] = items;
  let sql = `FOR ${sqlKw(strength as string)}`;

  for (const item of rest) {
    if (typeof item === "string" || typeof item === "symbol") {
      sql += ` ${sqlKw(item as string)}`;
    }
  }

  return [sql];
});

clauseFormatters.set("lock", clauseFormatters.get("for")!);

// DDL
clauseFormatters.set("create-table", (k, x, ctx) => {
  const items = Array.isArray(x) ? x : [x];
  const [table, ...opts] = items;
  const tableSql = formatEntity(table as SqlIdent, ctx);
  const optsSql = opts.length > 0 ? ` ${opts.map((o) => sqlKw(o as string)).join(" ")}` : "";
  return [`CREATE TABLE${optsSql} ${tableSql}`];
});

clauseFormatters.set("with-columns", (k, xs, ctx) => {
  const cols = xs as SqlExpr[];
  const colSqls = cols.map((col) => {
    if (Array.isArray(col)) {
      const [name, ...types] = col as [SqlIdent, ...string[]];
      const nameSql = formatEntity(name, ctx);
      const typeSql = types.map((t) => sqlKw(t)).join(" ");
      return `${nameSql} ${typeSql}`;
    }
    return formatEntity(col as SqlIdent, ctx);
  });
  return [`(${colSqls.join(", ")})`];
});

clauseFormatters.set("drop-table", (k, x, ctx) => {
  const items = Array.isArray(x) ? x : [x];
  const tables = items.filter((i) => !["if-exists"].includes(String(i)));
  const ifExists = items.includes("if-exists") ? "IF EXISTS " : "";
  const sqls = tables.map((t) => formatEntity(t as SqlIdent, ctx));
  return [`DROP TABLE ${ifExists}${sqls.join(", ")}`];
});

clauseFormatters.set("alter-table", (k, x, ctx) => {
  const items = Array.isArray(x) ? x : [x];
  const [table, ...clauses] = items;
  const tableSql = formatEntity(table as SqlIdent, ctx);

  if (clauses.length === 0) {
    return [`ALTER TABLE ${tableSql}`];
  }

  const clauseSqls = clauses.map((c) => {
    if (isClause(c)) {
      return formatDsl(c, ctx)[0];
    }
    return sqlKw(c as string);
  });

  return [`ALTER TABLE ${tableSql} ${clauseSqls.join(", ")}`];
});

clauseFormatters.set("add-column", (k, xs, ctx) => {
  const cols = xs as SqlExpr[];
  const colSqls = cols.map((col) => {
    if (Array.isArray(col)) {
      const [name, ...types] = col as [SqlIdent, ...string[]];
      const nameSql = formatEntity(name, ctx);
      const typeSql = types.map((t) => sqlKw(t)).join(" ");
      return `ADD COLUMN ${nameSql} ${typeSql}`;
    }
    return `ADD COLUMN ${formatEntity(col as SqlIdent, ctx)}`;
  });
  return [colSqls.join(", ")];
});

clauseFormatters.set("drop-column", (k, x, ctx) => {
  const cols = Array.isArray(x) ? x : [x];
  const sqls = cols.map((c) => `DROP COLUMN ${formatEntity(c as SqlIdent, ctx)}`);
  return [sqls.join(", ")];
});

// ============================================================================
// Format DSL (Statement Map)
// ============================================================================

export function formatDsl(
  statement: SqlClause,
  ctx: FormatContext,
  opts: { nested?: boolean; aliased?: boolean } = {}
): FormatResult {
  const ctxWithDsl = { ...ctx, options: { ...ctx.options, dsl: statement } };
  const sqls: string[] = [];
  const params: unknown[] = [];
  const seen = new Set<string>();

  for (const k of ctxWithDsl.options.clauseOrder) {
    const value = statement[k];
    if (value === undefined) continue;

    seen.add(k);
    const formatter = clauseFormatters.get(k);

    if (!formatter) {
      throw new Error(`Unknown SQL clause: ${k}`);
    }

    const [sql, ...p] = formatter(k, value, ctxWithDsl);
    if (sql) {
      sqls.push(sql);
      params.push(...p);
    }
  }

  // Check for unknown clauses
  const unknown = Object.keys(statement).filter((k) => !seen.has(k) && statement[k] !== undefined);
  if (unknown.length > 0) {
    throw new Error(`Unknown SQL clauses: ${unknown.join(", ")}`);
  }

  let sql = sqls.filter(Boolean).join(" ");

  if (opts.nested && !opts.aliased) {
    sql = `(${sql})`;
  }

  return [sql, ...params];
}

// ============================================================================
// Main Format Function
// ============================================================================

/**
 * Format a SQL data structure into a SQL string with parameters.
 *
 * @param data - SQL clause map or expression
 * @param opts - Formatting options
 * @returns [sqlString, ...params]
 *
 * @example
 * ```ts
 * format({ select: ["*"], from: "users", where: ["=", "id", 1] })
 * // => ["SELECT * FROM users WHERE id = $1", 1]
 * ```
 */
export function format(data: SqlClause | SqlExpr, opts: FormatOptions = {}): FormatResult {
  const ctx = createContext(opts);

  let result: FormatResult;
  if (isClause(data) && !isExprArray(data)) {
    result = formatDsl(data, ctx);
  } else {
    result = formatExpr(data as SqlExpr, ctx);
  }

  // Apply sql-formatter for pretty printing
  if (opts.pretty && result[0]) {
    result[0] = sqlFormat(result[0], {
      language: "postgresql",
      tabWidth: 2,
      keywordCase: "upper",
    });
  }

  return result;
}

// ============================================================================
// Registration Functions
// ============================================================================

/**
 * Register a new clause formatter.
 */
export function registerClause(
  clause: string,
  formatter: ClauseFormatter,
  before?: string | null
): void {
  currentClauseOrder = addClauseBefore(currentClauseOrder, clause, before ?? null);
  clauseFormatters.set(clause, formatter);
}

/**
 * Register a new special syntax function.
 */
export function registerFn(name: string, formatter: SpecialSyntaxFn): void {
  specialSyntax.set(name, formatter);
}

/**
 * Register a new infix operator.
 */
export function registerOp(op: string, opts: { ignoreNil?: boolean } = {}): void {
  infixOps.add(op.toLowerCase());
  if (opts.ignoreNil) {
    opIgnoreNil.add(op.toLowerCase());
  }
}

/**
 * Get current clause order.
 */
export function clauseOrder(): string[] {
  return [...currentClauseOrder];
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a raw SQL fragment.
 */
export function raw(sql: string | (string | SqlExpr)[]): SqlExpr {
  return { __raw: sql };
}

/**
 * Create a parameter reference.
 */
export function param(name: string): SqlExpr {
  return { __param: name };
}

/**
 * Lift a value to prevent DSL interpretation.
 */
export function lift(value: unknown): SqlExpr {
  return { __lift: value };
}

/**
 * Create an equality map for WHERE clauses.
 */
export function mapEquals(data: Record<string, unknown>): SqlExpr {
  const clauses = Object.entries(data).map(([k, v]) => ["=", k, v] as SqlExpr);
  if (clauses.length === 1) return clauses[0]!;
  return ["and", ...clauses];
}
