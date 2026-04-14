/**
 * Rewrite primitives — structural replace.
 *
 * Every helper is immutable: it returns a new clause tree without touching
 * the input. Replacement functions may return `null` to leave a node in
 * place (useful when a matcher over-matches and you want finer control).
 */

import type { SqlClause, SqlExpr } from "../types.js";
import type { Matcher } from "./matchers.js";
import { identParts, identString } from "./matchers.js";
import { mapClauseTree, mapExprTree } from "./walk.js";

export type Replacement<T = SqlExpr> = T | ((hit: T) => T | null);

// ============================================================================
// replaceWhere — find matching nodes inside WHERE, replace them
// ============================================================================

/**
 * Replace every matching node inside any WHERE tree across the clause tree.
 * Matching nodes in HAVING are NOT touched (use `replacePredicate` for both).
 *
 * @example
 * ```ts
 * replaceWhere(clause, dateRange("date"), ["between", "date", {v: "2024-01-01"}, {v: "2024-12-31"}])
 * ```
 */
export function replaceWhere(
  clause: SqlClause,
  matcher: Matcher,
  replacement: Replacement<SqlExpr>
): SqlClause {
  return mapClauseTree(clause, (c) => {
    if (c.where === undefined) return c;
    return { ...c, where: replaceInExpr(c.where as SqlExpr, matcher, replacement) };
  });
}

/**
 * Replace every matching node inside any WHERE or HAVING tree.
 */
export function replacePredicate(
  clause: SqlClause,
  matcher: Matcher,
  replacement: Replacement<SqlExpr>
): SqlClause {
  return mapClauseTree(clause, (c) => {
    let next = c;
    if (c.where !== undefined) {
      next = { ...next, where: replaceInExpr(c.where as SqlExpr, matcher, replacement) };
    }
    if (c.having !== undefined) {
      next = { ...next, having: replaceInExpr(c.having as SqlExpr, matcher, replacement) };
    }
    return next;
  });
}

function replaceInExpr(
  expr: SqlExpr,
  matcher: Matcher,
  repl: Replacement<SqlExpr>
): SqlExpr {
  return mapExprTree(expr, (node) => {
    if (matcher(node)) {
      const result = typeof repl === "function" ? repl(node) : repl;
      return result === null ? node : result;
    }
    return node;
  });
}

// ============================================================================
// replaceSelect — swap projection items
// ============================================================================

/**
 * Replace matching items in every `select` / `select-distinct` list across
 * the tree. Matcher is applied to each item (not to sub-expressions).
 * For aliased items `[expr, alias]`, matcher is applied to `expr`.
 */
export function replaceSelect(
  clause: SqlClause,
  matcher: Matcher,
  replacement: Replacement<SqlExpr>
): SqlClause {
  return mapClauseTree(clause, (c) => {
    let next = c;
    for (const key of ["select", "select-distinct"] as const) {
      if (next[key] === undefined) continue;
      const items = Array.isArray(next[key]) ? next[key] : [next[key]];
      const mapped = (items as SqlExpr[]).map((item) => {
        const target = isAliasedItem(item) ? (item as SqlExpr[])[0]! : item;
        if (!matcher(target)) return item;
        const result =
          typeof replacement === "function"
            ? replacement(target)
            : replacement;
        if (result === null) return item;
        if (isAliasedItem(item)) {
          const alias = (item as SqlExpr[])[1]!;
          return [result, alias] as SqlExpr;
        }
        return result;
      });
      next = { ...next, [key]: mapped };
    }
    return next;
  });
}

function isAliasedItem(item: SqlExpr): boolean {
  return (
    Array.isArray(item) &&
    item.length === 2 &&
    typeof item[1] === "string" &&
    !(item[1] as string).startsWith("%")
  );
}

// ============================================================================
// replaceTable — rename tables everywhere
// ============================================================================

/**
 * Rename a table across FROM, JOIN targets, and all qualified column refs.
 * Preserves aliases — `FROM users u` becomes `FROM members u` and `u.email`
 * stays `u.email` (only bare references to `users.email` get rewritten).
 *
 * Both string and `{ident: [...]}` forms are rewritten consistently.
 */
export function replaceTable(
  clause: SqlClause,
  from: string,
  to: string
): SqlClause {
  return mapClauseTree(clause, (c) => {
    let next = { ...c };

    // FROM — may be scalar or array of items
    if (next.from !== undefined) {
      if (Array.isArray(next.from)) {
        next.from = (next.from as SqlExpr[]).map((item) =>
          renameTableInFrom(item as SqlExpr, from, to)
        ) as never;
      } else {
        next.from = renameTableInFrom(next.from as SqlExpr, from, to) as never;
      }
    }

    // JOINs — rename table target AND rewrite any qualified refs inside ON cond
    for (const jk of [
      "join",
      "left-join",
      "right-join",
      "inner-join",
      "outer-join",
      "full-join",
      "cross-join",
    ] as const) {
      if (next[jk] === undefined) continue;
      const joins = next[jk] as [SqlExpr, SqlExpr?][];
      next[jk] = joins.map(([tableExpr, cond]) => {
        const renamed = renameTableInFrom(tableExpr, from, to);
        if (cond === undefined) return [renamed];
        const rewrittenCond = mapExprTree(cond, (node) =>
          renameQualifiedCol(node, from, to)
        );
        return [renamed, rewrittenCond];
      }) as never;
    }

    // Every expression-bearing clause: rewrite fully-qualified column refs
    for (const key of ["select", "select-distinct", "where", "having", "group-by", "order-by"] as const) {
      if (next[key] === undefined) continue;
      next[key] = mapExprTree(next[key] as SqlExpr, (node) =>
        renameQualifiedCol(node, from, to)
      ) as never;
    }

    return next;
  });
}

function renameTableInFrom(item: SqlExpr, from: string, to: string): SqlExpr {
  const s = identString(item);
  if (s !== null && s === from) {
    return typeof item === "string" ? to : { ident: [to] };
  }
  if (Array.isArray(item) && item.length === 2) {
    const tableName = identString(item[0]);
    if (tableName === from) {
      return [to, item[1]] as SqlExpr;
    }
  }
  return item;
}

/** Replace fully-qualified column refs whose table part matches `from`. */
function renameQualifiedCol(node: SqlExpr, from: string, to: string): SqlExpr {
  const parts = identParts(node);
  if (!parts || parts.length < 2) return node;
  if (parts[0] !== from) return node;
  const newParts = [to, ...parts.slice(1)];
  if (typeof node === "string") return newParts.join(".");
  return { ident: newParts };
}

// ============================================================================
// replaceColumn — rename a column, preserving the table qualifier
// ============================================================================

/**
 * Rename a column. Accepts `{from: "email", to: "contact_email"}` for
 * unqualified renames (touches every `email` ident regardless of table), or
 * `{from: "users.email", to: "users.contact_email"}` for qualified renames.
 *
 * Qualified renames also rewrite refs through known aliases declared in
 * FROM/JOIN (e.g., `u.email` when `FROM users u`).
 */
export function replaceColumn(
  clause: SqlClause,
  spec: { from: string; to: string }
): SqlClause {
  const fromParts = spec.from.split(".");
  const toParts = spec.to.split(".");

  return mapClauseTree(clause, (c) => {
    const aliasToTable = collectAliasToTable(c);

    const rewrite = (node: SqlExpr): SqlExpr => {
      const parts = identParts(node);
      if (!parts) return node;

      if (fromParts.length === 1) {
        // bare rename — rewrite last segment only
        if (parts[parts.length - 1] !== fromParts[0]) return node;
        const newParts = [...parts.slice(0, -1), toParts[toParts.length - 1]!];
        return typeof node === "string" ? newParts.join(".") : { ident: newParts };
      }

      // qualified: match table.col or alias.col (alias→table resolution)
      if (parts.length < 2) return node;
      const colPart = parts[parts.length - 1];
      const tablePart = parts[parts.length - 2];
      if (colPart !== fromParts[fromParts.length - 1]) return node;

      const wantedTable = fromParts[fromParts.length - 2]!;
      const resolvedTable = aliasToTable.get(tablePart ?? "") ?? tablePart;
      if (resolvedTable !== wantedTable) return node;

      // rebuild: keep the original prefix (including alias if used), swap last segment
      const newParts = [...parts.slice(0, -1), toParts[toParts.length - 1]!];
      return typeof node === "string" ? newParts.join(".") : { ident: newParts };
    };

    let next = { ...c };
    for (const key of ["select", "select-distinct", "where", "having", "group-by", "order-by"] as const) {
      if (next[key] === undefined) continue;
      next[key] = mapExprTree(next[key] as SqlExpr, rewrite) as never;
    }
    for (const jk of [
      "join",
      "left-join",
      "right-join",
      "inner-join",
      "outer-join",
      "full-join",
    ] as const) {
      if (next[jk] === undefined) continue;
      const joins = next[jk] as [SqlExpr, SqlExpr?][];
      next[jk] = joins.map(([t, cond]) =>
        cond === undefined ? [t] : [t, mapExprTree(cond, rewrite)]
      ) as never;
    }
    return next;
  });
}

function collectAliasToTable(c: SqlClause): Map<string, string> {
  const m = new Map<string, string>();
  const collect = (item: SqlExpr) => {
    if (Array.isArray(item) && item.length === 2) {
      const t = identString(item[0]);
      const a = identString(item[1]);
      if (t && a) m.set(a, t);
    }
  };
  if (c.from !== undefined) {
    const items = Array.isArray(c.from) ? c.from : [c.from];
    for (const item of items) collect(item as SqlExpr);
  }
  for (const jk of [
    "join",
    "left-join",
    "right-join",
    "inner-join",
    "outer-join",
    "full-join",
  ] as const) {
    const joins = c[jk] as [SqlExpr, SqlExpr?][] | undefined;
    if (joins) for (const [t] of joins) collect(t);
  }
  return m;
}

// ============================================================================
// replaceFunction — swap function calls by name
// ============================================================================

/**
 * Replace every `%oldName(...)` call with `%newName(...)`. Arguments are
 * preserved unless `replacement` is a function that returns a new expression.
 */
export function replaceFunction(
  clause: SqlClause,
  oldName: string,
  newName: string | ((args: SqlExpr[]) => SqlExpr)
): SqlClause {
  const oldKey = oldName.startsWith("%") ? oldName : `%${oldName}`;
  const newKey =
    typeof newName === "string"
      ? newName.startsWith("%")
        ? newName
        : `%${newName}`
      : null;

  return mapClauseTree(clause, (c) => {
    let next = { ...c };
    const rewrite = (node: SqlExpr): SqlExpr => {
      if (!Array.isArray(node) || node[0] !== oldKey) return node;
      if (typeof newName === "function") return newName(node.slice(1) as SqlExpr[]);
      return [newKey!, ...node.slice(1)] as SqlExpr;
    };
    for (const key of ["select", "select-distinct", "where", "having", "group-by", "order-by"] as const) {
      if (next[key] === undefined) continue;
      next[key] = mapExprTree(next[key] as SqlExpr, rewrite) as never;
    }
    return next;
  });
}
