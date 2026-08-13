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
import { isIdent, isParam, isRaw, isLift, isLiteral, isClause, isExprArray, isTypedValue } from "./types.js";
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

// ---------------------------------------------------------------------------
// DuckDB operator support
//
// DuckDB's parser is a fork of the PostgreSQL grammar, but it is not a superset:
// most of the jsonb operator family, the full-text `@@` operator and the
// geometric `<->` operator have no DuckDB equivalent. Behaviour verified against
// DuckDB v1.5.5 — see duckdb.test.ts for the executable proof of each mapping.
// ---------------------------------------------------------------------------

/**
 * PostgreSQL operators DuckDB cannot express. Formatting one throws rather than
 * emitting SQL that would fail at query time.
 *
 * `?|` and `?&` are here rather than in the lowering table because they take a
 * key *list* whose members would each need their own `json_exists` call; that is
 * only expressible when the list is statically known, so we refuse instead of
 * emitting something that silently works for literals and breaks for expressions.
 */
const duckdbUnsupportedOps = new Set<string>([
  "@@",   // full-text search: DuckDB's FTS extension uses match_bm25(), not an operator
  "<->",  // geometric distance: no point type in DuckDB core
  "?|",   // "any key exists" over a key list
  "?&",   // "all keys exist" over a key list
  "#-",   // delete key at path: no DuckDB equivalent
]);

/**
 * PostgreSQL operators rewritten to DuckDB function calls. Each mapping was
 * executed against DuckDB v1.5.5 before being added here.
 */
const duckdbOpLowerings = new Map<string, (args: SqlExpr[]) => SqlExpr>([
  // Case-insensitive regex: DuckDB has no ~* operator but takes an 'i' flag.
  ["~*", ([a, b]) => ["%regexp_matches", a!, b!, { v: "i" }]],
  ["!~*", ([a, b]) => ["not", ["%regexp_matches", a!, b!, { v: "i" }]]],
  // JSON path access.
  ["#>", ([a, b]) => ["%json_extract", a!, b!]],
  ["#>>", ([a, b]) => ["%json_extract_string", a!, b!]],
  // Key/path existence.
  ["?", ([a, b]) => ["%json_exists", a!, b!]],
  ["@?", ([a, b]) => ["%json_exists", a!, b!]],
  // Containment. PostgreSQL's @> is overloaded across jsonb and arrays; we take
  // the jsonb reading because that is what pg-ops.ts documents it as.
  ["@>", ([a, b]) => ["%json_contains", a!, b!]],
  ["<@", ([a, b]) => ["%json_contains", b!, a!]],
]);

/** Type names with no DuckDB spelling. */
const duckdbTypeAliases = new Map<string, string>([
  ["jsonb", "JSON"],
]);

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
  ["duckdb", {
    dialect: "duckdb",
    quote: (s) => strop('"', s, '"'),
    clauseOrderFn: (order) => addClauseBefore(order, "qualify", "order-by"),
    unsupportedOps: duckdbUnsupportedOps,
    opLowerings: duckdbOpLowerings,
    typeAliases: duckdbTypeAliases,
  }],
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
  // DuckDB statement forms (whole-statement clause keys)
  "describe", "summarize", "show", "pivot", "unpivot",
  // SQL clauses in priority order
  "raw", "nest", "with", "with-recursive", "intersect", "union", "union-all", "except", "except-all",
  // DML statements must come before SELECT for INSERT...SELECT, UPDATE...FROM, etc.
  "insert-into", "insert-or-replace-into", "insert-or-ignore-into",
  "replace-into", "update", "delete", "delete-from", "truncate",
  "select", "select-distinct", "select-distinct-on", "select-top", "select-distinct-top",
  "distinct", "expr", "exclude", "rename",
  "into", "bulk-collect-into",
  "columns", "by-name", "set", "from", "using",
  "join-by",
  "join", "left-join", "right-join", "inner-join", "outer-join", "full-join",
  "asof-join", "asof-left-join", "asof-right-join", "asof-full-join", "asof-inner-join",
  "semi-join", "anti-join", "positional-join",
  "cross-join",
  "where", "sample", "group-by", "having",
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

  // Strip leading % (function call indicator). A bare "%" is the modulo
  // operator, not an empty function name — stripping it would silently delete
  // the operator and turn `a % 7` into `a  7`.
  if (n.length > 1 && n.startsWith("%")) {
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

  // Handle {ident: [...]} qualified identifier format (preserves dots in names)
  if (typeof e === "object" && e !== null && "ident" in e && Array.isArray((e as { ident: string[] }).ident)) {
    const identParts = (e as { ident: string[] }).ident;
    return identParts.map((part) => {
      if (part === "*") return part;
      return dialect.quote(quotedSnake ? nameUnderscore(part) : part);
    }).join(".");
  }

  const name = typeof e === "symbol" ? (e.description ?? "") : e as string;

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

  // Qualified identifier {ident: ["schema", "table", "column"]}
  if (typeof expr === "object" && expr !== null && "ident" in expr && Array.isArray((expr as { ident: string[] }).ident)) {
    return [formatEntity(expr as unknown as string, ctx)];
  }

  // Expression array
  if (isExprArray(expr)) {
    if (expr.length === 0) {
      return [""];
    }

    const op = normalizeOp(expr[0]);

    if (typeof op === "string") {
      // Dialect operator support. Checked before every other dispatch path so a
      // dialect can neither silently emit an operator it lacks nor have a
      // lowering bypassed by the infix/special-syntax tables.
      if (dialect.unsupportedOps?.has(op)) {
        throw new Error(
          `Operator '${op}' is not supported by dialect '${dialect.dialect}'`
        );
      }
      const lowering = dialect.opLowerings?.get(op);
      if (lowering) {
        return formatExpr(lowering(expr.slice(1) as SqlExpr[]), ctx, opts);
      }

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

  // Literal value (always inlined, never parameterized)
  if (isLiteral(expr)) {
    return [sqlizeValue(expr.v)];
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

    // Cast type is dialect-dependent: {jsonb: x} has to emit ::JSON on DuckDB.
    const castType = type === "$" ? type : mapType(type, ctx);

    if (options.inline) {
      const sqlVal = sqlizeValue(value);
      return type === "$" ? [sqlVal] : [`${sqlVal}::${castType}`];
    }
    if (options.numbered) {
      const [sql, ...params] = addNumberedParam(value, ctx);
      return type !== "$" ? [`${sql}::${castType}`, ...params] : [sql, ...params];
    }
    return type !== "$" ? [`?::${castType}`, value] : ["?", value];
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

/**
 * Refuse to emit a construct on a dialect that has no syntax for it. Emitting
 * anyway would produce SQL the target rejects only once it reaches the server.
 */
function requireDialect(ctx: FormatContext, required: string, construct: string): void {
  if (ctx.dialect.dialect !== required) {
    throw new Error(
      `${construct} require dialect '${required}', got '${ctx.dialect.dialect}'`
    );
  }
}

/**
 * Format a type name for cast position. Simple names go through keyword
 * casing and dialect aliases; composite types — STRUCT(a INT), MAP(K, V),
 * INT[3] — are emitted verbatim, because uppercasing would rewrite the field
 * names they contain.
 */
function formatTypeName(type: string, ctx: FormatContext): string {
  const isPrecisionForm = /^[A-Za-z_][A-Za-z0-9_ ]*\(\s*[\d\s,]*\)$/.test(type);
  if (!isPrecisionForm && /[([]/.test(type)) {
    return type;
  }
  return sqlKw(mapType(type, ctx));
}

/**
 * Translate a type name for the active dialect, preserving any precision suffix
 * (`numeric(7,4)` keeps its arguments; only the base name is remapped).
 */
function mapType(type: string, ctx: FormatContext): string {
  const aliases = ctx.dialect.typeAliases;
  if (!aliases) return type;
  const match = type.match(/^([A-Za-z_][A-Za-z0-9_ ]*)(\(.*\))?$/);
  if (!match) return type;
  const mapped = aliases.get(match[1]!.trim().toLowerCase());
  return mapped === undefined ? type : mapped + (match[2] ?? "");
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
    const typeSql = typeof type === "string"
      ? formatTypeName(type, ctx)
      : formatExpr(type!, ctx)[0];
    return [`CAST(${sqlX} AS ${typeSql})`, ...pX];
  }],

  // ---------------------------------------------------------------------
  // DuckDB-specific expression syntax.
  //
  // These live in the emitter rather than in a side-effect import so that
  // `{dialect: "duckdb"}` is complete on its own; each one refuses to emit on
  // a dialect that has no such syntax rather than producing invalid SQL.
  // ---------------------------------------------------------------------

  // Star with modifiers: ["star", {table?, exclude?, replace?}]
  //   ["star", {exclude: ["id"]}]                 -> * EXCLUDE (id)
  //   ["star", {table: "t", exclude: ["id"]}]     -> t.* EXCLUDE (id)
  //   ["star", {replace: [[["%lower","n"], "n"]]}] -> * REPLACE (lower(n) AS n)
  ["star", (k, [spec], ctx) => {
    requireDialect(ctx, "duckdb", "star modifiers (EXCLUDE/REPLACE)");
    const s = (spec ?? {}) as {
      table?: string;
      exclude?: SqlIdent[];
      replace?: Array<[SqlExpr, string]>;
    };
    const params: unknown[] = [];
    let sql = s.table ? `${formatEntity(s.table, ctx)}.*` : "*";

    // DuckDB rejects a column appearing in both lists ("Column "x" cannot occur
    // in both EXCLUDE and REPLACE list"), so refuse before emitting it.
    if (s.exclude?.length && s.replace?.length) {
      const excluded = new Set(s.exclude.map((c) => String(c)));
      const both = s.replace
        .map(([, alias]) => String(alias))
        .filter((alias) => excluded.has(alias));
      if (both.length) {
        throw new Error(
          `Column '${both[0]}' cannot appear in both EXCLUDE and REPLACE`
        );
      }
    }

    if (s.exclude?.length) {
      const cols = s.exclude.map((c) => formatEntity(c, ctx));
      sql += ` EXCLUDE (${cols.join(", ")})`;
    }
    if (s.replace?.length) {
      const parts = s.replace.map(([expr, alias]) => {
        const [exprSql, ...p] = formatExpr(expr, ctx);
        params.push(...p);
        return `${exprSql} AS ${formatEntity(alias, ctx, { aliased: true })}`;
      });
      sql += ` REPLACE (${parts.join(", ")})`;
    }
    return [sql, ...params];
  }],

  // TRY_CAST(x AS TYPE) — like CAST but yields NULL instead of erroring.
  ["try-cast", (k, [x, type], ctx) => {
    requireDialect(ctx, "duckdb", "TRY_CAST");
    const [sqlX, ...pX] = formatExpr(x!, ctx);
    const typeSql = typeof type === "string"
      ? formatTypeName(type, ctx)
      : formatExpr(type!, ctx)[0];
    return [`TRY_CAST(${sqlX} AS ${typeSql})`, ...pX];
  }],

  // Aggregate with an ordered input: list(v ORDER BY v).
  // Stored as ["agg-order-by", <fn call>, [<order by items>]] so the ORDER BY
  // survives as data rather than as text inside the call.
  ["agg-order-by", (k, [call, orderBy], ctx) => {
    const params: unknown[] = [];

    if (!Array.isArray(call) || typeof call[0] !== "string") {
      throw new Error("agg-order-by expects a function call as its first argument");
    }
    // %string_agg-distinct -> STRING_AGG(DISTINCT ...), mirroring formatFnCall.
    let fnName = sqlKw(call[0]).replace(/ /g, "_");
    let distinct = "";
    if (fnName.endsWith("_DISTINCT")) {
      fnName = fnName.slice(0, -9);
      distinct = "DISTINCT ";
    }
    const [argSqls, argParams] = formatExprList(call.slice(1) as SqlExpr[], ctx);
    params.push(...argParams);

    const items = Array.isArray(orderBy) ? orderBy : [orderBy];
    const orderSqls = items.map((item) => {
      // Each item is either an expression or [expr, direction] where the
      // direction may carry a NULLS placement: "desc", "asc nulls last", ...
      if (Array.isArray(item) && item.length === 2 && typeof item[1] === "string" &&
          /^(asc|desc)(\s+nulls\s+(first|last))?$/i.test(item[1])) {
        const [sql, ...p] = formatExpr(item[0] as SqlExpr, ctx);
        params.push(...p);
        return `${sql} ${item[1].toUpperCase()}`;
      }
      const [sql, ...p] = formatExpr(item as SqlExpr, ctx);
      params.push(...p);
      return sql;
    });

    const args = argSqls.length ? `${argSqls.join(", ")} ` : "";
    return [`${fnName}(${distinct}${args}ORDER BY ${orderSqls.join(", ")})`, ...params];
  }],

  // COLLATE: ["collate", expr, "NOCASE"] -> expr COLLATE NOCASE.
  // Valid in both dialects — ungated.
  ["collate", (k, [x, collation], ctx) => {
    const [sql, ...p] = formatExpr(x!, ctx, { nested: true });
    return [`${sql} COLLATE ${sqlKw(String(collation))}`, ...p];
  }],

  // Aggregate null modifiers: ["ignore-nulls", x] -> x IGNORE NULLS (inside an
  // aggregate's parens — a DuckDB extension).
  ["ignore-nulls", (k, [x], ctx) => {
    requireDialect(ctx, "duckdb", "IGNORE NULLS");
    const [sql, ...p] = formatExpr(x!, ctx);
    return [`${sql} IGNORE NULLS`, ...p];
  }],
  ["respect-nulls", (k, [x], ctx) => {
    requireDialect(ctx, "duckdb", "RESPECT NULLS");
    const [sql, ...p] = formatExpr(x!, ctx);
    return [`${sql} RESPECT NULLS`, ...p];
  }],

  // Aggregate state export: ["export-state", call] -> call EXPORT_STATE
  ["export-state", (k, [call], ctx) => {
    requireDialect(ctx, "duckdb", "EXPORT_STATE");
    const [sql, ...p] = formatExpr(call!, ctx);
    return [`${sql} EXPORT_STATE`, ...p];
  }],

  // Struct field access: ["field", expr, "name"] -> (expr)."name"
  // Valid in both PostgreSQL (composite types) and DuckDB (structs) — ungated.
  ["field", (k, [x, name], ctx) => {
    const [sql, ...p] = formatExpr(x!, ctx);
    const nameSql = formatEntity(String(name), ctx);
    return [`(${sql}).${nameSql}`, ...p];
  }],

  // Map literal: ["map", [k, v], ...] -> MAP {'k': v, ...}
  ["map", (k, pairs, ctx) => {
    requireDialect(ctx, "duckdb", "map literals");
    const params: unknown[] = [];
    const parts = pairs.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new Error(`map expects [key, value] pairs, got: ${JSON.stringify(pair)}`);
      }
      const [keySql, ...kp] = formatExpr(pair[0] as SqlExpr, ctx);
      const [valSql, ...vp] = formatExpr(pair[1] as SqlExpr, ctx);
      params.push(...kp, ...vp);
      return `${keySql}: ${valSql}`;
    });
    return [`MAP {${parts.join(", ")}}`, ...params];
  }],

  // Integer division: ["//", a, b] -> a // b. PostgreSQL has no such operator,
  // and lowering to floor(a / b) would silently change decimal semantics.
  ["//", (k, [a, b], ctx) => {
    requireDialect(ctx, "duckdb", "// integer division");
    const [sqlA, ...pA] = formatExpr(a!, ctx, { nested: true });
    const [sqlB, ...pB] = formatExpr(b!, ctx, { nested: true });
    return [`${sqlA} // ${sqlB}`, ...pA, ...pB];
  }],

  // GROUPING SETS: ["grouping-sets", [a, b], [a], []] ->
  // GROUPING SETS ((a, b), (a), ()). Valid in both dialects — ungated.
  ["grouping-sets", (k, sets, ctx) => {
    const params: unknown[] = [];
    const parts = sets.map((set) => {
      const items = Array.isArray(set) ? set : [set];
      const [sqls, p] = formatExprList(items as SqlExpr[], ctx);
      params.push(...p);
      return `(${sqls.join(", ")})`;
    });
    return [`GROUPING SETS (${parts.join(", ")})`, ...params];
  }],

  // Array/list subscript: ["at", x, i] -> x[i]
  //
  // Not dialect-gated: subscripting is spelled the same in PostgreSQL and
  // DuckDB. Without this the expression fell through to the generic function
  // path and emitted `AT(x, i)`, which is not a function in either dialect.
  ["at", (k, [x, index], ctx) => {
    const [sqlX, ...pX] = formatExpr(x!, ctx);
    const [sqlI, ...pI] = formatExpr(index!, ctx);
    return [`${sqlX}[${sqlI}]`, ...pX, ...pI];
  }],

  // List slice: ["slice", x, from, to] -> x[from:to]
  ["slice", (k, [x, from, to], ctx) => {
    requireDialect(ctx, "duckdb", "list slicing");
    const params: unknown[] = [];
    const part = (e: SqlExpr | undefined): string => {
      if (e === undefined || e === null) return "";
      const [sql, ...p] = formatExpr(e, ctx);
      params.push(...p);
      return sql === "NULL" ? "" : sql;
    };
    const [sqlX, ...pX] = formatExpr(x!, ctx);
    params.unshift(...pX);
    return [`${sqlX}[${part(from)}:${part(to)}]`, ...params];
  }],

  // Named argument: ["named-arg", "name", value] -> name := value
  ["named-arg", (k, [name, value], ctx) => {
    requireDialect(ctx, "duckdb", "named arguments");
    const [sql, ...p] = formatExpr(value!, ctx);
    return [`${formatEntity(String(name), ctx)} := ${sql}`, ...p];
  }],

  // List literal: ["list", a, b, c] -> [a, b, c]
  ["list", (k, args, ctx) => {
    requireDialect(ctx, "duckdb", "list literals");
    const [sqls, params] = formatExprList(args, ctx);
    return [`[${sqls.join(", ")}]`, ...params];
  }],

  // Struct literal: ["struct", ["a", expr], ["b", expr]] -> {'a': expr, 'b': expr}
  ["struct", (k, pairs, ctx) => {
    requireDialect(ctx, "duckdb", "struct literals");
    const params: unknown[] = [];
    const parts = pairs.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new Error(`struct expects [key, value] pairs, got: ${JSON.stringify(pair)}`);
      }
      const [key, value] = pair as [string, SqlExpr];
      const [valueSql, ...p] = formatExpr(value, ctx);
      params.push(...p);
      return `${sqlizeValue(String(key))}: ${valueSql}`;
    });
    return [`{${parts.join(", ")}}`, ...params];
  }],

  // Lambda: ["lambda", "x", expr] -> x -> expr
  //         ["lambda", ["x","y"], expr] -> (x, y) -> expr
  ["lambda", (k, [params_, body], ctx) => {
    requireDialect(ctx, "duckdb", "lambda expressions");
    const names = Array.isArray(params_) ? params_ : [params_];
    const head = names.length === 1
      ? formatEntity(names[0] as SqlIdent, ctx)
      : `(${names.map((n) => formatEntity(n as SqlIdent, ctx)).join(", ")})`;
    const [bodySql, ...p] = formatExpr(body!, ctx);
    return [`${head} -> ${bodySql}`, ...p];
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

    // Old format: ["array", [elements], type?] — where `type` is a type NAME.
    //
    // This must not swallow a nested array expression such as
    //   ["array", ["array", 1, 2], ["array", 3, 4]]   (ARRAY[[1,2],[3,4]])
    // whose args[0] is itself an expression and whose args[1] is another
    // expression rather than a type string. Requiring args[0] to be a plain
    // element list, and any second arg to be a string, keeps the two apart.
    const isExprHeaded = (x: unknown): boolean =>
      Array.isArray(x) &&
      typeof x[0] === "string" &&
      (x[0].startsWith("%") ||
        infixOps.has(x[0].toLowerCase()) ||
        specialSyntax.has(x[0].toLowerCase()));

    if (
      args.length >= 1 && args.length <= 2 &&
      Array.isArray(args[0]) && !isClause(args[0]) && !isExprHeaded(args[0]) &&
      (args.length === 1 || typeof args[1] === "string")
    ) {
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

      // Window frame: {frame: {raw}} round-trips verbatim; a programmatic
      // frame is built from its structured fields. Frames are standard SQL —
      // valid in both PostgreSQL and DuckDB — so this is not dialect-gated.
      const frame = overSpec.frame as
        | { raw?: string; units?: string; start?: string; end?: string; exclude?: string }
        | undefined;
      if (frame) {
        if (frame.raw) {
          overParts.push(frame.raw);
        } else {
          const units = (frame.units ?? "rows").toUpperCase();
          let text: string;
          if (frame.start && frame.end) {
            text = `${units} BETWEEN ${frame.start} AND ${frame.end}`;
          } else {
            text = `${units} ${frame.start ?? "UNBOUNDED PRECEDING"}`;
          }
          if (frame.exclude) {
            text += ` EXCLUDE ${frame.exclude.toUpperCase().replace(/-/g, " ")}`;
          }
          overParts.push(text);
        }
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

/**
 * Special-syntax constructs that require two or more arguments.
 *
 * A two-element array headed by one of these cannot be that construct, so it is
 * an `[expr, alias]` pair instead — `["at", "a"]` is the table `at` aliased as
 * `a`, not a subscript. Names here are plausible identifiers, which is exactly
 * why the distinction matters.
 */
const specialSyntaxMinTwoArgs = new Set<string>([
  "at", "slice", "named-arg", "cast", "try-cast", "between", "not-between",
  "agg-order-by", "lambda", "in", "not-in", "over",
]);

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
      // First element must NOT be a function/operator/construct that takes
      // item[1] as an argument. Without the specialSyntax check, a one-argument
      // construct such as ["list", "a"] or ["struct", "a"] would be misread as
      // "select column `list` aliased as `a`".
      //
      // Constructs needing two or more arguments are exempt: a two-element
      // array cannot be one of those, so ["at", "a"] is a table named `at`
      // aliased as `a`, not a subscript missing its index.
      !(typeof item[0] === "string" &&
        (item[0].startsWith("%") ||
          infixOps.has(item[0]) ||
          (specialSyntax.has(item[0].toLowerCase()) &&
            !specialSyntaxMinTwoArgs.has(item[0].toLowerCase()))));

    // [expr, [alias, ...columnNames]] — a derived table with a column alias
    // list, e.g. FROM (VALUES (1,2)) AS t(a, b).
    const isColumnAliasForm =
      Array.isArray(item) &&
      item.length === 2 &&
      Array.isArray(item[1]) &&
      item[1].length > 1 &&
      (item[1] as unknown[]).every((x) => typeof x === "string") &&
      !(typeof item[0] === "string" &&
        (item[0].startsWith("%") ||
          infixOps.has(item[0]) ||
          specialSyntax.has(item[0].toLowerCase())));

    if (isColumnAliasForm) {
      const [expr, aliasParts] = item as [SqlExpr, string[]];
      const [sql, ...p] = formatExpr(expr, ctx);
      const [alias, ...cols] = aliasParts;
      const colSql = cols.map((c) => formatEntity(c, ctx, { aliased: true })).join(", ");
      sqls.push(
        `${sql} AS ${formatEntity(alias!, ctx, { aliased: true })}(${colSql})`
      );
      params.push(...p);
    } else if (isAliasForm) {
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
    } else if (
      Array.isArray(table) &&
      table.length === 2 &&
      isClause(table[0]) &&
      typeof table[1] === "string"
    ) {
      // [subquery, alias] form: JOIN (SELECT ...) AS s
      const [subSql, ...subParams] = formatDsl(table[0] as SqlClause, ctx);
      const aliasEntity = formatEntity(table[1], ctx, { aliased: true });
      tableSql = `(${subSql}) AS ${aliasEntity}`;
      tableParams = subParams;
    } else {
      const result = formatExpr(table, ctx);
      tableSql = result[0];
      tableParams = result.slice(1);
    }

    // Condition-less join (DuckDB POSITIONAL JOIN): no ON at all.
    if (condition === null || condition === undefined) {
      sqls.push(`${joinType} ${tableSql}`);
      params.push(...tableParams);
    } else if (Array.isArray(condition) && (condition[0] === "using" || condition[0] === Symbol.for("using"))) {
      // USING clause
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

// DuckDB join variants. formatJoin derives the keyword from the clause key
// (sqlKw("asof-join") -> "ASOF JOIN"), so these all reuse it; the DuckDB-only
// gate lives here rather than in formatJoin.
const duckdbJoinKeys = [
  "asof-join", "asof-left-join", "asof-right-join", "asof-full-join",
  "asof-inner-join", "semi-join", "anti-join", "positional-join",
] as const;
for (const key of duckdbJoinKeys) {
  clauseFormatters.set(key, (k, clauses, ctx) => {
    requireDialect(ctx, "duckdb", `${sqlKw(k)} joins`);
    return formatJoin(k, clauses, ctx);
  });
}

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
// DuckDB QUALIFY — filters on window function results, after HAVING/WINDOW and
// before ORDER BY. Only reachable on dialects whose clause order includes it.
clauseFormatters.set("qualify", formatOnExpr);

// DuckDB USING SAMPLE. The parsed form keeps the raw spec text for verbatim
// round-trips; a programmatic spec is built from its structured fields.
clauseFormatters.set("sample", (k, spec, ctx) => {
  requireDialect(ctx, "duckdb", "USING SAMPLE");
  const s = spec as {
    raw?: string;
    value?: number;
    unit?: "%" | "rows";
    method?: string;
    seed?: number;
  };
  if (s.raw) return [`USING SAMPLE ${s.raw}`];
  // Seed grammar (verified against DuckDB v1.5.5): REPEATABLE only attaches
  // to a method(...) form; bare `10% REPEATABLE (n)` is a parse error, and a
  // seeded percentage is spelled `10% (system, n)`.
  let text: string;
  if (s.method) {
    text = `${s.method}(${s.value ?? 10}${s.unit === "%" ? "%" : s.unit === "rows" ? " ROWS" : ""})`;
    if (s.seed !== undefined) text += ` REPEATABLE (${s.seed})`;
  } else if (s.seed !== undefined) {
    if (s.unit === "%") {
      text = `${s.value ?? 10}% (system, ${s.seed})`;
    } else {
      text = `reservoir(${s.value ?? 10} ROWS) REPEATABLE (${s.seed})`;
    }
  } else {
    text = `${s.value ?? 10}${s.unit === "%" ? "%" : s.unit === "rows" ? " ROWS" : ""}`;
  }
  return [`USING SAMPLE ${text}`];
});

// DuckDB BY NAME (INSERT INTO t BY NAME SELECT ...).
clauseFormatters.set("by-name", (k, flag, ctx) => {
  requireDialect(ctx, "duckdb", "INSERT BY NAME");
  return [flag ? "BY NAME" : ""];
});

// DESCRIBE / SUMMARIZE — target is a table name or a nested statement.
for (const key of ["describe", "summarize"] as const) {
  clauseFormatters.set(key, (k, target, ctx) => {
    requireDialect(ctx, "duckdb", sqlKw(k));
    if (isClause(target)) {
      const [sql, ...p] = formatDsl(target as SqlClause, ctx);
      return [`${sqlKw(k)} ${sql}`, ...p];
    }
    return [`${sqlKw(k)} ${formatEntity(String(target), ctx)}`];
  });
}

// SHOW — the tail is raw command text (TABLES, ALL TABLES, ...), not an
// identifier.
clauseFormatters.set("show", (k, what, ctx) => {
  requireDialect(ctx, "duckdb", "SHOW");
  return [`SHOW ${String(what)}`];
});

/**
 * PIVOT / UNPIVOT. Two styles share a clause key, discriminated by `style`:
 * DuckDB's statement form (`PIVOT t ON a USING sum(b)`) and the SQL-standard
 * postfix form (`SELECT * FROM t PIVOT(sum(b) FOR a IN (...))`).
 */
function formatPivot(k: string, node: unknown, ctx: FormatContext): FormatResult {
  requireDialect(ctx, "duckdb", sqlKw(k));
  const p = node as Record<string, unknown>;
  const params: unknown[] = [];

  const sourceSql = (() => {
    if (isClause(p.source)) {
      const [sql, ...sp] = formatDsl(p.source as SqlClause, ctx);
      params.push(...sp);
      return `(${sql})`;
    }
    return formatEntity(String(p.source), ctx);
  })();

  const list = (items: unknown, aliased = false): string => {
    const arr = Array.isArray(items) ? items : [items];
    return arr
      .map((item) => {
        // Select-item alias form [expr, alias].
        if (
          aliased &&
          Array.isArray(item) &&
          item.length === 2 &&
          typeof item[1] === "string" &&
          !(typeof item[0] === "string")
        ) {
          const [sql, ...ip] = formatExpr(item[0] as SqlExpr, ctx);
          params.push(...ip);
          return `${sql} AS ${formatEntity(item[1] as string, ctx, { aliased: true })}`;
        }
        const [sql, ...ip] = formatExpr(item as SqlExpr, ctx);
        params.push(...ip);
        return sql;
      })
      .join(", ");
  };

  if (p.style === "standard") {
    // Emitted as a full derived select so it is valid anywhere a clause is.
    const kind = k.toUpperCase();
    const inList = list(p.in);
    const [forSql, ...fp] = formatExpr(p.for as SqlExpr, ctx);
    params.push(...fp);
    const body =
      k === "pivot"
        ? `${list(p.aggs, true)} FOR ${forSql} IN (${inList})`
        : `${list(p.value)} FOR ${forSql} IN (${inList})`;
    const include = p["include-nulls"] ? "INCLUDE NULLS " : "";
    return [`SELECT * FROM ${sourceSql} ${kind} ${include}(${body})`, ...params];
  }

  let sql = `${sqlKw(k)} ${sourceSql}`;
  if (p.on) sql += ` ON ${list(p.on)}`;
  if (p.using) sql += ` USING ${list(p.using, true)}`;
  if (p["group-by"]) sql += ` GROUP BY ${list(p["group-by"])}`;
  if (p["into-name"]) {
    sql += ` INTO NAME ${formatEntity(String(p["into-name"]), ctx)} VALUE ${list(p["into-value"])}`;
  }
  return [sql, ...params];
}

clauseFormatters.set("pivot", formatPivot);
clauseFormatters.set("unpivot", formatPivot);

// INSERT OR REPLACE / INSERT OR IGNORE — DuckDB conflict shorthands. They
// reuse the insert-into formatter and rewrite its prefix, so every source
// shape (VALUES, SELECT, column lists) stays supported in one place.
{
  const insertInto = clauseFormatters.get("insert-into")!;
  for (const [key, prefix] of [
    ["insert-or-replace-into", "INSERT OR REPLACE INTO"],
    ["insert-or-ignore-into", "INSERT OR IGNORE INTO"],
  ] as const) {
    clauseFormatters.set(key, (k, x, ctx) => {
      requireDialect(ctx, "duckdb", prefix);
      const [sql, ...p] = insertInto("insert-into", x, ctx);
      return [sql.replace(/^INSERT INTO\b/, prefix), ...p];
    });
  }
}

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
  // INSERT INTO t SELECT ... — the source is a query, not a row list. It emits
  // as a bare subquery because `INSERT INTO t VALUES SELECT ...` is not SQL.
  if (isClause(xs)) {
    return formatDsl(xs as SqlClause, ctx);
  }

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
 * Register a SQL dialect, or override a built-in one.
 *
 * Dialects carry their own operator support so that a clause map targeting one
 * dialect cannot silently emit invalid SQL for another — see DialectConfig.
 */
export function registerDialect(
  name: string,
  config: DialectConfig
): void {
  dialects.set(name, { ...config, dialect: name });
}

/** Look up a registered dialect. */
export function getDialect(name: string): (DialectConfig & { dialect: string }) | undefined {
  return dialects.get(name);
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
 * Create a literal SQL constant (always inlined, never parameterized).
 */
export function literal(value: unknown): SqlExpr {
  return { v: value };
}

/**
 * Create an equality map for WHERE clauses.
 */
export function mapEquals(data: Record<string, unknown>): SqlExpr {
  const clauses = Object.entries(data).map(([k, v]) => ["=", k, v] as SqlExpr);
  if (clauses.length === 1) return clauses[0]!;
  return ["and", ...clauses];
}
