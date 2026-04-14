/**
 * Matcher combinators for finding and rewriting SQL clause trees.
 *
 * A `Matcher` is a predicate over a single expression node. Combinators build
 * more complex matchers from simpler ones. Matchers are used by the `find.*`
 * and `rewrite.*` helpers to locate nodes in a clause tree.
 */

import type { SqlExpr } from "../types.js";

export interface MatchContext {
  /** Query scope: "root", "where", "cte:name.where", "union[1].having", etc. */
  scope: string;
  /** Path to this node within its enclosing expression, e.g. "[1][0]" */
  path: string;
}

export type Matcher = (node: SqlExpr, ctx?: MatchContext) => boolean;

// ============================================================================
// Identifier utilities
// ============================================================================

/** Convert a column expression to its dotted string form, or null if not an ident. */
export function identString(x: unknown): string | null {
  if (typeof x === "string") return x;
  if (typeof x === "object" && x !== null && "ident" in x) {
    const parts = (x as { ident: unknown }).ident;
    return Array.isArray(parts) ? parts.join(".") : null;
  }
  return null;
}

/** Parts of a column ident, e.g. ["users", "id"] for "users.id". */
export function identParts(x: unknown): string[] | null {
  if (typeof x === "string") return x.split(".");
  if (typeof x === "object" && x !== null && "ident" in x) {
    const parts = (x as { ident: unknown }).ident;
    return Array.isArray(parts) ? (parts as string[]) : null;
  }
  return null;
}

// ============================================================================
// Column matcher
// ============================================================================

/**
 * Match a column identifier.
 *
 * - `col("foo")` matches `"foo"`, `"t.foo"`, `{ident: ["t", "foo"]}` (bare name match)
 * - `col("users.email")` matches only fully-qualified `"users.email"` or `{ident: ["users", "email"]}`
 *
 * Bare-name match is convenient for LLM SQL that mixes qualified/unqualified refs.
 */
export function col(name: string): Matcher {
  const wanted = name.split(".");
  return (node) => {
    const parts = identParts(node);
    if (!parts) return false;
    if (wanted.length === 1) {
      // bare match: any ident whose last segment equals the wanted name
      return parts[parts.length - 1] === wanted[0];
    }
    // qualified match: last N parts must match exactly
    if (parts.length < wanted.length) return false;
    const tail = parts.slice(-wanted.length);
    return wanted.every((w, i) => w === tail[i]);
  };
}

// ============================================================================
// Operator / function matchers
// ============================================================================

/**
 * Match an array expression whose operator (index 0) equals `operator`.
 *
 * Operators: "=", "<>", "<", "<=", ">", ">=", "and", "or", "not",
 * "in", "between", "like", "ilike", "is", "is-not", etc.
 */
export function op(operator: string): Matcher {
  return (node) => Array.isArray(node) && node[0] === operator;
}

/**
 * Match a function call. `fn("count")` and `fn("%count")` both work.
 */
export function fn(name: string): Matcher {
  const key = name.startsWith("%") ? name : `%${name}`;
  return (node) => Array.isArray(node) && node[0] === key;
}

// ============================================================================
// Date-range matcher
// ============================================================================

const DATE_RANGE_OPS = new Set(["<", "<=", ">", ">=", "between"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function looksLikeDate(v: unknown): boolean {
  if (v instanceof Date) return true;
  if (typeof v === "string") return ISO_DATE_RE.test(v);
  if (Array.isArray(v)) {
    // Cast expression: ["cast", value, "date"] — parser emits this for DATE '...'
    if (v[0] === "cast" && typeof v[2] === "string") {
      if (/^(date|timestamp|timestamptz|time)$/i.test(v[2])) return true;
      return looksLikeDate(v[1]);
    }
    return false;
  }
  if (typeof v === "object" && v !== null) {
    if ("v" in v) return looksLikeDate((v as { v: unknown }).v);
    if ("$" in v) return looksLikeDate((v as { $: unknown }).$);
    // typed value like {date: "..."} or {timestamp: "..."}
    const keys = Object.keys(v);
    if (keys.length === 1) {
      const key = keys[0]!;
      if (/^(date|timestamp|timestamptz|time)$/i.test(key)) return true;
      return looksLikeDate((v as Record<string, unknown>)[key]);
    }
  }
  return false;
}

/**
 * Match a date-range-shaped predicate. Optionally constrain to a specific column.
 *
 * Matches strict range operators on an identifier column: `["<", col, v]`,
 * `["<=", col, v]`, `[">", col, v]`, `[">=", col, v]`, and
 * `["between", col, lo, hi]`. Does **not** match `=` (ambiguous with other
 * equality predicates) or AND/OR combinators.
 *
 * When `column` is omitted, the matcher also requires the value side to
 * look like a date (ISO-format string, `Date`, or typed `{date: ...}`
 * wrapper), so `spend > 100` is not mistaken for a date predicate. When
 * `column` is specified, the caller is presumed to know the column's type,
 * so value shape is not checked.
 */
export function dateRange(column?: string): Matcher {
  const colMatch = column ? col(column) : null;
  return (node) => {
    if (!Array.isArray(node)) return false;
    const [opName, colExpr] = node;
    if (typeof opName !== "string") return false;
    if (!DATE_RANGE_OPS.has(opName)) return false;
    if (identParts(colExpr) === null) return false;
    if (colMatch) return colMatch(colExpr as SqlExpr);
    // No column constraint — require at least one date-looking value
    const values = (node as unknown[]).slice(2);
    return values.some(looksLikeDate);
  };
}

// ============================================================================
// Combinators
// ============================================================================

export const and = (...ms: Matcher[]): Matcher => (node, ctx) =>
  ms.every((m) => m(node, ctx));

export const or = (...ms: Matcher[]): Matcher => (node, ctx) =>
  ms.some((m) => m(node, ctx));

export const not = (m: Matcher): Matcher => (node, ctx) => !m(node, ctx);

export const anyOf = or;
export const allOf = and;

/** Match nodes whose context scope matches a predicate (e.g. `inScope(s => s.startsWith("cte:"))`). */
export const inScope = (pred: (scope: string) => boolean): Matcher =>
  (_node, ctx) => (ctx ? pred(ctx.scope) : false);

/** Always true. */
export const any: Matcher = () => true;

/** Always false. */
export const none: Matcher = () => false;
