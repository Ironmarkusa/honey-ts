/**
 * HoneySQL TypeScript - Query Manipulation Helpers
 *
 * Functions for transforming and manipulating clause maps.
 */

import type { SqlClause, SqlExpr } from "./types.js";

// ============================================================================
// Internal Helpers
// ============================================================================

function isClauseMap(x: unknown): x is SqlClause {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ============================================================================
// Clause Tree Walker
// ============================================================================

/**
 * Recursively walk all clause nodes in a query tree, applying a transform.
 * Handles CTEs, UNIONs, subqueries in FROM/WHERE/SELECT.
 *
 * @example
 * ```ts
 * // Inject tenant filter into ALL subqueries
 * const secured = walkClauses(clause, (c) => {
 *   if (c.from) {
 *     return { ...c, where: addCondition(c.where, ["=", "tenant_id", {$: tenantId}]) };
 *   }
 *   return c;
 * });
 * ```
 */
export function walkClauses(
  clause: SqlClause,
  transform: (c: SqlClause) => SqlClause
): SqlClause {
  const processed: SqlClause = { ...clause };

  // WITH / WITH RECURSIVE - each CTE is a clause
  for (const key of ["with", "with-recursive"] as const) {
    if (processed[key]) {
      processed[key] = (processed[key] as [string, SqlClause][]).map(
        ([name, cte]) => [name, walkClauses(cte, transform)]
      );
    }
  }

  // UNION / INTERSECT / EXCEPT - array of clauses
  for (const key of ["union", "union-all", "intersect", "except", "except-all"] as const) {
    if (processed[key]) {
      processed[key] = (processed[key] as SqlClause[]).map(
        (c) => walkClauses(c, transform)
      );
    }
  }

  // FROM - may contain subqueries
  if (processed.from) {
    processed.from = walkExprForClauses(processed.from as SqlExpr, transform);
  }

  // WHERE - may contain subqueries (IN, EXISTS, scalar)
  if (processed.where) {
    processed.where = walkExprForClauses(processed.where as SqlExpr, transform);
  }

  // SELECT - may contain scalar subqueries
  if (processed.select) {
    processed.select = walkExprForClauses(processed.select as SqlExpr, transform);
  }

  // HAVING - may contain subqueries
  if (processed.having) {
    processed.having = walkExprForClauses(processed.having as SqlExpr, transform);
  }

  // Apply transform to this clause
  return transform(processed);
}

/** Walk an expression tree, transforming any nested clause maps */
function walkExprForClauses(
  expr: SqlExpr,
  transform: (c: SqlClause) => SqlClause
): SqlExpr {
  if (isClauseMap(expr)) {
    return walkClauses(expr, transform);
  }
  if (Array.isArray(expr)) {
    return expr.map((e) => walkExprForClauses(e as SqlExpr, transform));
  }
  return expr;
}

/**
 * Inject a WHERE condition into all SELECT queries in the tree.
 * Convenience wrapper around walkClauses for tenant isolation.
 *
 * @example
 * ```ts
 * const secured = injectWhere(clause, ["=", "tenant_id", {$: tenantId}]);
 * ```
 */
export function injectWhere(clause: SqlClause, condition: SqlExpr): SqlClause {
  return walkClauses(clause, (c) => {
    // Only inject into clauses that query from tables
    if (c.from || c["delete-from"] || c.update) {
      const existing = c.where;
      if (existing) {
        c = { ...c, where: ["and", existing, condition] };
      } else {
        c = { ...c, where: condition };
      }
    }
    return c;
  });
}

// ============================================================================
// Select Manipulation
// ============================================================================

/**
 * Extract alias → table name mapping from FROM and JOIN clauses.
 */
function extractTableAliases(clause: SqlClause): Map<string, string> {
  const aliases = new Map<string, string>();

  // Process FROM clause
  if (clause.from) {
    const fromItems = Array.isArray(clause.from) ? clause.from : [clause.from];
    for (const item of fromItems) {
      extractTableAlias(item as SqlExpr, aliases);
    }
  }

  // Process all JOIN types
  for (const joinType of ["join", "left-join", "right-join", "inner-join", "outer-join", "full-join"] as const) {
    const joins = clause[joinType] as [SqlExpr, SqlExpr][] | undefined;
    if (joins) {
      for (const [tableExpr] of joins) {
        extractTableAlias(tableExpr, aliases);
      }
    }
  }

  return aliases;
}

/**
 * Extract table alias from a single FROM/JOIN item.
 */
function extractTableAlias(item: SqlExpr, aliases: Map<string, string>): void {
  // Bare table name: "users" -> users is both name and implicit alias
  if (typeof item === "string") {
    aliases.set(item, item);
    return;
  }

  // [table, alias] form: ["users", "u"] -> u maps to users
  if (Array.isArray(item) && item.length === 2) {
    const [first, second] = item;

    // Could be [tableName, alias] or [subquery, alias]
    if (typeof first === "string" && typeof second === "string") {
      // ["users", "u"] -> alias "u" maps to table "users"
      aliases.set(second, first);
      aliases.set(first, first); // also map table to itself
      return;
    }

    // [subquery, alias] - alias maps to itself (can't resolve further)
    if (typeof second === "string") {
      aliases.set(second, second);
      return;
    }
  }
}

/**
 * Get the canonical table.column form for a select item.
 * Resolves aliases to actual table names using the alias map.
 *
 * Returns: [resolvedName, outputAlias] or null
 * - "u.email" with alias u->users -> ["users.email", "email"]
 * - "email" -> ["email", "email"]
 * - ["u.email", "email_hash"] -> ["users.email", "email_hash"]
 */
function resolveSelectItem(
  item: SqlExpr,
  aliasMap: Map<string, string>
): { resolved: string; outputAlias: string } | null {
  // Bare column string
  if (typeof item === "string") {
    if (item.includes(".")) {
      // Qualified: "u.email"
      const dotIdx = item.indexOf(".");
      const tableAlias = item.substring(0, dotIdx);
      const column = item.substring(dotIdx + 1);
      const tableName = aliasMap.get(tableAlias) ?? tableAlias;
      return {
        resolved: `${tableName}.${column}`,
        outputAlias: column,
      };
    }
    // Unqualified: "email"
    return { resolved: item, outputAlias: item };
  }

  // Array form: could be [expr, alias] or just an expression
  if (Array.isArray(item) && item.length === 2) {
    const [first, second] = item;
    // If second element is a string identifier (not starting with %), it's an alias
    if (typeof second === "string" && !second.startsWith("%")) {
      // Recurse on the expression part to resolve it
      if (typeof first === "string") {
        const innerResolved = resolveSelectItem(first, aliasMap);
        if (innerResolved) {
          return {
            resolved: innerResolved.resolved,
            outputAlias: second, // explicit alias overrides
          };
        }
      }
      // Expression with alias but can't resolve the expression
      return { resolved: second, outputAlias: second };
    }
  }

  return null;
}

/**
 * Override select items by table.column or alias.
 *
 * Resolves table aliases to actual table names, so you can specify overrides
 * using the real table name regardless of what alias the query uses.
 *
 * @example
 * ```ts
 * // LLM generates with alias: SELECT u.email FROM users u
 * const clause = fromSql("SELECT u.email FROM users u");
 *
 * // Override using actual table name (not the alias)
 * const fixed = overrideSelects(clause, {
 *   "users.email": raw("SHA256(LOWER(TRIM(u.email)))")
 * });
 *
 * // Result: SELECT SHA256(LOWER(TRIM(u.email))) AS email FROM users u
 * ```
 *
 * @example
 * ```ts
 * // Also matches by output alias
 * const clause = fromSql("SELECT email AS email_hash FROM users");
 * const fixed = overrideSelects(clause, {
 *   email_hash: ["%sha256", "email"]
 * });
 * ```
 *
 * Matching priority:
 * 1. Resolved table.column (e.g., "users.email" matches "u.email" when u->users)
 * 2. Unqualified column name (e.g., "email")
 * 3. Explicit alias (e.g., "email_hash")
 */
export function overrideSelects(
  clause: SqlClause,
  overrides: Record<string, SqlExpr>
): SqlClause {
  const result = { ...clause };
  const aliasMap = extractTableAliases(clause);

  // Handle all select variants
  for (const key of ["select", "select-distinct", "select-distinct-on"] as const) {
    const selectValue = result[key];
    if (!selectValue) continue;

    if (key === "select-distinct-on") {
      // Format: [onExprs, ...selectExprs]
      const arr = selectValue as SqlExpr[];
      const onExprs = arr[0];
      const selectExprs = arr.slice(1);
      const transformed = transformSelectItems(selectExprs, overrides, aliasMap);
      (result as Record<string, unknown>)[key] = [onExprs, ...transformed];
    } else {
      // Regular select or select-distinct
      const items = Array.isArray(selectValue) ? selectValue : [selectValue];
      result[key] = transformSelectItems(items as SqlExpr[], overrides, aliasMap);
    }
  }

  return result;
}

/**
 * Transform select items, applying overrides.
 * Uses alias map to resolve table aliases to actual table names.
 */
function transformSelectItems(
  items: SqlExpr[],
  overrides: Record<string, SqlExpr>,
  aliasMap: Map<string, string>
): SqlExpr[] {
  return items.map((item) => {
    const resolved = resolveSelectItem(item, aliasMap);
    if (!resolved) return item;

    const { resolved: resolvedName, outputAlias } = resolved;

    // Try matches in priority order:
    // 1. Exact resolved name (e.g., "users.email")
    // 2. Just the column part (e.g., "email")
    // 3. The output alias if different (e.g., "email_hash")
    const candidates = [resolvedName];

    // Add unqualified column if it's a qualified name
    if (resolvedName.includes(".")) {
      const column = resolvedName.substring(resolvedName.indexOf(".") + 1);
      if (!candidates.includes(column)) candidates.push(column);
    }

    // Add output alias if different
    if (!candidates.includes(outputAlias)) {
      candidates.push(outputAlias);
    }

    for (const candidate of candidates) {
      if (candidate in overrides) {
        const newExpr = overrides[candidate];
        return [newExpr, outputAlias] as SqlExpr;
      }
    }

    return item;
  });
}
