/**
 * Stable node addressing for clause trees — the primitive a query-builder UI
 * needs to say "the user clicked THIS predicate" and edit exactly that node.
 *
 * A path is an array of steps from the clause root: object keys and array
 * indexes. `["where", 2]` is the second AND-arm of the WHERE; `["join", 0, 1]`
 * is the ON condition of the first join pair; `["with", 0, 1, "select", 0]`
 * is the first select item of the first CTE's body.
 *
 * ```ts
 * const hits = findPaths(clause, matchers.col("status"));
 * // [{ path: ["where", 1], node: ["=", "status", {$: "active"}] }]
 *
 * const edited = setAt(clause, hits[0].path, ["=", "status", $("archived")]);
 * removeAt(clause, ["where", 2]);   // drop one AND arm, heal the tree
 * ```
 *
 * All updates are immutable — containers along the path are copied, everything
 * else is shared, so UI diffing and undo stacks stay cheap.
 */

import type { SqlClause, SqlExpr } from "./types.js";
import type { Matcher } from "./rewrites/matchers.js";

export type PathStep = string | number;
export type Path = PathStep[];

export interface PathHit<T = SqlExpr> {
  path: Path;
  node: T;
}

// ============================================================================
// get / set / update / remove
// ============================================================================

/** Read the node at a path. Returns undefined when the path doesn't resolve. */
export function getAt(clause: SqlClause, path: Path): unknown {
  let node: unknown = clause;
  for (const step of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<PathStep, unknown>)[step];
  }
  return node;
}

/**
 * Replace the node at a path, returning a new tree. Containers along the path
 * are copied; untouched branches are shared with the input.
 */
export function setAt(clause: SqlClause, path: Path, value: unknown): SqlClause {
  if (path.length === 0) return value as SqlClause;

  const rebuild = (node: unknown, depth: number): unknown => {
    if (depth === path.length) return value;
    const step = path[depth]!;
    if (Array.isArray(node)) {
      const copy = node.slice();
      copy[step as number] = rebuild(node[step as number], depth + 1);
      return copy;
    }
    if (node !== null && typeof node === "object") {
      return {
        ...(node as Record<string, unknown>),
        [step]: rebuild((node as Record<PathStep, unknown>)[step], depth + 1),
      };
    }
    throw new Error(
      `setAt: path ${JSON.stringify(path)} does not resolve at step ${depth} (${String(step)})`
    );
  };

  return rebuild(clause, 0) as SqlClause;
}

/** Apply a function to the node at a path, returning a new tree. */
export function updateAt(
  clause: SqlClause,
  path: Path,
  fn: (node: unknown) => unknown
): SqlClause {
  return setAt(clause, path, fn(getAt(clause, path)));
}

/**
 * Remove the node at a path, returning a new tree and healing the container:
 * array elements are spliced out, object keys deleted. Removing an arm of a
 * two-arm AND/OR collapses the connective to the surviving arm.
 */
export function removeAt(clause: SqlClause, path: Path): SqlClause {
  if (path.length === 0) return {};
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1]!;
  const parent = getAt(clause, parentPath);

  if (Array.isArray(parent)) {
    const copy = parent.filter((_, i) => i !== last);
    // ["and", x] with one arm left → just x. ["and"] alone → gone.
    if (
      typeof copy[0] === "string" &&
      ["and", "or"].includes((copy[0] as string).toLowerCase())
    ) {
      if (copy.length === 2) return setAt(clause, parentPath, copy[1]);
      if (copy.length === 1) return removeAt(clause, parentPath);
    }
    if (copy.length === 0) return removeAt(clause, parentPath);
    return setAt(clause, parentPath, copy);
  }
  if (parent !== null && typeof parent === "object") {
    const copy = { ...(parent as Record<string, unknown>) };
    delete copy[last as string];
    return setAt(clause, parentPath, copy);
  }
  throw new Error(`removeAt: path ${JSON.stringify(path)} has no container parent`);
}

// ============================================================================
// find
// ============================================================================

/**
 * Find every node in the tree matching `matcher`, with its path. Walks the
 * entire structure — expressions, nested clauses, join pairs, CTE bodies.
 * Matches inside a matched node are also reported (deepest-last).
 */
export function findPaths(clause: SqlClause, matcher: Matcher): PathHit[] {
  const hits: PathHit[] = [];

  const walk = (node: unknown, path: Path): void => {
    try {
      if (matcher(node as SqlExpr)) hits.push({ path, node: node as SqlExpr });
    } catch {
      /* matchers may assume expression shapes; a throw is a non-match */
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, [...path, i]));
      return;
    }
    if (node !== null && typeof node === "object") {
      // Wrapper leaves are values, not containers to descend into.
      const keys = Object.keys(node as object);
      if (keys.length === 1 && ["$", "v", "__raw", "__param", "__lift"].includes(keys[0]!)) {
        return;
      }
      for (const key of keys) {
        walk((node as Record<string, unknown>)[key], [...path, key]);
      }
    }
  };

  walk(clause, []);
  return hits;
}
