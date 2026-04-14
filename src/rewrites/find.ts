/**
 * Discovery helpers — read-only walks that return hits.
 *
 * These helpers never mutate a clause tree. They are the "find" layer of the
 * parse → modify → unparse philosophy.
 */

import type { SqlClause, SqlExpr } from "../types.js";
import type { Matcher, MatchContext } from "./matchers.js";
import { identParts, identString } from "./matchers.js";
import { walkClauseTree, walkExprTree } from "./walk.js";

export interface Hit<T = SqlExpr> {
  node: T;
  scope: string;
  path: string;
}

export interface TableHit {
  table: string;
  alias: string | null;
  scope: string;
}

export interface JoinHit {
  joinType: "join" | "left-join" | "right-join" | "inner-join" | "outer-join" | "full-join" | "cross-join";
  table: SqlExpr;
  condition: SqlExpr | null;
  scope: string;
  index: number;
}

export interface SelectHit {
  node: SqlExpr;
  alias: string | null;
  scope: string;
  index: number;
}

// ============================================================================
// findPredicates — find matching nodes within WHERE and HAVING trees
// ============================================================================

/**
 * Find every expression node in any WHERE or HAVING tree matching `matcher`.
 *
 * The search descends through CTEs, UNIONs, and subqueries. Hits include
 * every level of the tree — if `matcher` matches both an outer `["and", ...]`
 * and its inner predicates, you get hits for all of them. Use `not(op("and"))`
 * etc. in the matcher to narrow.
 */
export function findPredicates(clause: SqlClause, matcher: Matcher): Hit[] {
  const hits: Hit[] = [];
  walkClauseTree(clause, (c, scope) => {
    if (c.where !== undefined) {
      collectExprHits(c.where as SqlExpr, `${scope}.where`, matcher, hits);
    }
    if (c.having !== undefined) {
      collectExprHits(c.having as SqlExpr, `${scope}.having`, matcher, hits);
    }
  });
  return hits;
}

function collectExprHits(
  expr: SqlExpr,
  scope: string,
  matcher: Matcher,
  hits: Hit[]
): void {
  walkExprTree(expr, (node, path) => {
    const ctx: MatchContext = { scope, path };
    if (matcher(node, ctx)) hits.push({ node, scope, path });
  });
}

// ============================================================================
// findSelects — find matching projection items
// ============================================================================

/**
 * Find select items matching the matcher. Handles `select`, `select-distinct`,
 * and `select-distinct-on` variants. Each hit carries an index (position in
 * the select list) and the output alias (if one can be derived).
 */
export function findSelects(clause: SqlClause, matcher: Matcher): SelectHit[] {
  const hits: SelectHit[] = [];
  walkClauseTree(clause, (c, scope) => {
    for (const key of ["select", "select-distinct"] as const) {
      const items = toItemArray(c[key] as SqlExpr | undefined);
      items?.forEach((item, i) => {
        const alias = deriveAlias(item);
        const match = Array.isArray(item) && item.length === 2 && typeof item[1] === "string"
          ? matcher(item[0] as SqlExpr, { scope, path: `${key}[${i}][0]` })
          : matcher(item, { scope, path: `${key}[${i}]` });
        if (match) {
          hits.push({ node: item, alias, scope, index: i });
        }
      });
    }
    const distinctOn = c["select-distinct-on"] as SqlExpr[] | undefined;
    if (distinctOn) {
      for (let i = 1; i < distinctOn.length; i++) {
        const item = distinctOn[i] as SqlExpr;
        const alias = deriveAlias(item);
        if (matcher(item, { scope, path: `select-distinct-on[${i}]` })) {
          hits.push({ node: item, alias, scope, index: i });
        }
      }
    }
  });
  return hits;
}

function toItemArray(select: SqlExpr | undefined): SqlExpr[] | null {
  if (select === undefined) return null;
  return Array.isArray(select) ? select : [select];
}

function deriveAlias(item: SqlExpr): string | null {
  if (Array.isArray(item) && item.length === 2 && typeof item[1] === "string" && !item[1].startsWith("%")) {
    return item[1];
  }
  const s = identString(item);
  if (s !== null) {
    const parts = s.split(".");
    return parts[parts.length - 1] ?? null;
  }
  return null;
}

// ============================================================================
// findTables — every table reference across FROM + JOINs in the whole tree
// ============================================================================

const JOIN_KEYS = [
  "join",
  "left-join",
  "right-join",
  "inner-join",
  "outer-join",
  "full-join",
  "cross-join",
] as const;

/**
 * Find every table referenced in FROM or any JOIN across the entire clause
 * tree. Returns the table name and its local alias (if one was provided).
 */
export function findTables(clause: SqlClause): TableHit[] {
  const hits: TableHit[] = [];
  walkClauseTree(clause, (c, scope) => {
    if (c.from !== undefined) {
      const items = Array.isArray(c.from) ? c.from : [c.from];
      for (const item of items) {
        const t = extractTable(item as SqlExpr);
        if (t) hits.push({ ...t, scope });
      }
    }
    for (const jk of JOIN_KEYS) {
      const joins = c[jk] as [SqlExpr, SqlExpr?][] | undefined;
      if (joins) {
        for (const join of joins) {
          const t = extractTable(join[0]);
          if (t) hits.push({ ...t, scope });
        }
      }
    }
  });
  return hits;
}

function extractTable(item: SqlExpr): { table: string; alias: string | null } | null {
  // Bare table name: "users"
  const s = identString(item);
  if (s !== null) return { table: s, alias: null };
  // [table, alias] form: ["users", "u"]
  if (Array.isArray(item) && item.length === 2) {
    const tableStr = identString(item[0]);
    const aliasStr = identString(item[1]);
    if (tableStr !== null && aliasStr !== null) {
      return { table: tableStr, alias: aliasStr };
    }
  }
  return null;
}

// ============================================================================
// findJoins
// ============================================================================

/**
 * Find JOIN entries matching the optional matcher (matches against the ON
 * condition). If no matcher is given, returns every join in the tree.
 */
export function findJoins(clause: SqlClause, matcher?: Matcher): JoinHit[] {
  const hits: JoinHit[] = [];
  walkClauseTree(clause, (c, scope) => {
    for (const jk of JOIN_KEYS) {
      const joins = c[jk] as [SqlExpr, SqlExpr?][] | undefined;
      if (!joins) continue;
      joins.forEach((join, i) => {
        const [table, condition] = join;
        const cond = condition ?? null;
        if (matcher && cond !== null && !matcher(cond, { scope, path: `${jk}[${i}][1]` })) return;
        if (matcher && cond === null) return;
        hits.push({ joinType: jk, table, condition: cond, scope, index: i });
      });
    }
  });
  return hits;
}

// ============================================================================
// findSubqueries — every nested SqlClause
// ============================================================================

/**
 * Find every nested SqlClause in the tree (CTEs, UNIONs, subqueries).
 * Excludes the root clause itself.
 */
export function findSubqueries(clause: SqlClause): Hit<SqlClause>[] {
  const hits: Hit<SqlClause>[] = [];
  let first = true;
  walkClauseTree(clause, (c, scope) => {
    if (first) {
      first = false;
      return;
    }
    hits.push({ node: c, scope, path: "" });
  });
  return hits;
}

// ============================================================================
// findFunctions — every function call of a given name
// ============================================================================

/**
 * Find function calls matching the name. Descends into WHERE, HAVING, SELECT,
 * and nested subqueries. Returns hits with scope context.
 */
export function findFunctions(clause: SqlClause, name: string): Hit[] {
  const key = name.startsWith("%") ? name : `%${name}`;
  const hits: Hit[] = [];
  walkClauseTree(clause, (c, scope) => {
    for (const clauseKey of ["select", "select-distinct", "where", "having", "group-by", "order-by"] as const) {
      const val = c[clauseKey] as SqlExpr | undefined;
      if (val === undefined) continue;
      walkExprTree(val, (node, path) => {
        if (Array.isArray(node) && node[0] === key) {
          hits.push({ node, scope: `${scope}.${clauseKey}`, path });
        }
      });
    }
  });
  return hits;
}

// ============================================================================
// findParams — every parameterized value in expressions
// ============================================================================

/**
 * Find every `{$: value}` param and `{v: value}` literal across the tree.
 * Useful for auditing what inputs flow into a clause.
 */
export function findParams(clause: SqlClause): Hit[] {
  const hits: Hit[] = [];
  walkClauseTree(clause, (c, scope) => {
    for (const clauseKey of ["select", "select-distinct", "where", "having", "group-by", "order-by", "limit", "offset"] as const) {
      const val = c[clauseKey] as SqlExpr | undefined;
      if (val === undefined) continue;
      walkExprTree(val, (node, path) => {
        if (isParamLike(node)) {
          hits.push({ node, scope: `${scope}.${clauseKey}`, path });
        }
      });
    }
  });
  return hits;
}

function isParamLike(node: SqlExpr): boolean {
  if (typeof node !== "object" || node === null) return false;
  if (Array.isArray(node)) return false;
  return "$" in node || "v" in node || "__param" in node;
}

// Re-export ident utils used in this module so consumers don't need matchers
export { identString, identParts };
