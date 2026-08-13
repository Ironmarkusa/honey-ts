/**
 * The single source of truth for where nested clauses live inside a clause
 * map. Both tree walkers (helpers.walkClauses and rewrites/walk) consume this
 * spec, so a clause key added to the emitter — a new join variant, a new
 * statement form — gets picked up by every traversal by being added HERE,
 * rather than by hunting down each walker's hand-rolled key list.
 *
 * The tenant-isolation gap that motivated this: joined subqueries
 * (`LEFT JOIN (SELECT ...) s ON ...`) live under join keys, which neither
 * walker traversed — so injectWhere() never filtered them.
 */

/** Keys holding `[name, clause][]` pairs (CTEs). */
export const CTE_KEYS = ["with", "with-recursive"] as const;

/** Keys holding `SqlClause[]` branches (set operations). */
export const SET_OP_KEYS = [
  "union", "union-all", "intersect", "except", "except-all",
] as const;

/**
 * Keys holding expressions that may contain nested clause maps (scalar
 * subqueries, IN/EXISTS subqueries, derived tables, INSERT sources, ...).
 */
export const EXPR_KEYS = [
  "from", "where", "having", "select", "select-distinct",
  "qualify", "values", "set", "returning", "order-by", "group-by",
  "cross-join",
] as const;

/**
 * Keys holding `[table, condition][]` join pairs. The table side may be a
 * subquery (`[clause, alias]` or a bare clause); the condition side is an
 * expression that may contain subqueries.
 */
export const JOIN_KEYS = [
  "join", "left-join", "right-join", "inner-join", "outer-join", "full-join",
  "asof-join", "asof-left-join", "asof-right-join", "asof-full-join",
  "asof-inner-join", "semi-join", "anti-join", "positional-join",
] as const;

/** Keys whose value may itself be a nested clause (statement targets). */
export const NESTED_CLAUSE_KEYS = ["describe", "summarize", "nest"] as const;

/**
 * Keys holding an object with a nested `source` clause (PIVOT/UNPIVOT specs).
 */
export const SOURCE_SPEC_KEYS = ["pivot", "unpivot"] as const;
