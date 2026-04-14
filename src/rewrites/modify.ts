/**
 * Modify helpers — add/remove items on a clause tree.
 *
 * Every helper is immutable: returns a new tree. Structure-aware AND/OR
 * normalization keeps WHERE shapes clean after removal.
 */

import type { SqlClause, SqlExpr } from "../types.js";
import type { Matcher } from "./matchers.js";
import { mapClauseTree, mapExprTree } from "./walk.js";

// ============================================================================
// addWhere
// ============================================================================

export interface AddWhereOptions {
  /**
   * Which clauses receive the condition:
   *  - `"root"`: only the top-level clause
   *  - `"all"`: every clause that has a FROM/UPDATE/DELETE-FROM (default)
   *  - `(scope) => boolean`: custom predicate
   */
  scope?: "root" | "all" | ((scope: string) => boolean);
}

/**
 * AND a predicate into a WHERE clause. Default scope is "all" — matches
 * `injectWhere` semantics for tenant isolation. Set `scope: "root"` to only
 * affect the outer query.
 */
export function addWhere(
  clause: SqlClause,
  condition: SqlExpr,
  opts: AddWhereOptions = {}
): SqlClause {
  const scope = opts.scope ?? "all";
  return mapClauseTree(clause, (c, clauseScope) => {
    if (!shouldInject(scope, clauseScope)) return c;
    if (!hasTarget(c)) return c;
    // Dedup — skip if this exact condition is already present (structural eq)
    if (containsCondition(c.where as SqlExpr | undefined, condition)) return c;
    if (c.where === undefined) return { ...c, where: condition };
    return { ...c, where: ["and", c.where, condition] as SqlExpr };
  });
}

function shouldInject(
  scope: AddWhereOptions["scope"],
  clauseScope: string
): boolean {
  if (scope === "root") return clauseScope === "root";
  if (scope === "all" || scope === undefined) return true;
  return scope(clauseScope);
}

function hasTarget(c: SqlClause): boolean {
  return c.from !== undefined || c["delete-from"] !== undefined || c.update !== undefined;
}

function containsCondition(existing: SqlExpr | undefined, needle: SqlExpr): boolean {
  if (existing === undefined) return false;
  if (deepEqual(existing, needle)) return true;
  if (Array.isArray(existing) && existing[0] === "and") {
    for (let i = 1; i < existing.length; i++) {
      if (containsCondition(existing[i] as SqlExpr, needle)) return true;
    }
  }
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length) return false;
    if (!ak.every((k, i) => k === bk[i])) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}

// ============================================================================
// removeWhere
// ============================================================================

/**
 * Remove every matching predicate from WHERE clauses across the tree.
 * AND/OR connectives are normalized: a 2-arg AND with one child removed
 * collapses to the surviving child; if all children are removed, the WHERE
 * clause itself is dropped.
 */
export function removeWhere(clause: SqlClause, matcher: Matcher): SqlClause {
  return mapClauseTree(clause, (c) => {
    if (c.where === undefined) return c;
    const pruned = pruneExpr(c.where as SqlExpr, matcher);
    if (pruned === REMOVED) {
      const { where: _w, ...rest } = c;
      return rest;
    }
    return { ...c, where: pruned };
  });
}

/**
 * Remove matching predicates from WHERE *and* HAVING.
 */
export function removePredicate(clause: SqlClause, matcher: Matcher): SqlClause {
  return mapClauseTree(clause, (c) => {
    let next = c;
    if (c.where !== undefined) {
      const pruned = pruneExpr(c.where as SqlExpr, matcher);
      if (pruned === REMOVED) {
        const { where: _w, ...rest } = next;
        next = rest;
      } else {
        next = { ...next, where: pruned };
      }
    }
    if (c.having !== undefined) {
      const pruned = pruneExpr(c.having as SqlExpr, matcher);
      if (pruned === REMOVED) {
        const { having: _h, ...rest } = next;
        next = rest;
      } else {
        next = { ...next, having: pruned };
      }
    }
    return next;
  });
}

const REMOVED = Symbol("removed");
type PruneResult = SqlExpr | typeof REMOVED;

function pruneExpr(expr: SqlExpr, matcher: Matcher): PruneResult {
  if (matcher(expr)) return REMOVED;
  if (!Array.isArray(expr)) return expr;

  const [head] = expr;
  if (head === "and" || head === "or") {
    const kept: SqlExpr[] = [];
    for (let i = 1; i < expr.length; i++) {
      const child = pruneExpr(expr[i] as SqlExpr, matcher);
      if (child !== REMOVED) kept.push(child);
    }
    if (kept.length === 0) return REMOVED;
    if (kept.length === 1) return kept[0]!;
    return [head as SqlExpr, ...kept] as SqlExpr;
  }

  // For other expressions: do not prune children (a matcher inside `["=", col, v]`
  // would otherwise remove the column or value). removeWhere acts at predicate level.
  return expr;
}

// ============================================================================
// addSelect / removeSelect
// ============================================================================

export function addSelect(
  clause: SqlClause,
  item: SqlExpr,
  alias?: string
): SqlClause {
  const entry: SqlExpr = alias ? ([item, alias] as SqlExpr) : item;
  const existing = toItemArray(clause.select);
  return { ...clause, select: [...(existing ?? []), entry] };
}

export function removeSelect(clause: SqlClause, matcher: Matcher): SqlClause {
  const existing = toItemArray(clause.select);
  if (existing === null) return clause;
  const kept = existing.filter((item) => {
    const target =
      Array.isArray(item) &&
      item.length === 2 &&
      typeof item[1] === "string" &&
      !(item[1] as string).startsWith("%")
        ? (item[0] as SqlExpr)
        : item;
    return !matcher(target);
  });
  if (kept.length === 0) {
    const { select: _, ...rest } = clause;
    return rest;
  }
  return { ...clause, select: kept };
}

function toItemArray(select: unknown): SqlExpr[] | null {
  if (select === undefined) return null;
  return Array.isArray(select) ? (select as SqlExpr[]) : [select as SqlExpr];
}

// ============================================================================
// addGroupBy / removeGroupBy
// ============================================================================

export function addGroupBy(clause: SqlClause, cols: SqlExpr | SqlExpr[]): SqlClause {
  const toAdd = Array.isArray(cols) ? cols : [cols];
  const existing = toItemArray(clause["group-by"]);
  const combined = [...(existing ?? []), ...toAdd];
  return { ...clause, "group-by": combined };
}

export function removeGroupBy(clause: SqlClause, matcher: Matcher): SqlClause {
  const existing = toItemArray(clause["group-by"]);
  if (existing === null) return clause;
  const kept = existing.filter((c) => !matcher(c));
  if (kept.length === 0) {
    const { "group-by": _, ...rest } = clause;
    return rest;
  }
  return { ...clause, "group-by": kept };
}

// ============================================================================
// addOrderBy / setOrderBy / clearOrderBy
// ============================================================================

export interface AddOrderByOptions {
  /** "append" (default) or "prepend" */
  position?: "append" | "prepend";
}

export function addOrderBy(
  clause: SqlClause,
  items: SqlExpr | SqlExpr[],
  opts: AddOrderByOptions = {}
): SqlClause {
  const toAdd = Array.isArray(items) ? items : [items];
  const existing = toItemArray(clause["order-by"]);
  const combined = opts.position === "prepend"
    ? [...toAdd, ...(existing ?? [])]
    : [...(existing ?? []), ...toAdd];
  return { ...clause, "order-by": combined };
}

export function setOrderBy(clause: SqlClause, items: SqlExpr | SqlExpr[]): SqlClause {
  return { ...clause, "order-by": Array.isArray(items) ? items : [items] };
}

export function clearOrderBy(clause: SqlClause): SqlClause {
  const { "order-by": _, ...rest } = clause;
  return rest;
}

// ============================================================================
// setLimit / setOffset / clearLimit
// ============================================================================

export function setLimit(clause: SqlClause, n: number): SqlClause {
  return { ...clause, limit: { $: n } };
}

export function setOffset(clause: SqlClause, n: number): SqlClause {
  return { ...clause, offset: { $: n } };
}

export function clearLimit(clause: SqlClause): SqlClause {
  const { limit: _, ...rest } = clause;
  return rest;
}

export function clearOffset(clause: SqlClause): SqlClause {
  const { offset: _, ...rest } = clause;
  return rest;
}

// Re-export mapExprTree for advanced consumers that want custom traversal
export { mapExprTree };
