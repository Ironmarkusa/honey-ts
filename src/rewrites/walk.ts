/**
 * Shared tree-walking primitives for discovery and rewrite helpers.
 *
 * The rewrite layer walks two kinds of trees:
 *   - **Clause trees**: `SqlClause` objects nested via WITH/UNION/subqueries.
 *   - **Expression trees**: `SqlExpr` arrays within a single clause (WHERE, HAVING, SELECT, etc.)
 *
 * Walkers are non-mutating. Read-only traversal uses visitor callbacks;
 * rewrites map to new trees via transform callbacks.
 */

import type { SqlClause, SqlExpr } from "../types.js";
import { isClause } from "../types.js";
import {
  CTE_KEYS,
  SET_OP_KEYS,
  EXPR_KEYS,
  JOIN_KEYS,
  NESTED_CLAUSE_KEYS,
  SOURCE_SPEC_KEYS,
} from "../traversal.js";

// ============================================================================
// Clause tree walking
// ============================================================================

export type ClauseVisitor = (clause: SqlClause, scope: string) => void;
export type ClauseTransform = (clause: SqlClause, scope: string) => SqlClause;

/**
 * Walk every `SqlClause` in the tree (including CTEs, UNIONs, and subqueries
 * nested in FROM/WHERE/HAVING/SELECT), invoking `visitor` at each.
 */
export function walkClauseTree(
  clause: SqlClause,
  visitor: ClauseVisitor,
  scope = "root"
): void {
  visitor(clause, scope);

  for (const key of CTE_KEYS) {
    const ctes = clause[key] as [string, SqlClause][] | undefined;
    if (ctes) {
      for (const [name, cte] of ctes) {
        const label = typeof name === "string" ? name : String(name);
        walkClauseTree(cte, visitor, `${scope}.${key}:${label}`);
      }
    }
  }

  for (const key of SET_OP_KEYS) {
    const branches = clause[key] as SqlClause[] | undefined;
    if (branches) {
      branches.forEach((b, i) =>
        walkClauseTree(b, visitor, `${scope}.${key}[${i}]`)
      );
    }
  }

  for (const key of EXPR_KEYS) {
    if (clause[key] !== undefined) {
      walkExprForClauses(clause[key] as SqlExpr, visitor, `${scope}.${key}`);
    }
  }

  // Joined tables may be subqueries; ON conditions may contain subqueries.
  for (const key of JOIN_KEYS) {
    const pairs = clause[key] as [SqlExpr, SqlExpr][] | undefined;
    if (pairs) {
      pairs.forEach(([table, cond], i) => {
        walkExprForClauses(table, visitor, `${scope}.${key}[${i}]`);
        if (cond !== null && cond !== undefined) {
          walkExprForClauses(cond, visitor, `${scope}.${key}[${i}].on`);
        }
      });
    }
  }

  for (const key of NESTED_CLAUSE_KEYS) {
    if (isClause(clause[key])) {
      walkClauseTree(clause[key] as SqlClause, visitor, `${scope}.${key}`);
    }
  }

  for (const key of SOURCE_SPEC_KEYS) {
    const spec = clause[key] as { source?: unknown } | undefined;
    if (spec && isClause(spec.source)) {
      walkClauseTree(spec.source as SqlClause, visitor, `${scope}.${key}.source`);
    }
  }
}

function walkExprForClauses(
  expr: SqlExpr,
  visitor: ClauseVisitor,
  scope: string
): void {
  if (isClause(expr)) {
    walkClauseTree(expr, visitor, scope);
    return;
  }
  if (Array.isArray(expr)) {
    for (const e of expr) walkExprForClauses(e as SqlExpr, visitor, scope);
  }
}

/**
 * Transform every `SqlClause` in the tree, returning a new tree.
 * Inner clauses are transformed before outer (post-order), which means an
 * outer transform sees already-transformed inner subqueries.
 */
export function mapClauseTree(
  clause: SqlClause,
  transform: ClauseTransform,
  scope = "root"
): SqlClause {
  let next: SqlClause = { ...clause };

  for (const key of CTE_KEYS) {
    if (next[key] !== undefined) {
      const ctes = next[key] as [string, SqlClause][];
      next[key] = ctes.map(([name, cte]) => {
        const label = typeof name === "string" ? name : String(name);
        return [name, mapClauseTree(cte, transform, `${scope}.${key}:${label}`)];
      }) as never;
    }
  }

  for (const key of SET_OP_KEYS) {
    if (next[key] !== undefined) {
      const branches = next[key] as SqlClause[];
      next[key] = branches.map((b, i) =>
        mapClauseTree(b, transform, `${scope}.${key}[${i}]`)
      ) as never;
    }
  }

  for (const key of EXPR_KEYS) {
    if (next[key] !== undefined) {
      // Writing through the union of all EXPR_KEYS value types overflows the
      // checker (TS2590); the record cast sidesteps it.
      (next as Record<string, unknown>)[key] = mapExprForClauses(
        next[key] as SqlExpr,
        transform,
        `${scope}.${key}`
      );
    }
  }

  // Joined tables may be subqueries; ON conditions may contain subqueries.
  for (const key of JOIN_KEYS) {
    if (next[key] !== undefined) {
      const pairs = next[key] as [SqlExpr, SqlExpr][];
      next[key] = pairs.map(([table, cond], i) => [
        mapExprForClauses(table, transform, `${scope}.${key}[${i}]`),
        cond === null || cond === undefined
          ? cond
          : mapExprForClauses(cond, transform, `${scope}.${key}[${i}].on`),
      ]) as never;
    }
  }

  for (const key of NESTED_CLAUSE_KEYS) {
    if (isClause(next[key])) {
      next[key] = mapClauseTree(
        next[key] as SqlClause,
        transform,
        `${scope}.${key}`
      ) as never;
    }
  }

  for (const key of SOURCE_SPEC_KEYS) {
    const spec = next[key] as { source?: unknown } | undefined;
    if (spec && isClause(spec.source)) {
      next[key] = {
        ...spec,
        source: mapClauseTree(spec.source as SqlClause, transform, `${scope}.${key}.source`),
      } as never;
    }
  }

  return transform(next, scope);
}

function mapExprForClauses(
  expr: SqlExpr,
  transform: ClauseTransform,
  scope: string
): SqlExpr {
  if (isClause(expr)) {
    return mapClauseTree(expr, transform, scope);
  }
  if (Array.isArray(expr)) {
    return expr.map((e) => mapExprForClauses(e as SqlExpr, transform, scope));
  }
  return expr;
}

// ============================================================================
// Expression tree walking
// ============================================================================

export type ExprVisitor = (node: SqlExpr, path: string) => void;
export type ExprTransform = (node: SqlExpr, path: string) => SqlExpr;

/**
 * Walk every node in an expression tree (pre-order). Does NOT descend into
 * nested clause maps (subqueries) — those are handled by clause-tree walkers.
 */
export function walkExprTree(
  expr: SqlExpr,
  visitor: ExprVisitor,
  path = ""
): void {
  visitor(expr, path);
  if (Array.isArray(expr)) {
    expr.forEach((e, i) => walkExprTree(e as SqlExpr, visitor, `${path}[${i}]`));
  }
}

/**
 * Map an expression tree to a new tree. The transform is applied **bottom-up**:
 * children are mapped first, then the transform is applied to the resulting
 * node. This lets a transform wrap or replace a node without triggering
 * infinite recursion when the replacement contains a matching sub-expression
 * (e.g. `SUM(x)` → `COALESCE(SUM(x), 0)`).
 *
 * Does NOT descend into nested clause maps.
 */
export function mapExprTree(
  expr: SqlExpr,
  transform: ExprTransform,
  path = ""
): SqlExpr {
  let mapped: SqlExpr = expr;
  if (Array.isArray(expr)) {
    mapped = expr.map((e, i) =>
      mapExprTree(e as SqlExpr, transform, `${path}[${i}]`)
    );
  }
  return transform(mapped, path);
}
