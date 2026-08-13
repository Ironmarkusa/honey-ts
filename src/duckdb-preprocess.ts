/**
 * DuckDB source rewriting for the SQL front end.
 *
 * honey-ts parses with pgsql-ast-parser, a PostgreSQL parser. DuckDB's grammar
 * is a fork of PostgreSQL's, so most SQL parses unchanged — but DuckDB's own
 * extensions (list literals, struct literals, GROUP BY ALL, TRY_CAST, ...) do
 * not.
 *
 * Rather than fork a grammar, we rewrite those constructs into ordinary
 * function-call syntax that the PostgreSQL parser accepts, using reserved
 * sentinel names. A post-parse pass (see reviveSentinels) turns the resulting
 * function calls back into honey-ts's native DuckDB constructs, so the clause
 * map is identical to what a real DuckDB parser would have produced and
 * round-trips back to DuckDB syntax.
 *
 *     [1, 2, 3]        ->  __honey_list(1, 2, 3)        ->  ["list", 1, 2, 3]
 *     {'a': 1}         ->  __honey_struct('a', 1)       ->  ["struct", ["a", 1]]
 *     TRY_CAST(x AS T) ->  __honey_try(CAST(x AS T))    ->  ["try-cast", x, "T"]
 *
 * Every rewrite is string- and comment-aware: SQL string literals, quoted
 * identifiers, dollar-quoted blocks and comments are never rewritten.
 *
 * This runs only for `fromSql(sql, {dialect: "duckdb"})`. PostgreSQL parsing is
 * completely unaffected.
 */

import type { SqlClause, SqlExpr } from "./types.js";
import { isClause } from "./types.js";

/** Sentinel function names. Chosen to be impossible in real user SQL. */
export const SENTINEL = {
  list: "__honey_list",
  struct: "__honey_struct",
  tryCast: "__honey_try",
  idiv: "__honey_idiv",
  aggOrder: "__honey_agg_order",
  orderItem: "__honey_ob",
  all: "__honey_all",
  slice: "__honey_slice",
  namedArg: "__honey_named",
} as const;

// ===========================================================================
// Scanner
// ===========================================================================

/** Regions of a SQL string that must never be rewritten. */
interface Span {
  start: number;
  end: number;
}

/**
 * Find every string literal, quoted identifier, dollar-quoted block and comment
 * so that rewrites can skip them.
 */
export function protectedSpans(sql: string): Span[] {
  const spans: Span[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    // Line comment
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      spans.push({ start: i, end: end === -1 ? sql.length : end });
      i = end === -1 ? sql.length : end;
      continue;
    }

    // Block comment (nestable in PostgreSQL and DuckDB)
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; }
        else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      spans.push({ start: i, end: j });
      i = j;
      continue;
    }

    // Dollar-quoted string: $tag$ ... $tag$
    if (ch === "$") {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        spans.push({ start: i, end: stop });
        i = stop;
        continue;
      }
    }

    // Single-quoted string ('' escapes a quote) or double-quoted identifier
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          j++;
          break;
        }
        // Backslash escapes only apply inside E'' strings; treating them as
        // escapes generally is harmless here because we only need the span.
        if (sql[j] === "\\" && ch === "'") { j += 2; continue; }
        j++;
      }
      spans.push({ start: i, end: j });
      i = j;
      continue;
    }

    i++;
  }

  return spans;
}

/** True when `index` falls inside a string, identifier, or comment. */
function makeGuard(sql: string): (index: number) => boolean {
  const spans = protectedSpans(sql);
  return (index: number) => spans.some((s) => index >= s.start && index < s.end);
}

/**
 * Find the index of the bracket matching the opener at `open`, skipping
 * protected spans and honouring nesting.
 */
function matchBracket(
  sql: string,
  open: number,
  guard: (i: number) => boolean
): number {
  const opener = sql[open]!;
  const closer = opener === "[" ? "]" : opener === "{" ? "}" : ")";
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (guard(i)) continue;
    const ch = sql[i];
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on top-level commas, ignoring nesting and protected spans. */
function splitTopLevel(sql: string, guard: (i: number) => boolean, offset: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    if (guard(offset + i)) continue;
    const ch = sql[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sql.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ===========================================================================
// Rewrites
// ===========================================================================

/**
 * Keywords after which a `[` opens a list literal rather than a subscript.
 *
 * `a[1]` is indexing; `SELECT [1]` is a literal. Both are preceded by a word
 * character, so the distinction is whether that word is an identifier or a
 * keyword that puts us in expression position.
 */
const EXPRESSION_POSITION_KEYWORDS = new Set([
  "select", "where", "and", "or", "not", "in", "by", "then", "else", "when",
  "case", "values", "as", "on", "having", "set", "returning", "distinct",
  "all", "from", "join", "using", "limit", "offset", "is", "like", "ilike",
  "between", "return", "do", "into", "default", "cast", "any", "some",
  "exists", "union", "except", "intersect", "qualify", "over", "partition",
  "filter", "within", "order", "group", "asc", "desc", "null", "true", "false",
]);

/**
 * `[a, b]` list literal -> `__honey_list(a, b)`.
 *
 * A `[` only opens a list literal when it does NOT follow a value — otherwise
 * it is subscripting (`a[1]`) or slicing (`a[1:2]`), which PostgreSQL already
 * parses. Slices are left alone even in literal position because `[1:2]` is not
 * a list.
 */
function rewriteListLiterals(sql: string): string {
  let out = sql;
  // Repeat until stable so nested literals are all rewritten.
  for (let pass = 0; pass < 10; pass++) {
    const guard = makeGuard(out);
    let changed = false;

    for (let i = 0; i < out.length; i++) {
      if (out[i] !== "[" || guard(i)) continue;

      // Subscript/slice: preceded by a value — a closing bracket, a quote, or
      // an identifier that is not a keyword putting us in expression position.
      const before = out.slice(0, i).replace(/\s+$/, "");
      if (/[)\]"']$/.test(before)) continue;
      const lastWord = /([A-Za-z0-9_]+)$/.exec(before)?.[1];
      if (lastWord && !EXPRESSION_POSITION_KEYWORDS.has(lastWord.toLowerCase())) {
        continue;
      }

      const close = matchBracket(out, i, guard);
      if (close === -1) continue;

      const inner = out.slice(i + 1, close);
      // A colon at top level means this is a slice, not a list.
      if (/^[^,]*:[^=]/.test(inner)) continue;

      const items = splitTopLevel(inner, guard, i + 1);
      out = `${out.slice(0, i)}${SENTINEL.list}(${items.join(", ")})${out.slice(close + 1)}`;
      changed = true;
      break;
    }

    if (!changed) break;
  }
  return out;
}

/**
 * `{'a': 1, 'b': 2}` struct literal -> `__honey_struct('a', 1, 'b', 2)`.
 *
 * Only rewrites braces whose first entry looks like `'key':`, which is what
 * distinguishes a DuckDB struct literal from anything else brace-delimited.
 */
function rewriteStructLiterals(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 10; pass++) {
    const guard = makeGuard(out);
    let changed = false;

    for (let i = 0; i < out.length; i++) {
      if (out[i] !== "{" || guard(i)) continue;

      const close = matchBracket(out, i, guard);
      if (close === -1) continue;

      const inner = out.slice(i + 1, close).trim();
      if (!/^'/.test(inner)) continue;

      const entries = splitTopLevel(inner, makeGuard(inner), 0);
      const args: string[] = [];
      let ok = true;
      for (const entry of entries) {
        // Split on the first colon that is not inside a nested construct.
        const entryGuard = makeGuard(entry);
        let colon = -1;
        let depth = 0;
        for (let j = 0; j < entry.length; j++) {
          if (entryGuard(j)) continue;
          const ch = entry[j];
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") depth--;
          else if (ch === ":" && depth === 0) { colon = j; break; }
        }
        if (colon === -1) { ok = false; break; }
        args.push(entry.slice(0, colon).trim(), entry.slice(colon + 1).trim());
      }
      if (!ok) continue;

      out = `${out.slice(0, i)}${SENTINEL.struct}(${args.join(", ")})${out.slice(close + 1)}`;
      changed = true;
      break;
    }

    if (!changed) break;
  }
  return out;
}

/**
 * List slicing `a[1:2]` -> `__honey_slice(a, 1, 2)`.
 *
 * Open-ended bounds (`a[2:]`, `a[:3]`) become NULL, which is how DuckDB itself
 * treats a missing bound.
 */
function rewriteSlices(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 20; pass++) {
    const guard = makeGuard(out);
    let changed = false;

    for (let i = 0; i < out.length; i++) {
      if (out[i] !== "[" || guard(i)) continue;

      // Must follow a value for this to be a slice rather than a literal.
      const before = out.slice(0, i).replace(/\s+$/, "");
      if (!/[)\]"'A-Za-z0-9_]$/.test(before)) continue;
      const lastWord = /([A-Za-z0-9_]+)$/.exec(before)?.[1];
      if (lastWord && EXPRESSION_POSITION_KEYWORDS.has(lastWord.toLowerCase())) continue;

      const close = matchBracket(out, i, guard);
      if (close === -1) continue;

      const inner = out.slice(i + 1, close);
      const innerGuard = makeGuard(inner);
      let depth = 0;
      let colon = -1;
      for (let j = 0; j < inner.length; j++) {
        if (innerGuard(j)) continue;
        const ch = inner[j];
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (ch === ":" && depth === 0) { colon = j; break; }
      }
      if (colon === -1) continue;

      // Find the start of the expression being sliced.
      let start = i;
      let d = 0;
      for (let j = i - 1; j >= 0; j--) {
        const ch = out[j]!;
        if (guard(j)) { start = j; continue; }
        if (ch === ")" || ch === "]") d++;
        else if (ch === "(" || ch === "[") { if (d === 0) { start = j + 1; break; } d--; }
        else if (d === 0 && !/[A-Za-z0-9_."']/.test(ch)) { start = j + 1; break; }
        if (j === 0) start = 0;
      }

      const target = out.slice(start, i).trim();
      if (!target) continue;
      const lo = inner.slice(0, colon).trim() || "NULL";
      const hi = inner.slice(colon + 1).trim() || "NULL";
      out =
        out.slice(0, start) +
        `${SENTINEL.slice}(${target}, ${lo}, ${hi})` +
        out.slice(close + 1);
      changed = true;
      break;
    }

    if (!changed) break;
  }
  return out;
}

/**
 * Named arguments `f(x => 1)` / `f(x := 1)` -> `f(__honey_named('x', 1))`.
 */
function rewriteNamedArgs(sql: string): string {
  const guard = makeGuard(sql);
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const isArrow = sql[i] === "=" && sql[i + 1] === ">";
    const isAssign = sql[i] === ":" && sql[i + 1] === "=";
    if (!guard(i) && (isArrow || isAssign)) {
      // Preceding identifier is the parameter name.
      const nameMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(out);
      if (nameMatch) {
        out = out.slice(0, out.length - nameMatch[0].length);
        out += `${SENTINEL.namedArg}('${nameMatch[1]}', `;
        i += 2;
        // Consume the value up to the matching comma or close paren.
        let depth = 0;
        let j = i;
        for (; j < sql.length; j++) {
          if (guard(j)) continue;
          const ch = sql[j];
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) break; depth--; }
          else if (ch === "," && depth === 0) break;
        }
        out += sql.slice(i, j).trim() + ")";
        i = j;
        continue;
      }
    }
    out += sql[i];
    i++;
  }
  return out;
}

/** `TRY_CAST(x AS T)` -> `__honey_try(CAST(x AS T))`. */
function rewriteTryCast(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 20; pass++) {
    const guard = makeGuard(out);
    const match = /\bTRY_CAST\s*\(/i.exec(out);
    if (!match || guard(match.index)) break;

    const open = out.indexOf("(", match.index);
    const close = matchBracket(out, open, guard);
    if (close === -1) break;

    const inner = out.slice(open + 1, close);
    out =
      out.slice(0, match.index) +
      `${SENTINEL.tryCast}(CAST(${inner}))` +
      out.slice(close + 1);
  }
  return out;
}

/**
 * `GROUP BY ALL` / `ORDER BY ALL` -> `GROUP BY __honey_all()`.
 *
 * DuckDB shorthand for "every non-aggregated column".
 */
function rewriteByAll(sql: string): string {
  return sql.replace(
    /\b(GROUP|ORDER)\s+BY\s+ALL\b/gi,
    (m, kw: string) => `${kw} BY ${SENTINEL.all}()`
  );
}

/** `a // b` integer division -> `__honey_idiv(a, b)` is not safely expressible
 * textually, so we only normalise `==` here, which is a pure synonym for `=`. */
function rewriteEqEq(sql: string): string {
  const guard = makeGuard(sql);
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    if (!guard(i) && sql[i] === "=" && sql[i + 1] === "=" && sql[i - 1] !== "!" && sql[i - 1] !== "<" && sql[i - 1] !== ">") {
      out += "=";
      i++;
      continue;
    }
    out += sql[i];
  }
  return out;
}

/**
 * FROM-first syntax: `FROM t SELECT a` -> `SELECT a FROM t`, and a bare
 * `FROM t WHERE ...` -> `SELECT * FROM t WHERE ...`.
 */
function rewriteFromFirst(sql: string): string {
  const trimmed = sql.trimStart();
  const lead = sql.length - trimmed.length;

  // INSERT INTO t FROM ... -> INSERT INTO t SELECT * FROM ...
  const insert = /^(INSERT\s+INTO\s+[^\s(]+(?:\s*\([^)]*\))?\s+)FROM\s+/i.exec(trimmed);
  if (insert) {
    return (
      sql.slice(0, lead) +
      insert[1] +
      "SELECT * FROM " +
      trimmed.slice(insert[0].length)
    );
  }

  if (!/^FROM\s+/i.test(trimmed)) return sql;

  const guard = makeGuard(trimmed);
  // Find a top-level SELECT after the FROM clause.
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (guard(i)) continue;
    const ch = trimmed[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /^SELECT\b/i.test(trimmed.slice(i)) && /[\s)]/.test(trimmed[i - 1] ?? " ")) {
      const fromPart = trimmed.slice(0, i).trim();
      const rest = trimmed.slice(i + "SELECT".length).trim();
      // Trailing clauses (WHERE/GROUP BY/...) stay attached to the projection.
      return `${sql.slice(0, lead)}SELECT ${rest} ${fromPart}`;
    }
  }

  // No SELECT at all: `FROM t WHERE x` means `SELECT * FROM t WHERE x`.
  return `${sql.slice(0, lead)}SELECT * ${trimmed}`;
}

/**
 * Aggregate ORDER BY: `list(v ORDER BY v)` -> `__honey_agg_order(list(v), v)`.
 *
 * PostgreSQL supports this syntax but pgsql-ast-parser does not.
 */
function rewriteAggOrderBy(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 20; pass++) {
    const guard = makeGuard(out);
    let changed = false;

    // Find `IDENT(` then look for a top-level ORDER BY inside the parens.
    const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(out)) !== null) {
      const open = m.index + m[0].length - 1;
      if (guard(m.index)) continue;
      if (/^(ORDER|GROUP|WHERE|SELECT|FROM|OVER|FILTER)$/i.test(m[1]!)) continue;

      const close = matchBracket(out, open, guard);
      if (close === -1) continue;

      const inner = out.slice(open + 1, close);
      // A subquery argument — array(SELECT ... ORDER BY ...) — has its own
      // ORDER BY that belongs to the inner query, not to the aggregate.
      if (/^\s*(SELECT|WITH|FROM|VALUES)\b/i.test(inner)) continue;

      // Locate a top-level ORDER BY within the argument list.
      const innerGuard = makeGuard(inner);
      let depth = 0;
      let orderAt = -1;
      for (let j = 0; j < inner.length; j++) {
        if (innerGuard(j)) continue;
        const ch = inner[j];
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (depth === 0 && /^ORDER\s+BY\b/i.test(inner.slice(j))) { orderAt = j; break; }
      }
      if (orderAt === -1) continue;

      const args = inner.slice(0, orderAt).trim().replace(/,\s*$/, "");
      const orderBy = inner.slice(orderAt).replace(/^ORDER\s+BY\s*/i, "").trim();

      // `val DESC` is not valid in argument position, so each ORDER BY item is
      // wrapped with its direction carried as a string argument.
      const orderItems = splitTopLevel(orderBy, makeGuard(orderBy), 0).map((item) => {
        const dir = /\s+(ASC|DESC)\s*(NULLS\s+(FIRST|LAST))?$/i.exec(item);
        if (!dir) return `${SENTINEL.orderItem}(${item}, 'asc')`;
        const expr = item.slice(0, dir.index).trim();
        return `${SENTINEL.orderItem}(${expr}, '${dir[1]!.toLowerCase()}')`;
      });

      out =
        out.slice(0, m.index) +
        `${SENTINEL.aggOrder}(${m[1]}(${args}), ${orderItems.join(", ")})` +
        out.slice(close + 1);
      changed = true;
      break;
    }

    if (!changed) break;
  }
  return out;
}

/**
 * Rewrite DuckDB-only syntax into PostgreSQL-parseable text.
 *
 * Order matters: literals are rewritten before clause-level reordering so the
 * scanner never has to reason about half-rewritten text.
 */
export function preprocessDuckDb(sql: string): string {
  let out = sql;
  out = rewriteEqEq(out);
  out = rewriteTryCast(out);
  out = rewriteNamedArgs(out);
  out = rewriteStructLiterals(out);
  // Slices before literals: both start at `[`, and slicing is the narrower case.
  out = rewriteSlices(out);
  out = rewriteListLiterals(out);
  out = rewriteAggOrderBy(out);
  out = rewriteByAll(out);
  out = rewriteFromFirst(out);
  return out;
}

// ===========================================================================
// Post-parse revival
// ===========================================================================

/**
 * Turn sentinel function calls in a parsed clause map back into honey-ts's
 * native DuckDB constructs, so the result is indistinguishable from what a
 * DuckDB-native parser would have produced.
 */
export function reviveSentinels(value: unknown): unknown {
  if (Array.isArray(value)) {
    const head = value[0];
    const revivedArgs = value.slice(1).map(reviveSentinels) as SqlExpr[];

    // A non-string head is a nested expression (e.g. the sole item of a select
    // list), and must be revived too — not passed through untouched.
    if (typeof head !== "string") {
      return [reviveSentinels(head), ...revivedArgs];
    }

    if (typeof head === "string") {
      const name = head.startsWith("%") ? head.slice(1) : head;

      switch (name.toLowerCase()) {
        case SENTINEL.list:
          return ["list", ...revivedArgs];

        case SENTINEL.struct: {
          const pairs: SqlExpr[] = [];
          for (let i = 0; i < revivedArgs.length; i += 2) {
            const key = revivedArgs[i];
            // Keys arrive as inlined constants, e.g. {v: "a"}.
            const keyName =
              key && typeof key === "object" && "v" in (key as object)
                ? String((key as { v: unknown }).v)
                : String(key);
            pairs.push([keyName, revivedArgs[i + 1]!] as unknown as SqlExpr);
          }
          return ["struct", ...pairs];
        }

        case SENTINEL.tryCast: {
          const inner = revivedArgs[0];
          if (Array.isArray(inner) && inner[0] === "cast") {
            return ["try-cast", inner[1], inner[2]];
          }
          return ["try-cast", inner];
        }

        case SENTINEL.aggOrder:
          return ["agg-order-by", revivedArgs[0]!, revivedArgs.slice(1)];

        case SENTINEL.orderItem: {
          // ["__honey_ob", expr, {v:"desc"}] -> [expr, "desc"], the shape the
          // agg-order-by emitter expects.
          const dir = revivedArgs[1];
          const dirName =
            dir && typeof dir === "object" && "v" in (dir as object)
              ? String((dir as { v: unknown }).v)
              : String(dir);
          return [revivedArgs[0]!, dirName];
        }

        case SENTINEL.slice:
          return ["slice", revivedArgs[0]!, revivedArgs[1]!, revivedArgs[2]!];

        case SENTINEL.namedArg: {
          const key = revivedArgs[0];
          const keyName =
            key && typeof key === "object" && "v" in (key as object)
              ? String((key as { v: unknown }).v)
              : String(key);
          return ["named-arg", keyName, revivedArgs[1]!];
        }

        case SENTINEL.all:
          // GROUP BY ALL / ORDER BY ALL — a bare keyword, not a column named
          // "all", so it must not go through identifier quoting.
          return { __raw: "ALL" };
      }
    }

    return [head, ...revivedArgs] as unknown;
  }

  if (isClause(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as SqlClause)) {
      out[k] = reviveSentinels(v);
    }
    return out;
  }

  return value;
}
