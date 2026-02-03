/**
 * HoneySQL TypeScript Port - Helper Functions
 *
 * Builder-style functions for constructing SQL clauses.
 * All helpers can take an existing DSL map as first argument
 * or start fresh.
 *
 * Port of: https://github.com/seancorfield/honeysql/blob/develop/src/honey/sql/helpers.cljc
 */

import type { SqlClause, SqlExpr, JoinClause, SetClause } from "./types.js";

// ============================================================================
// Internal Helpers
// ============================================================================

function isClauseMap(x: unknown): x is SqlClause {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function defaultMerge<T>(current: T | T[] | undefined, args: T[]): T[] {
  if (current === undefined) return args;
  if (Array.isArray(current)) return [...current, ...args];
  return [current, ...args];
}

function conjunctionMerge(
  current: SqlExpr | undefined,
  args: SqlExpr[],
  defaultConj: "and" | "or" = "and"
): SqlExpr {
  // Filter nil
  const filtered = args.filter((x) => x != null);
  if (filtered.length === 0) return current as SqlExpr;

  // Determine conjunction
  let conjunction = defaultConj;
  let exprs = filtered;

  if (filtered[0] === "and" || filtered[0] === "or") {
    conjunction = filtered[0] as "and" | "or";
    exprs = filtered.slice(1);
  }

  if (exprs.length === 0) return current as SqlExpr;

  // Build result
  if (current == null) {
    if (exprs.length === 1) return exprs[0]!;
    return [conjunction, ...exprs];
  }

  // Combine with existing
  const result: SqlExpr[] = [conjunction, current, ...exprs];

  // Simplify: flatten nested same-conjunction
  return simplifyLogic(result);
}

function simplifyLogic(expr: SqlExpr[]): SqlExpr {
  if (expr.length === 2) {
    // [and, x] or [or, x] -> x
    return expr[1]!;
  }

  const conjunction = expr[0];
  const flattened: SqlExpr[] = [conjunction as SqlExpr];

  for (let i = 1; i < expr.length; i++) {
    const item = expr[i]!;
    if (Array.isArray(item) && item[0] === conjunction) {
      // Flatten same conjunction
      flattened.push(...item.slice(1));
    } else {
      flattened.push(item);
    }
  }

  return flattened;
}

function generic<K extends keyof SqlClause>(
  k: K,
  args: unknown[]
): SqlClause {
  if (isClauseMap(args[0])) {
    const [data, ...rest] = args as [SqlClause, ...unknown[]];
    return {
      ...data,
      [k]: defaultMerge(data[k] as unknown[], rest as unknown[]),
    };
  }
  return { [k]: args } as SqlClause;
}

function genericSingle<K extends keyof SqlClause>(
  k: K,
  args: unknown[]
): SqlClause {
  if (isClauseMap(args[0])) {
    const [data, value] = args as [SqlClause, unknown];
    return { ...data, [k]: value };
  }
  return { [k]: args[0] } as SqlClause;
}

// ============================================================================
// SELECT
// ============================================================================

/**
 * Add SELECT clause.
 *
 * @example
 * ```ts
 * select("*")
 * select("id", "name")
 * select(["count(*)", "total"])  // with alias
 * ```
 */
export function select(...args: unknown[]): SqlClause {
  return generic("select", args);
}

/**
 * Add SELECT DISTINCT clause.
 */
export function selectDistinct(...args: unknown[]): SqlClause {
  return generic("select-distinct", args);
}

/**
 * Add SELECT DISTINCT ON clause (PostgreSQL).
 */
export function selectDistinctOn(...args: unknown[]): SqlClause {
  if (isClauseMap(args[0])) {
    const [data, onCols, ...cols] = args as [SqlClause, SqlExpr[], ...SqlExpr[]];
    return {
      ...data,
      "select-distinct-on": [onCols, ...cols],
    };
  }
  const [onCols, ...cols] = args as [SqlExpr[], ...SqlExpr[]];
  return { "select-distinct-on": [onCols, ...cols] };
}

// ============================================================================
// FROM
// ============================================================================

/**
 * Add FROM clause.
 *
 * @example
 * ```ts
 * from("users")
 * from(["users", "u"])  // with alias
 * ```
 */
export function from(...args: unknown[]): SqlClause {
  return generic("from", args);
}

// ============================================================================
// WHERE / HAVING
// ============================================================================

/**
 * Add WHERE clause. Multiple calls are combined with AND.
 *
 * @example
 * ```ts
 * where(["=", "id", 1])
 * where(["and", ["=", "status", "active"], [">", "age", 18]])
 * ```
 */
export function where(...args: unknown[]): SqlClause {
  if (isClauseMap(args[0])) {
    const [data, ...rest] = args as [SqlClause, ...SqlExpr[]];
    return {
      ...data,
      where: conjunctionMerge(data.where, rest),
    };
  }
  return { where: conjunctionMerge(undefined, args as SqlExpr[]) };
}

/**
 * Add HAVING clause. Multiple calls are combined with AND.
 */
export function having(...args: unknown[]): SqlClause {
  if (isClauseMap(args[0])) {
    const [data, ...rest] = args as [SqlClause, ...SqlExpr[]];
    return {
      ...data,
      having: conjunctionMerge(data.having, rest),
    };
  }
  return { having: conjunctionMerge(undefined, args as SqlExpr[]) };
}

// ============================================================================
// JOIN
// ============================================================================

/**
 * Add INNER JOIN clause.
 *
 * @example
 * ```ts
 * join([["orders", "o"], ["=", "users.id", "o.user_id"]])
 * ```
 */
export function join(...args: unknown[]): SqlClause {
  return generic("join", args);
}

/**
 * Add LEFT JOIN clause.
 */
export function leftJoin(...args: unknown[]): SqlClause {
  return generic("left-join", args);
}

/**
 * Add RIGHT JOIN clause.
 */
export function rightJoin(...args: unknown[]): SqlClause {
  return generic("right-join", args);
}

/**
 * Add INNER JOIN clause (alias for join).
 */
export function innerJoin(...args: unknown[]): SqlClause {
  return generic("inner-join", args);
}

/**
 * Add OUTER JOIN clause.
 */
export function outerJoin(...args: unknown[]): SqlClause {
  return generic("outer-join", args);
}

/**
 * Add FULL JOIN clause.
 */
export function fullJoin(...args: unknown[]): SqlClause {
  return generic("full-join", args);
}

/**
 * Add CROSS JOIN clause.
 */
export function crossJoin(...args: unknown[]): SqlClause {
  return generic("cross-join", args);
}

// ============================================================================
// GROUP BY / ORDER BY
// ============================================================================

/**
 * Add GROUP BY clause.
 *
 * @example
 * ```ts
 * groupBy("status")
 * groupBy("country", "city")
 * ```
 */
export function groupBy(...args: unknown[]): SqlClause {
  return generic("group-by", args);
}

/**
 * Add ORDER BY clause.
 *
 * @example
 * ```ts
 * orderBy("created_at")
 * orderBy(["created_at", "desc"])
 * orderBy(["name", "asc"], ["created_at", "desc"])
 * ```
 */
export function orderBy(...args: unknown[]): SqlClause {
  return generic("order-by", args);
}

// ============================================================================
// LIMIT / OFFSET
// ============================================================================

/**
 * Add LIMIT clause.
 */
export function limit(...args: unknown[]): SqlClause {
  return genericSingle("limit", args);
}

/**
 * Add OFFSET clause.
 */
export function offset(...args: unknown[]): SqlClause {
  return genericSingle("offset", args);
}

// ============================================================================
// INSERT
// ============================================================================

/**
 * Add INSERT INTO clause.
 *
 * @example
 * ```ts
 * insertInto("users")
 * insertInto(["users", ["id", "name"]])  // with columns
 * ```
 */
export function insertInto(...args: unknown[]): SqlClause {
  return genericSingle("insert-into", args);
}

/**
 * Add REPLACE INTO clause (MySQL).
 */
export function replaceInto(...args: unknown[]): SqlClause {
  return genericSingle("replace-into", args);
}

/**
 * Add VALUES clause.
 *
 * @example
 * ```ts
 * values([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }])
 * values([[1, "Alice"], [2, "Bob"]])
 * ```
 */
export function values(...args: unknown[]): SqlClause {
  return genericSingle("values", args);
}

/**
 * Add COLUMNS clause (explicit column list for INSERT).
 */
export function columns(...args: unknown[]): SqlClause {
  return generic("columns", args);
}

// ============================================================================
// UPDATE
// ============================================================================

/**
 * Add UPDATE clause.
 *
 * @example
 * ```ts
 * update("users")
 * ```
 */
export function update(...args: unknown[]): SqlClause {
  return genericSingle("update", args);
}

/**
 * Add SET clause for UPDATE.
 *
 * @example
 * ```ts
 * set({ name: "New Name", updated_at: ["now"] })
 * ```
 */
export function set(...args: unknown[]): SqlClause {
  if (isClauseMap(args[0]) && isClauseMap(args[1])) {
    const [data, setMap] = args as [SqlClause, SetClause];
    return {
      ...data,
      set: { ...(data.set as SetClause ?? {}), ...setMap },
    };
  }
  if (isClauseMap(args[0])) {
    throw new Error("set() requires a map of column -> value");
  }
  return { set: args[0] as SetClause };
}

// ============================================================================
// DELETE
// ============================================================================

/**
 * Add DELETE clause.
 *
 * @example
 * ```ts
 * delete_("users")  // Note: underscore to avoid JS reserved word
 * ```
 */
export function delete_(...args: unknown[]): SqlClause {
  return generic("delete", args);
}

/**
 * Add DELETE FROM clause.
 */
export function deleteFrom(...args: unknown[]): SqlClause {
  return genericSingle("delete-from", args);
}

/**
 * Add TRUNCATE clause.
 */
export function truncate(...args: unknown[]): SqlClause {
  return genericSingle("truncate", args);
}

// ============================================================================
// WITH (CTE)
// ============================================================================

/**
 * Add WITH clause (Common Table Expression).
 *
 * @example
 * ```ts
 * with_(["active_users", { select: ["*"], from: "users", where: ["=", "active", true] }])
 * ```
 */
export function with_(...args: unknown[]): SqlClause {
  return generic("with", args);
}

/**
 * Add WITH RECURSIVE clause.
 */
export function withRecursive(...args: unknown[]): SqlClause {
  return generic("with-recursive", args);
}

// ============================================================================
// Set Operations
// ============================================================================

/**
 * Add UNION clause.
 */
export function union(...args: unknown[]): SqlClause {
  return generic("union", args);
}

/**
 * Add UNION ALL clause.
 */
export function unionAll(...args: unknown[]): SqlClause {
  return generic("union-all", args);
}

/**
 * Add INTERSECT clause.
 */
export function intersect(...args: unknown[]): SqlClause {
  return generic("intersect", args);
}

/**
 * Add EXCEPT clause.
 */
export function except(...args: unknown[]): SqlClause {
  return generic("except", args);
}

// ============================================================================
// ON CONFLICT (PostgreSQL/SQLite UPSERT)
// ============================================================================

/**
 * Add ON CONFLICT clause.
 *
 * @example
 * ```ts
 * onConflict("id")
 * onConflict(["id", "email"])
 * ```
 */
export function onConflict(...args: unknown[]): SqlClause {
  return generic("on-conflict", args);
}

/**
 * Add ON CONSTRAINT clause.
 */
export function onConstraint(...args: unknown[]): SqlClause {
  return genericSingle("on-constraint", args);
}

/**
 * Add DO NOTHING clause.
 */
export function doNothing(...args: unknown[]): SqlClause {
  if (isClauseMap(args[0])) {
    return { ...args[0], "do-nothing": true };
  }
  return { "do-nothing": true };
}

/**
 * Add DO UPDATE SET clause.
 *
 * @example
 * ```ts
 * doUpdateSet({ name: "excluded.name" })
 * doUpdateSet({ fields: ["name", "email"] })
 * doUpdateSet({ fields: ["name"], where: ["=", "status", "active"] })
 * ```
 */
export function doUpdateSet(...args: unknown[]): SqlClause {
  return genericSingle("do-update-set", args);
}

// ============================================================================
// RETURNING
// ============================================================================

/**
 * Add RETURNING clause.
 *
 * @example
 * ```ts
 * returning("*")
 * returning("id", "created_at")
 * ```
 */
export function returning(...args: unknown[]): SqlClause {
  return generic("returning", args);
}

// ============================================================================
// Locking
// ============================================================================

/**
 * Add FOR clause (row locking).
 *
 * @example
 * ```ts
 * for_("update")
 * for_("update", "nowait")
 * for_(["update", ["users"], "skip-locked"])
 * ```
 */
export function for_(...args: unknown[]): SqlClause {
  return generic("for", args);
}

/**
 * Add LOCK clause (alias for for_).
 */
export function lock(...args: unknown[]): SqlClause {
  return generic("lock", args);
}

// ============================================================================
// Window Functions
// ============================================================================

/**
 * Add WINDOW clause.
 */
export function window(...args: unknown[]): SqlClause {
  return generic("window", args);
}

/**
 * Add PARTITION BY clause.
 */
export function partitionBy(...args: unknown[]): SqlClause {
  return generic("partition-by", args);
}

// ============================================================================
// DDL Helpers
// ============================================================================

/**
 * Add CREATE TABLE clause.
 *
 * @example
 * ```ts
 * createTable("users")
 * createTable(["users", "if-not-exists"])
 * ```
 */
export function createTable(...args: unknown[]): SqlClause {
  return genericSingle("create-table", args);
}

/**
 * Add WITH COLUMNS clause for CREATE TABLE.
 *
 * @example
 * ```ts
 * withColumns(
 *   ["id", "serial", "primary-key"],
 *   ["name", "varchar(255)", "not-null"],
 *   ["created_at", "timestamp", "default", ["now"]]
 * )
 * ```
 */
export function withColumns(...args: unknown[]): SqlClause {
  return generic("with-columns", args);
}

/**
 * Add DROP TABLE clause.
 */
export function dropTable(...args: unknown[]): SqlClause {
  return generic("drop-table", args);
}

/**
 * Add ALTER TABLE clause.
 */
export function alterTable(...args: unknown[]): SqlClause {
  return generic("alter-table", args);
}

/**
 * Add ADD COLUMN clause.
 */
export function addColumn(...args: unknown[]): SqlClause {
  return generic("add-column", args);
}

/**
 * Add DROP COLUMN clause.
 */
export function dropColumn(...args: unknown[]): SqlClause {
  return generic("drop-column", args);
}

// ============================================================================
// Utility: Compose Queries
// ============================================================================

/**
 * Merge multiple clause maps into one.
 *
 * @example
 * ```ts
 * merge(
 *   select("*"),
 *   from("users"),
 *   where(["=", "active", true])
 * )
 * ```
 */
export function merge(...clauses: SqlClause[]): SqlClause {
  return clauses.reduce((acc, clause) => {
    for (const [k, v] of Object.entries(clause)) {
      if (k === "where" || k === "having") {
        acc[k] = conjunctionMerge(acc[k], [v as SqlExpr]);
      } else if (Array.isArray(v) && Array.isArray(acc[k])) {
        (acc[k] as unknown[]) = [...(acc[k] as unknown[]), ...v];
      } else {
        acc[k] = v;
      }
    }
    return acc;
  }, {} as SqlClause);
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
 *     return merge(c, where(["=", "tenant_id", {$: tenantId}]));
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
      return merge(c, where(condition));
    }
    return c;
  });
}

// ============================================================================
// Select Manipulation
// ============================================================================

/**
 * Get the alias/name of a select item.
 * - Bare column "email" -> "email"
 * - Aliased ["email", "email_hash"] -> "email_hash"
 * - Expression with alias [["%count", "*"], "total"] -> "total"
 */
function getSelectAlias(item: SqlExpr): string | null {
  // Bare column string
  if (typeof item === "string") {
    // Handle qualified names like "u.email" -> "email"
    const parts = item.split(".");
    return parts[parts.length - 1] ?? null;
  }

  // Array form: could be [expr, alias] or just an expression
  if (Array.isArray(item) && item.length === 2) {
    const second = item[1];
    // If second element is a string identifier (not starting with %), it's an alias
    if (typeof second === "string" && !second.startsWith("%")) {
      return second;
    }
  }

  return null;
}

/**
 * Override select items by alias/column name.
 *
 * Matches select items by their alias (or column name for bare columns)
 * and replaces the expression while preserving the alias.
 *
 * @example
 * ```ts
 * // LLM generates: SELECT email AS email_hash FROM users
 * const clause = fromSql("SELECT email AS email_hash FROM users");
 *
 * // Override with your computation
 * const fixed = overrideSelects(clause, {
 *   email_hash: ["%sha256", ["%lower", ["%trim", "email"]]]
 * });
 *
 * // Result: SELECT SHA256(LOWER(TRIM(email))) AS email_hash FROM users
 * ```
 *
 * @example
 * ```ts
 * // Also works for bare columns
 * const clause = { select: ["id", "email"], from: "users" };
 * const fixed = overrideSelects(clause, {
 *   email: ["%sha256", "email"]  // Replaces bare "email" with expression
 * });
 * // Result: SELECT id, SHA256(email) AS email FROM users
 * ```
 */
export function overrideSelects(
  clause: SqlClause,
  overrides: Record<string, SqlExpr>
): SqlClause {
  const result = { ...clause };

  // Handle all select variants
  for (const key of ["select", "select-distinct", "select-distinct-on"] as const) {
    const selectValue = result[key];
    if (!selectValue) continue;

    if (key === "select-distinct-on") {
      // Format: [onExprs, ...selectExprs]
      const arr = selectValue as SqlExpr[];
      const onExprs = arr[0];
      const selectExprs = arr.slice(1);
      const transformed = transformSelectItems(selectExprs, overrides);
      result[key] = [onExprs, ...transformed];
    } else {
      // Regular select or select-distinct
      const items = Array.isArray(selectValue) ? selectValue : [selectValue];
      result[key] = transformSelectItems(items as SqlExpr[], overrides);
    }
  }

  return result;
}

/**
 * Transform select items, applying overrides by alias.
 */
function transformSelectItems(
  items: SqlExpr[],
  overrides: Record<string, SqlExpr>
): SqlExpr[] {
  return items.map((item) => {
    const alias = getSelectAlias(item);

    if (alias && alias in overrides) {
      const newExpr = overrides[alias];
      // Return [newExpr, alias] to preserve the alias
      return [newExpr, alias] as SqlExpr;
    }

    return item;
  });
}
