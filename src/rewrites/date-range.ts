/**
 * Date-range helpers — the flagship use case.
 *
 * `describeDatePredicates` finds every date-range-shaped predicate in a clause
 * (read-only). `rewriteDateRange` swaps them for a new range. This is the
 * primitive that powers interactive "change the date filter" on saved reports.
 */

import type { SqlClause, SqlExpr } from "../types.js";
import { identString } from "./matchers.js";
import { dateRange } from "./matchers.js";
import { walkClauseTree, mapClauseTree } from "./walk.js";

export type RangeStrategy = "half-open" | "between" | "inclusive";

export interface DatePredicate {
  /** Column identifier used in the predicate (may be qualified). */
  column: string;
  /** Scope where the predicate lives ("root", "cte:name.where", etc.) */
  scope: string;
  /** Shape of the predicate. */
  source: "between" | "range";
  /** Lower bound expression (if any). */
  from?: SqlExpr;
  /** Upper bound expression (if any). */
  to?: SqlExpr;
  /** Inclusivity of the lower bound. */
  fromInclusive?: boolean;
  /** Inclusivity of the upper bound. */
  toInclusive?: boolean;
}

// ============================================================================
// describeDatePredicates
// ============================================================================

/**
 * Enumerate every date-range-shaped predicate across the clause tree.
 * Pairs of `>=` / `<` on the same column inside a top-level AND are grouped
 * into a single `{source: "range"}` entry. Standalone `BETWEEN` and `=`
 * predicates become their own entries.
 */
export function describeDatePredicates(clause: SqlClause): DatePredicate[] {
  const out: DatePredicate[] = [];
  walkClauseTree(clause, (c, scope) => {
    if (c.where === undefined) return;
    const conjuncts = flattenAnd(c.where as SqlExpr);
    const dateHits = conjuncts.filter((n) => dateRange()(n));
    const byColumn = new Map<string, SqlExpr[]>();
    for (const hit of dateHits) {
      const colName = identString((hit as SqlExpr[])[1]);
      if (colName === null) continue;
      if (!byColumn.has(colName)) byColumn.set(colName, []);
      byColumn.get(colName)!.push(hit);
    }
    for (const [column, preds] of byColumn) {
      const between = preds.find((p) => (p as SqlExpr[])[0] === "between");
      if (between) {
        const b = between as SqlExpr[];
        out.push({
          column,
          scope: `${scope}.where`,
          source: "between",
          from: b[2] as SqlExpr,
          to: b[3] as SqlExpr,
          fromInclusive: true,
          toInclusive: true,
        });
        continue;
      }
      // Range: collect lower and upper bounds
      const lowers = preds.filter((p) => {
        const o = (p as SqlExpr[])[0];
        return o === ">=" || o === ">";
      });
      const uppers = preds.filter((p) => {
        const o = (p as SqlExpr[])[0];
        return o === "<=" || o === "<";
      });
      if (lowers.length > 0 || uppers.length > 0) {
        const low = lowers[0] as SqlExpr[] | undefined;
        const high = uppers[0] as SqlExpr[] | undefined;
        const entry: DatePredicate = {
          column,
          scope: `${scope}.where`,
          source: "range",
        };
        if (low) {
          entry.from = low[2] as SqlExpr;
          entry.fromInclusive = low[0] === ">=";
        }
        if (high) {
          entry.to = high[2] as SqlExpr;
          entry.toInclusive = high[0] === "<=";
        }
        out.push(entry);
      }
    }
  });
  return out;
}

function flattenAnd(expr: SqlExpr): SqlExpr[] {
  if (Array.isArray(expr) && expr[0] === "and") {
    const result: SqlExpr[] = [];
    for (let i = 1; i < expr.length; i++) {
      result.push(...flattenAnd(expr[i] as SqlExpr));
    }
    return result;
  }
  return [expr];
}

// ============================================================================
// rewriteDateRange
// ============================================================================

export interface RewriteDateRangeSpec {
  /**
   * Column to rewrite. If omitted, auto-detects the single date column
   * present; throws if there are multiple.
   */
  column?: string;
  /** New lower bound (inclusive). Date objects are ISO-formatted. */
  from: Date | string;
  /** New upper bound (exclusive by default per half-open strategy). */
  to: Date | string;
  /** Predicate shape to emit. Defaults to "half-open" (`>= from AND < to`). */
  strategy?: RangeStrategy;
}

/**
 * Swap every date-range predicate on a column for a fresh range.
 *
 * Existing predicates of any shape (BETWEEN, paired >=/<, single =, etc.)
 * are removed; a single new predicate in the requested `strategy` shape is
 * ANDed into the WHERE at the same scope.
 *
 * @example
 * ```ts
 * rewriteDateRange(clause, {
 *   column: "date_day",
 *   from: "2024-10-01",
 *   to: "2024-11-01",
 * });
 * ```
 */
export function rewriteDateRange(
  clause: SqlClause,
  spec: RewriteDateRangeSpec
): SqlClause {
  const column = spec.column ?? inferSingleColumn(clause);
  const m = dateRange(column);
  const newPred = buildRangePredicate(column, spec);

  return mapClauseTree(clause, (c) => {
    if (c.where === undefined) return c;
    // Only rewrite top-level conjuncts. Predicates nested in OR, NOT, function
    // args, or subquery-only positions are intentionally left alone: removing
    // or adding would change semantics unpredictably.
    if (!hasTopLevelMatch(c.where as SqlExpr, m)) return c;
    const pruned = pruneTopLevel(c.where as SqlExpr, m);
    if (pruned === REMOVED) return { ...c, where: newPred };
    return { ...c, where: ["and", pruned, newPred] as SqlExpr };
  });
}

function inferSingleColumn(clause: SqlClause): string {
  const preds = describeDatePredicates(clause);
  const cols = new Set(preds.map((p) => p.column));
  if (cols.size === 0) {
    throw new Error(
      "rewriteDateRange: no date-range predicates found and no column given"
    );
  }
  if (cols.size > 1) {
    throw new Error(
      `rewriteDateRange: multiple date columns present (${[...cols].join(", ")}); pass {column}`
    );
  }
  return [...cols][0]!;
}

function buildRangePredicate(column: string, spec: RewriteDateRangeSpec): SqlExpr {
  const from = toLit(spec.from);
  const to = toLit(spec.to);
  const strat = spec.strategy ?? "half-open";
  if (strat === "between") {
    return ["between", column, from, to] as SqlExpr;
  }
  if (strat === "inclusive") {
    return ["and", [">=", column, from], ["<=", column, to]] as SqlExpr;
  }
  // half-open: >= from AND < to
  return ["and", [">=", column, from], ["<", column, to]] as SqlExpr;
}

function toLit(v: Date | string): SqlExpr {
  if (v instanceof Date) return { $: v.toISOString().slice(0, 10) };
  return { $: v };
}

// ============================================================================
// Internals for pruning
// ============================================================================

const REMOVED = Symbol("removed");
type PruneResult = SqlExpr | typeof REMOVED;

type NodeMatcher = (n: SqlExpr) => boolean;

/** Flatten an expression into its top-level AND conjuncts (does not descend into OR/NOT/etc). */
function topLevelConjuncts(expr: SqlExpr): SqlExpr[] {
  if (Array.isArray(expr) && expr[0] === "and") {
    const out: SqlExpr[] = [];
    for (let i = 1; i < expr.length; i++) {
      out.push(...topLevelConjuncts(expr[i] as SqlExpr));
    }
    return out;
  }
  return [expr];
}

function hasTopLevelMatch(expr: SqlExpr, m: NodeMatcher): boolean {
  return topLevelConjuncts(expr).some((c) => m(c));
}

/**
 * Prune matching predicates from the top-level AND only. OR-wrapped
 * predicates are treated as atomic: the whole OR is kept unless the OR
 * itself matches (it won't, for our matchers).
 */
function pruneTopLevel(expr: SqlExpr, m: NodeMatcher): PruneResult {
  if (Array.isArray(expr) && expr[0] === "and") {
    const kept: SqlExpr[] = [];
    for (let i = 1; i < expr.length; i++) {
      const child = pruneTopLevel(expr[i] as SqlExpr, m);
      if (child !== REMOVED) kept.push(child);
    }
    if (kept.length === 0) return REMOVED;
    if (kept.length === 1) return kept[0]!;
    return ["and", ...kept] as SqlExpr;
  }
  return m(expr) ? REMOVED : expr;
}
