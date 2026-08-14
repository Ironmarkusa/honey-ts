/**
 * HoneySQL TypeScript - Query Manipulation Helpers
 *
 * Functions for transforming and manipulating clause maps.
 */

import type { SqlClause, SqlExpr } from "./types.js";

// ============================================================================
// Identifier Utilities
// ============================================================================

/**
 * Check if a value is a qualified identifier {ident: [...]}
 */
function isQualifiedIdent(x: unknown): x is { ident: string[] } {
  return typeof x === "object" && x !== null && "ident" in x && Array.isArray((x as { ident: unknown }).ident);
}

/**
 * Convert an identifier to a dot-separated string for comparison/lookup.
 * Handles both string format "a.b.c" and {ident: ["a", "b", "c"]} format.
 */
function identToString(x: unknown): string | null {
  if (typeof x === "string") return x;
  if (isQualifiedIdent(x)) return x.ident.join(".");
  return null;
}

/**
 * Get the parts of an identifier.
 * "a.b.c" → ["a", "b", "c"]
 * {ident: ["a", "b", "c"]} → ["a", "b", "c"]
 */
function identParts(x: unknown): string[] | null {
  if (typeof x === "string") return x.split(".");
  if (isQualifiedIdent(x)) return x.ident;
  return null;
}

// ============================================================================
// Table Aliases
// ============================================================================

/**
 * Represents a scope of table aliases in a query tree.
 * SQL aliases are scoped to their query block - subqueries have their own scope.
 */
export interface AliasScope {
  /** Table name → alias mapping for this scope */
  aliases: Map<string, string>;
  /** Human-readable location: "root", "with:cte_name", "where", "from[0]", etc. */
  location: string;
  /** Nested scopes (subqueries, CTEs, UNIONs) */
  children: AliasScope[];
}

/**
 * Get table aliases from a query as a tree of scopes.
 *
 * - `tree.aliases` - top-level table name → alias map
 * - `tree.children` - nested scopes (subqueries, CTEs, UNIONs)
 *
 * @example
 * ```ts
 * const tree = getTableAliases(clause);
 * tree.aliases        // Map { "users" => "u", "orders" => "o" }
 * tree.children       // nested subquery scopes
 * tree.children[0].location  // "where", "from[0]", "with:cte_name", etc.
 * ```
 */
export function getTableAliases(clause: SqlClause, location = "root"): AliasScope {
  const scope: AliasScope = {
    aliases: extractTableToAliasMap(clause),
    location,
    children: [],
  };

  // WITH / WITH RECURSIVE - each CTE is a scope
  for (const key of ["with", "with-recursive"] as const) {
    const ctes = clause[key] as [string, SqlClause][] | undefined;
    if (ctes) {
      for (const [name, cte] of ctes) {
        scope.children.push(getTableAliases(cte, `${key}:${name}`));
      }
    }
  }

  // UNION / INTERSECT / EXCEPT - each branch is a scope
  for (const key of ["union", "union-all", "intersect", "except", "except-all"] as const) {
    const branches = clause[key] as SqlClause[] | undefined;
    if (branches) {
      branches.forEach((branch, i) => {
        scope.children.push(getTableAliases(branch, `${key}[${i}]`));
      });
    }
  }

  // FROM - may contain subqueries
  if (clause.from) {
    collectSubqueryScopes(clause.from as SqlExpr, "from", scope.children);
  }

  // WHERE - may contain subqueries
  if (clause.where) {
    collectSubqueryScopes(clause.where as SqlExpr, "where", scope.children);
  }

  // SELECT - may contain scalar subqueries
  if (clause.select) {
    collectSubqueryScopes(clause.select as SqlExpr, "select", scope.children);
  }

  // HAVING - may contain subqueries
  if (clause.having) {
    collectSubqueryScopes(clause.having as SqlExpr, "having", scope.children);
  }

  return scope;
}

/**
 * Get select column aliases from a query as a tree of scopes.
 *
 * Returns column expression → output alias mapping for each SELECT.
 *
 * @example
 * ```ts
 * const tree = getSelectAliases(clause);
 * // SELECT u.id AS user_id, name FROM users u
 * tree.aliases  // Map { "u.id" => "user_id", "name" => "name" }
 * ```
 */
export function getSelectAliases(clause: SqlClause, location = "root"): AliasScope {
  const scope: AliasScope = {
    aliases: extractSelectAliasMap(clause),
    location,
    children: [],
  };

  // WITH / WITH RECURSIVE - each CTE is a scope
  for (const key of ["with", "with-recursive"] as const) {
    const ctes = clause[key] as [string, SqlClause][] | undefined;
    if (ctes) {
      for (const [name, cte] of ctes) {
        scope.children.push(getSelectAliases(cte, `${key}:${name}`));
      }
    }
  }

  // UNION / INTERSECT / EXCEPT - each branch is a scope
  for (const key of ["union", "union-all", "intersect", "except", "except-all"] as const) {
    const branches = clause[key] as SqlClause[] | undefined;
    if (branches) {
      branches.forEach((branch, i) => {
        scope.children.push(getSelectAliases(branch, `${key}[${i}]`));
      });
    }
  }

  // FROM - may contain subqueries
  if (clause.from) {
    collectSelectAliasScopes(clause.from as SqlExpr, "from", scope.children);
  }

  // WHERE - may contain subqueries
  if (clause.where) {
    collectSelectAliasScopes(clause.where as SqlExpr, "where", scope.children);
  }

  // SELECT - may contain scalar subqueries
  if (clause.select) {
    collectSelectAliasScopes(clause.select as SqlExpr, "select", scope.children);
  }

  return scope;
}

/**
 * Extract column → alias mapping from SELECT clause.
 * Resolves table aliases to actual table names.
 */
function extractSelectAliasMap(clause: SqlClause): Map<string, string> {
  const columnToAlias = new Map<string, string>();
  const tableAliasMap = extractTableAliases(clause); // alias → table name

  // Handle all select variants
  for (const key of ["select", "select-distinct"] as const) {
    const selectValue = clause[key];
    if (!selectValue) continue;

    const items = Array.isArray(selectValue) ? selectValue : [selectValue];
    for (const item of items) {
      extractColumnAlias(item as SqlExpr, columnToAlias, tableAliasMap);
    }
  }

  // select-distinct-on: [onExprs, ...selectExprs]
  if (clause["select-distinct-on"]) {
    const arr = clause["select-distinct-on"] as SqlExpr[];
    for (let i = 1; i < arr.length; i++) {
      extractColumnAlias(arr[i] as SqlExpr, columnToAlias, tableAliasMap);
    }
  }

  return columnToAlias;
}

/**
 * Extract column expression → alias from a single select item.
 * Resolves table aliases to actual table names.
 */
function extractColumnAlias(
  item: SqlExpr,
  columnToAlias: Map<string, string>,
  tableAliasMap: Map<string, string>
): void {
  // Skip * and qualified *
  if (item === "*") return;
  if (typeof item === "string" && item.endsWith(".*")) return;

  // Bare column: "id" or "u.id" or {ident: ["u", "id"]}
  if (typeof item === "string" || isQualifiedIdent(item)) {
    const resolved = resolveColumnIdent(item, tableAliasMap);
    // For qualified names, the output alias is just the column part (last element)
    const parts = identParts(item);
    const outputAlias = parts && parts.length > 1 ? parts[parts.length - 1]! : (identToString(item) ?? "");
    columnToAlias.set(resolved, outputAlias);
    return;
  }

  // [expr, alias] form
  if (Array.isArray(item) && item.length === 2) {
    const [expr, alias] = item;
    if (typeof alias === "string" && !alias.startsWith("%")) {
      // Format expression as string key, resolving table aliases
      const exprKey = exprToStringResolved(expr as SqlExpr, tableAliasMap);
      columnToAlias.set(exprKey, alias);
      return;
    }
  }

  // Expression without alias - try to derive a key
  if (Array.isArray(item)) {
    const exprKey = exprToStringResolved(item, tableAliasMap);
    columnToAlias.set(exprKey, exprKey);
  }
}

/**
 * Resolve table alias in a column identifier to actual table name.
 * "u.id" with u→users becomes "users.id"
 * {ident: ["u", "id"]} with u→users becomes "users.id"
 */
function resolveColumnIdent(col: string | { ident: string[] }, tableAliasMap: Map<string, string>): string {
  const parts = identParts(col);
  if (!parts || parts.length === 0) return identToString(col) ?? "";
  if (parts.length === 1) return parts[0]!;

  // First part might be a table alias
  const tableAlias = parts[0]!;
  const tableName = tableAliasMap.get(tableAlias) ?? tableAlias;
  return [tableName, ...parts.slice(1)].join(".");
}

/**
 * Convert expression to string, resolving table aliases.
 */
function exprToStringResolved(expr: SqlExpr, tableAliasMap: Map<string, string>): string {
  if (typeof expr === "string") {
    return resolveColumnIdent(expr, tableAliasMap);
  }
  if (isQualifiedIdent(expr)) {
    return resolveColumnIdent(expr, tableAliasMap);
  }
  // For non-string expressions, use regular exprToString
  return exprToString(expr);
}

/**
 * Convert expression to a string key for the alias map.
 */
function exprToString(expr: SqlExpr): string {
  if (typeof expr === "string") return expr;
  if (typeof expr === "number") return String(expr);
  if (expr === null) return "NULL";
  if (typeof expr === "boolean") return String(expr).toUpperCase();
  if (isQualifiedIdent(expr)) return expr.ident.join(".");
  if (Array.isArray(expr)) {
    // Function call like ["%count", "*"]
    if (typeof expr[0] === "string" && expr[0].startsWith("%")) {
      const fn = expr[0].slice(1).toUpperCase();
      const args = expr.slice(1).map(e => exprToString(e as SqlExpr)).join(", ");
      return `${fn}(${args})`;
    }
    // Just join for other arrays
    return expr.map(e => exprToString(e as SqlExpr)).join(".");
  }
  if (typeof expr === "object" && expr !== null) {
    if ("$" in expr) return String((expr as { $: unknown }).$);
    if ("v" in expr) return String((expr as { v: unknown }).v);
    if ("__raw" in expr) return String((expr as { __raw: unknown }).__raw);
    // Subquery or clause object
    if (isClauseMap(expr)) return "(subquery)";
  }
  return String(expr);
}

/**
 * Recursively find subqueries and collect their select alias scopes.
 */
function collectSelectAliasScopes(
  expr: SqlExpr,
  basePath: string,
  children: AliasScope[],
  index = { n: 0 }
): void {
  if (isClauseMap(expr)) {
    const location = index.n === 0 ? basePath : `${basePath}[${index.n}]`;
    index.n++;
    children.push(getSelectAliases(expr, location));
    return;
  }

  if (Array.isArray(expr)) {
    for (const item of expr) {
      collectSelectAliasScopes(item as SqlExpr, basePath, children, index);
    }
  }
}

/**
 * Recursively find subqueries in an expression and add their scopes.
 */
function collectSubqueryScopes(
  expr: SqlExpr,
  basePath: string,
  children: AliasScope[],
  index = { n: 0 }
): void {
  if (isClauseMap(expr)) {
    const location = index.n === 0 ? basePath : `${basePath}[${index.n}]`;
    index.n++;
    children.push(getTableAliases(expr, location));
    return;
  }

  if (Array.isArray(expr)) {
    for (const item of expr) {
      collectSubqueryScopes(item as SqlExpr, basePath, children, index);
    }
  }
}

/**
 * Extract table name → alias mapping from FROM and JOIN clauses.
 * (Internal helper)
 */
function extractTableToAliasMap(clause: SqlClause): Map<string, string> {
  const tableToAlias = new Map<string, string>();

  // Process FROM clause
  if (clause.from) {
    const fromItems = Array.isArray(clause.from) ? clause.from : [clause.from];
    for (const item of fromItems) {
      extractTableToAlias(item as SqlExpr, tableToAlias);
    }
  }

  // Process all JOIN types
  for (const joinType of ["join", "left-join", "right-join", "inner-join", "outer-join", "full-join"] as const) {
    const joins = clause[joinType] as [SqlExpr, SqlExpr][] | undefined;
    if (joins) {
      for (const [tableExpr] of joins) {
        extractTableToAlias(tableExpr, tableToAlias);
      }
    }
  }

  return tableToAlias;
}

// ============================================================================
// Internal Helpers
// ============================================================================

function isClauseMap(x: unknown): x is SqlClause {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ============================================================================
// Select Analysis
// ============================================================================

/**
 * Analysis of a single SELECT item.
 */
export interface SelectItemAnalysis {
  /** Output column name/alias */
  alias: string;
  /** Source columns this output depends on */
  sources: string[];
  /** True if just a column rename, false if transformed */
  isPassthrough: boolean;
  /** Original expression */
  expr: SqlExpr;
}

/**
 * Analysis of SELECT items in a query scope.
 */
export interface SelectAnalysisScope {
  /** Analyzed SELECT items for this scope */
  items: SelectItemAnalysis[];
  /** Human-readable location: "root", "with:cte_name", "from[0]", etc. */
  location: string;
  /** Nested scopes (subqueries, CTEs, UNIONs) */
  children: SelectAnalysisScope[];
}

/**
 * Analyze SELECT items in a query, returning source dependencies and complexity.
 *
 * @example
 * ```ts
 * const clause = fromSql(`
 *   SELECT s."Email" AS email_hash,
 *          CASE WHEN s."Source" LIKE '%fb%' THEN 'meta' END AS platform,
 *          s."FirstName" || ' ' || s."LastName" AS full_name
 *   FROM staging.imports s
 * `);
 * const analysis = analyzeSelects(clause);
 *
 * analysis.items[0]  // { alias: "email_hash", sources: ["Email"], isPassthrough: true, ... }
 * analysis.items[1]  // { alias: "platform", sources: ["Source"], isPassthrough: false, ... }
 * analysis.items[2]  // { alias: "full_name", sources: ["FirstName", "LastName"], isPassthrough: false, ... }
 * ```
 */
export function analyzeSelects(clause: SqlClause, location = "root"): SelectAnalysisScope {
  const tableAliasMap = extractTableAliases(clause);
  const scope: SelectAnalysisScope = {
    items: extractSelectAnalysis(clause, tableAliasMap),
    location,
    children: [],
  };

  // WITH / WITH RECURSIVE - each CTE is a scope
  for (const key of ["with", "with-recursive"] as const) {
    const ctes = clause[key] as [string, SqlClause][] | undefined;
    if (ctes) {
      for (const [name, cte] of ctes) {
        scope.children.push(analyzeSelects(cte, `${key}:${name}`));
      }
    }
  }

  // UNION / INTERSECT / EXCEPT - each branch is a scope
  for (const key of ["union", "union-all", "intersect", "except", "except-all"] as const) {
    const branches = clause[key] as SqlClause[] | undefined;
    if (branches) {
      branches.forEach((branch, i) => {
        scope.children.push(analyzeSelects(branch, `${key}[${i}]`));
      });
    }
  }

  // FROM - may contain subqueries
  if (clause.from) {
    collectAnalysisScopes(clause.from as SqlExpr, "from", scope.children);
  }

  // WHERE - may contain subqueries
  if (clause.where) {
    collectAnalysisScopes(clause.where as SqlExpr, "where", scope.children);
  }

  // SELECT - may contain scalar subqueries
  if (clause.select) {
    collectAnalysisScopes(clause.select as SqlExpr, "select", scope.children);
  }

  return scope;
}

/**
 * Extract analysis for all SELECT items in a clause.
 */
function extractSelectAnalysis(
  clause: SqlClause,
  tableAliasMap: Map<string, string>
): SelectItemAnalysis[] {
  const items: SelectItemAnalysis[] = [];

  // Handle all select variants
  for (const key of ["select", "select-distinct"] as const) {
    const selectValue = clause[key];
    if (!selectValue) continue;

    const selectItems = Array.isArray(selectValue) ? selectValue : [selectValue];
    for (const item of selectItems) {
      const analysis = analyzeSelectItem(item as SqlExpr, tableAliasMap);
      if (analysis) items.push(analysis);
    }
  }

  // select-distinct-on: [onExprs, ...selectExprs]
  if (clause["select-distinct-on"]) {
    const arr = clause["select-distinct-on"] as SqlExpr[];
    for (let i = 1; i < arr.length; i++) {
      const analysis = analyzeSelectItem(arr[i] as SqlExpr, tableAliasMap);
      if (analysis) items.push(analysis);
    }
  }

  return items;
}

/**
 * Analyze a single SELECT item.
 */
function analyzeSelectItem(
  item: SqlExpr,
  tableAliasMap: Map<string, string>
): SelectItemAnalysis | null {
  // Skip * and qualified *
  if (item === "*") return null;
  if (typeof item === "string" && item.endsWith(".*")) return null;

  // Bare column: "id" or "u.id" or {ident: ["u", "id"]}
  if (typeof item === "string") {
    const columnName = item.includes(".") ? item.split(".").pop()! : item;
    return {
      alias: columnName,
      sources: [resolveColumnIdent(item, tableAliasMap)],
      isPassthrough: true,
      expr: item,
    };
  }

  // Qualified identifier {ident: ["table", "column"]}
  if (isQualifiedIdent(item)) {
    const parts = item.ident;
    const columnName = parts[parts.length - 1]!;
    return {
      alias: columnName,
      sources: [resolveColumnIdent(item, tableAliasMap)],
      isPassthrough: true,
      expr: item,
    };
  }

  // [expr, alias] form
  if (Array.isArray(item) && item.length === 2) {
    const [expr, alias] = item;
    if (typeof alias === "string" && !alias.startsWith("%")) {
      const sources = getReferencedColumns(expr as SqlExpr, tableAliasMap);
      // Passthrough if it's just a column reference (string or {ident: [...]})
      const isPassthrough = (typeof expr === "string" && !expr.startsWith("%")) || isQualifiedIdent(expr);
      return {
        alias,
        sources,
        isPassthrough,
        expr: expr as SqlExpr,
      };
    }
  }

  // Complex expression without explicit alias
  if (Array.isArray(item)) {
    const sources = getReferencedColumns(item, tableAliasMap);
    const exprStr = exprToString(item);
    return {
      alias: exprStr,
      sources,
      isPassthrough: false,
      expr: item,
    };
  }

  return null;
}

/**
 * Get all column references from an expression.
 * Returns resolved table.column names when tableAliasMap is provided.
 *
 * @example
 * ```ts
 * // Without alias map - returns just column names
 * getReferencedColumns(["||", "t.first", "t.last"])
 * // => ["first", "last"]
 *
 * // With alias map - returns resolved table.column
 * getReferencedColumns(["||", "t.first", "t.last"], aliasMap)
 * // => ["users.first", "users.last"]  (if t -> users)
 * ```
 */
export function getReferencedColumns(
  expr: SqlExpr,
  tableAliasMap?: Map<string, string>
): string[] {
  const cols: string[] = [];

  function walk(e: SqlExpr): void {
    // Qualified identifier {ident: ["table", "column"]}
    if (isQualifiedIdent(e)) {
      const parts = e.ident;
      let resolved: string;
      if (parts.length > 1) {
        const tableAlias = parts[0]!;
        const colName = parts.slice(1).join(".");
        const tableName = tableAliasMap?.get(tableAlias) ?? tableAlias;
        resolved = `${tableName}.${colName}`;
      } else {
        resolved = parts[0] ?? "";
      }
      if (resolved && !cols.includes(resolved)) {
        cols.push(resolved);
      }
      return;
    }

    // Column reference (string)
    if (typeof e === "string") {
      // Skip operators, functions, keywords
      if (e.startsWith("%")) return;
      if (e === "*") return;
      if (e === "else") return;
      if (["and", "or", "not", "is", "in", "like", "between"].includes(e.toLowerCase())) return;

      let resolved: string;
      if (e.includes(".")) {
        // Qualified: "t.email" -> resolve alias
        const dotIdx = e.indexOf(".");
        const tableAlias = e.substring(0, dotIdx);
        const colName = e.substring(dotIdx + 1);
        const tableName = tableAliasMap?.get(tableAlias) ?? tableAlias;
        resolved = `${tableName}.${colName}`;
      } else {
        // Unqualified: just column name
        resolved = e;
      }

      if (resolved && !cols.includes(resolved)) {
        cols.push(resolved);
      }
      return;
    }

    // Recurse into arrays
    if (Array.isArray(e)) {
      const head = typeof e[0] === "string" ? e[0].toLowerCase() : null;
      // CAST's last argument is a type name, not a column reference.
      if (head === "cast" || head === "try-cast") {
        walk(e[1] as SqlExpr);
        return;
      }
      for (let i = 0; i < e.length; i++) {
        // Skip first element if it's an operator/function
        if (i === 0 && typeof e[0] === "string" &&
            (e[0].startsWith("%") || isOperator(e[0]))) {
          continue;
        }
        walk(e[i] as SqlExpr);
      }
      return;
    }

    // Don't descend into subqueries - different scope
    if (isClauseMap(e)) return;

    // Handle typed values - they're not column references
    if (typeof e === "object" && e !== null) {
      if ("$" in e || "v" in e || "__raw" in e || "__param" in e || "__lift" in e || "ident" in e) return;
    }
  }

  walk(expr);
  return cols;
}

/**
 * Check if a string is a SQL operator.
 */
function isOperator(s: string): boolean {
  const operators = [
    "=", "<>", "!=", "<", ">", "<=", ">=",
    "+", "-", "*", "/", "||",
    "and", "or", "not",
    "is", "is-not", "in", "not-in",
    "like", "ilike", "between", "not-between",
    "case", "case-expr",
    "->", "->>", "@>", "<@", "?", "&&", "@@",
    "~", "~*", "!~", "!~*",
    "cast", "array", "exists", "any", "all",
  ];
  return operators.includes(s.toLowerCase());
}

/**
 * Recursively find subqueries and collect their analysis scopes.
 */
function collectAnalysisScopes(
  expr: SqlExpr,
  basePath: string,
  children: SelectAnalysisScope[],
  index = { n: 0 }
): void {
  if (isClauseMap(expr)) {
    const location = index.n === 0 ? basePath : `${basePath}[${index.n}]`;
    index.n++;
    children.push(analyzeSelects(expr, location));
    return;
  }

  if (Array.isArray(expr)) {
    for (const item of expr) {
      collectAnalysisScopes(item as SqlExpr, basePath, children, index);
    }
  }
}

// ============================================================================
// Select Manipulation
// ============================================================================

/**
 * Extract table → alias from a single FROM/JOIN item.
 */
function extractTableToAlias(item: SqlExpr, tableToAlias: Map<string, string>): void {
  // Bare table name: "users" -> users maps to users
  if (typeof item === "string") {
    tableToAlias.set(item, item);
    return;
  }

  // [table, alias] form: ["users", "u"] -> users maps to u
  if (Array.isArray(item) && item.length === 2) {
    const [first, second] = item;
    if (typeof first === "string" && typeof second === "string") {
      tableToAlias.set(first, second);
      return;
    }
  }
}

/**
 * Extract alias → table name mapping from FROM and JOIN clauses.
 * (Internal helper for overrideSelects)
 */
export function extractTableAliases(clause: SqlClause): Map<string, string> {
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
