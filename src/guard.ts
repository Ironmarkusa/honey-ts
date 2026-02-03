/**
 * HoneySQL TypeScript - SQL Guard
 *
 * Allow-list based SQL validation for LLM-generated queries.
 * Checks operations, tables, WHERE clauses, and limits.
 */

import type { SqlClause, SqlExpr } from "./types.js";
import { walkClauses } from "./helpers.js";

export type SqlOperation = "select" | "insert" | "update" | "delete";

export interface GuardConfig {
  /** Tables allowed to query (supports "schema.*" wildcards) */
  allowedTables: string[];
  /** Operations allowed (select, insert, update, delete) */
  allowedOperations: SqlOperation[];
  /** Require LIMIT clause on SELECT */
  requireLimit?: boolean;
  /** Max rows for SELECT (only checked if LIMIT present) */
  maxRows?: number;
  /** Operations that require a WHERE clause */
  requireWhere?: SqlOperation[];
}

export interface GuardResult {
  ok: boolean;
  violations: string[];
}

/**
 * Validate a SQL clause against an allow-list config.
 *
 * @example
 * ```ts
 * const result = guardSql(clause, {
 *   allowedTables: ["users", "orders", "staging.*"],
 *   allowedOperations: ["select"],
 *   maxRows: 1000,
 * });
 *
 * if (!result.ok) {
 *   throw new Error(result.violations.join(", "));
 * }
 * ```
 */
export function guardSql(clause: SqlClause, config: GuardConfig): GuardResult {
  const violations: string[] = [];

  // Pre-compile table patterns for efficiency
  const exactTables = new Set<string>();
  const schemaPatterns: string[] = [];
  for (const pattern of config.allowedTables) {
    if (pattern.endsWith(".*")) {
      schemaPatterns.push(pattern.slice(0, -2));
    } else {
      exactTables.add(pattern);
    }
  }

  const isTableAllowed = (table: string): boolean => {
    if (exactTables.has(table)) return true;
    const schema = table.split(".")[0];
    return schemaPatterns.includes(schema!);
  };

  const allowedOps = new Set(config.allowedOperations);
  const requireWhereOps = new Set(config.requireWhere ?? []);

  // Check operation type
  const op = getOperation(clause);
  if (op && !allowedOps.has(op)) {
    violations.push(`Operation not allowed: ${op.toUpperCase()}`);
  }

  // Check for missing WHERE on dangerous ops
  if (requireWhereOps.has("delete") && clause["delete-from"] && !clause.where) {
    violations.push("DELETE requires WHERE clause");
  }
  if (requireWhereOps.has("update") && clause.update && !clause.where) {
    violations.push("UPDATE requires WHERE clause");
  }

  // Check for tautological WHERE
  if (clause.where && isTautology(clause.where)) {
    violations.push("WHERE clause is always true (tautology)");
  }

  // Check LIMIT requirements for SELECT
  if (op === "select") {
    const limitViolation = checkLimit(clause, config.requireLimit, config.maxRows);
    if (limitViolation) violations.push(limitViolation);
  }

  // Collect and check all tables (including subqueries)
  const tables = collectTables(clause);
  for (const table of tables) {
    if (!isTableAllowed(table)) {
      violations.push(`Table not allowed: ${table}`);
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Get the primary operation type of a clause.
 */
export function getOperation(clause: SqlClause): SqlOperation | null {
  if (clause.select || clause["select-distinct"] || clause["select-distinct-on"]) {
    return "select";
  }
  if (clause["insert-into"]) return "insert";
  if (clause.update) return "update";
  if (clause["delete-from"]) return "delete";
  if (clause.union || clause["union-all"]) return "select";
  if (clause.with) return getOperation(clause as SqlClause);
  return null;
}

/**
 * Collect all table names from a clause, including subqueries.
 */
export function collectTables(clause: SqlClause): string[] {
  const tables: string[] = [];

  walkClauses(clause, (c) => {
    // FROM clause
    if (c.from) {
      extractTableNames(c.from, tables);
    }

    // INSERT/UPDATE/DELETE targets
    if (typeof c["insert-into"] === "string") tables.push(c["insert-into"]);
    if (typeof c.update === "string") tables.push(c.update);
    if (typeof c["delete-from"] === "string") tables.push(c["delete-from"]);

    // JOINs
    for (const joinType of ["join", "left-join", "right-join", "inner-join", "full-join", "cross-join"]) {
      const joins = c[joinType] as [SqlExpr, SqlExpr][] | undefined;
      if (joins) {
        for (const [tableExpr] of joins) {
          extractTableNames(tableExpr, tables);
        }
      }
    }

    // USING clause (for UPDATE/DELETE ... USING)
    if (Array.isArray(c.using)) {
      for (const item of c.using) {
        extractTableNames(item, tables);
      }
    }

    return c; // Return unchanged for walk
  });

  return [...new Set(tables)];
}

function extractTableNames(expr: SqlExpr, tables: string[]): void {
  if (typeof expr === "string" && !expr.startsWith("%")) {
    // Simple table name
    tables.push(expr);
  } else if (Array.isArray(expr)) {
    if (expr.length >= 1) {
      const first = expr[0];
      // [tableName, alias] pattern
      if (typeof first === "string" && !first.startsWith("%")) {
        tables.push(first);
      }
      // [subquery, alias] - subquery will be walked separately
    }
  }
}

/**
 * Check if a WHERE clause is a tautology (always true).
 */
export function isTautology(where: SqlExpr): boolean {
  // Literal true
  if (where === true) return true;

  // {$: true}
  if (isTypedValue(where, true)) return true;

  // Check for equality tautologies: 1=1, 'a'='a', col=col
  if (Array.isArray(where) && where[0] === "=") {
    const [, left, right] = where;

    // Same identifier: col = col
    if (typeof left === "string" && left === right) return true;

    // Same typed value: {$: 1} = {$: 1}
    if (isTypedValue(left) && isTypedValue(right)) {
      const leftVal = (left as { $: unknown }).$;
      const rightVal = (right as { $: unknown }).$;
      if (leftVal === rightVal) return true;
    }

    // Same literal: 1 = 1
    if (typeof left === "number" && left === right) return true;
  }

  // OR with tautology on either side
  if (Array.isArray(where) && where[0] === "or") {
    for (let i = 1; i < where.length; i++) {
      if (isTautology(where[i] as SqlExpr)) return true;
    }
  }

  return false;
}

function isTypedValue(x: unknown, value?: unknown): boolean {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  if (!("$" in x)) return false;
  if (value !== undefined) return (x as { $: unknown }).$ === value;
  return true;
}

function checkLimit(clause: SqlClause, requireLimit?: boolean, maxRows?: number): string | null {
  const limit = clause.limit;

  if (!limit) {
    if (requireLimit) {
      return "SELECT requires LIMIT clause";
    }
    return null;
  }

  // Extract numeric value from limit
  let limitValue: number | null = null;

  if (typeof limit === "number") {
    limitValue = limit;
  } else if (isTypedValue(limit)) {
    const val = (limit as { $: unknown }).$;
    if (typeof val === "number") limitValue = val;
  }

  if (maxRows !== undefined && limitValue !== null && limitValue > maxRows) {
    return `LIMIT ${limitValue} exceeds maximum ${maxRows} rows`;
  }

  return null;
}
