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
  map: "__honey_map",
  tryCast: "__honey_try",
  idiv: "__honey_idiv",
  aggOrder: "__honey_agg_order",
  orderItem: "__honey_ob",
  all: "__honey_all",
  slice: "__honey_slice",
  namedArg: "__honey_named",
  collate: "__honey_collate",
  ignoreNulls: "__honey_ignore_nulls",
  respectNulls: "__honey_respect_nulls",
  subqueryAlias: "__hsq",
  lambda: "__honey_lambda",
  exportState: "__honey_export_state",
  field: "__honey_field",
  num: "__honey_num",
  star: "__honey_star",
  starExclude: "__honey_star_exclude",
  starReplace: "__honey_star_replace",
  starReplaceItem: "__honey_star_ri",
  frame: "__honey_frame",
  groupingSets: "__honey_grouping_sets",
  groupingSet: "__honey_gs",
  joinMark: "__honey_jm",
  qualify: "__honey_qualify",
  sample: "__honey_sample",
  insReplace: "__honey_ins_replace",
  insIgnore: "__honey_ins_ignore",
  insByName: "__honey_ins_by_name",
  stmt: "__honey_stmt",
} as const;

/** Escape a string for embedding as a single-quoted SQL literal. */
function q(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** Clause keywords that terminate an expression captured mid-statement. */
const CLAUSE_BOUNDARY =
  /^(WHERE|GROUP|HAVING|WINDOW|QUALIFY|ORDER|LIMIT|OFFSET|FETCH|UNION|EXCEPT|INTERSECT|RETURNING|USING|ON\s+CONFLICT|FOR)\b/i;

/**
 * Find where a clause-level expression ends: the next top-level clause
 * keyword, statement-level closer, or end of text. `start` is an index into
 * `sql`; returns an exclusive end index.
 */
function findClauseEnd(
  sql: string,
  start: number,
  guard: (i: number) => boolean
): number {
  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    if (guard(i)) continue;
    const ch = sql[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (ch === ";" && depth === 0) return i;
    else if (depth === 0 && /[A-Za-z]/.test(ch) && /[\s)]/.test(sql[i - 1] ?? " ")) {
      if (CLAUSE_BOUNDARY.test(sql.slice(i))) return i;
    }
  }
  return sql.length;
}

/**
 * Walk backwards from an open position to find the start of the primary
 * expression that ends there: absorbs one balanced paren/bracket group plus
 * any directly-attached identifier chain (function name, qualified name).
 */
function exprStartBackwards(
  sql: string,
  end: number,
  guard: (i: number) => boolean
): number {
  let i = end - 1;
  // Skip trailing whitespace.
  while (i >= 0 && /\s/.test(sql[i]!)) i--;
  if (i < 0) return 0;

  // A string literal: jump to the start of its protected span.
  if (sql[i] === "'") {
    const spans = protectedSpans(sql);
    const span = spans.find((s) => i >= s.start && i < s.end);
    if (span) return span.start;
  }

  if (sql[i] === ")" || sql[i] === "]" || sql[i] === "}") {
    // Balanced group.
    let depth = 0;
    for (; i >= 0; i--) {
      if (guard(i)) continue;
      const ch = sql[i]!;
      if (ch === ")" || ch === "]" || ch === "}") depth++;
      else if (ch === "(" || ch === "[" || ch === "{") {
        depth--;
        if (depth === 0) { i--; break; }
      }
    }
    // Directly-attached name (function call / qualified identifier).
    while (i >= 0 && /[\w".]/.test(sql[i]!)) i--;
    return i + 1;
  }

  // Identifier / literal chain.
  while (i >= 0 && /[\w".$]/.test(sql[i]!)) i--;
  return i + 1;
}

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

/**
 * True when `index` falls inside a string, identifier, or comment.
 * Exported for the statement mini-parser; internal API.
 */
export function makeGuard(sql: string): (index: number) => boolean {
  const spans = protectedSpans(sql);
  return (index: number) => spans.some((s) => index >= s.start && index < s.end);
}

/**
 * Find the index of the bracket matching the opener at `open`, skipping
 * protected spans and honouring nesting.
 */
export function matchBracket(
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
export function splitTopLevel(sql: string, guard: (i: number) => boolean, offset: number): string[] {
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
 * Strip SQL comments. pgsql-ast-parser cannot tokenize block comments
 * containing `{`, `}` or an unpaired quote — all valid SQL — and comments
 * carry no meaning for the clause map, so the DuckDB path removes them
 * entirely. Runs first; the scanner already knows a `/*` inside a string or
 * dollar-quote is not a comment.
 */
function rewriteStripComments(sql: string): string {
  const spans = protectedSpans(sql).filter(
    (s) => sql.startsWith("--", s.start) || sql.startsWith("/*", s.start)
  );
  if (spans.length === 0) return sql;
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    out += sql.slice(cursor, s.start) + " ";
    cursor = s.end;
  }
  return out + sql.slice(cursor);
}

/**
 * Dollar-quoted strings `$$text$$` / `$tag$text$tag$` -> standard
 * single-quoted literals. Content is copied verbatim with `'` doubled; the
 * quoting *style* is the only thing lost.
 */
function rewriteDollarQuotes(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (open && !makeGuardExceptDollar(sql)(i)) {
      const tag = open[0];
      const close = sql.indexOf(tag, i + tag.length);
      if (close !== -1) {
        out += q(sql.slice(i + tag.length, close));
        i = close + tag.length;
        continue;
      }
    }
    out += sql[i];
    i++;
  }
  return out;
}

/**
 * Guard that protects strings, identifiers and comments but NOT dollar-quoted
 * spans — used by the dollar-quote rewrite, which must be allowed to stand on
 * the `$tag$` opener it is rewriting.
 */
function makeGuardExceptDollar(sql: string): (i: number) => boolean {
  const spans = protectedSpans(sql).filter((s) => sql[s.start] !== "$");
  return (index: number) => spans.some((s) => index >= s.start && index < s.end);
}

/**
 * `AS [NOT] MATERIALIZED (` -> `AS (`.
 *
 * The materialization hint changes CTE evaluation strategy, never results;
 * pgsql-ast-parser predates it. Dropping it is the one deliberately lossy
 * rewrite in this file.
 */
function rewriteMaterialized(sql: string): string {
  const guard = makeGuard(sql);
  return sql.replace(/\bAS\s+(NOT\s+)?MATERIALIZED\s*\(/gi, (m, _not, offset) =>
    guard(offset) ? m : "AS ("
  );
}

/**
 * CTE column aliases: `WITH c(a, b) AS (body)` ->
 * `WITH c AS (SELECT * FROM (body) AS __honey_ctecols(a, b))`.
 *
 * pgsql-ast-parser cannot parse the alias list, but honey-ts already
 * round-trips derived-table column aliases, so the rewrite reuses that path.
 * Semantically identical; the normalized shape is what round-trips.
 */
function rewriteCteColumnAliases(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 20; pass++) {
    const guard = makeGuard(out);
    const re = /\b(WITH\s+(?:RECURSIVE\s+)?|,\s*)([A-Za-z_][\w]*|"[^"]+")\s*\(([^()]+)\)\s+AS\s*\(/gi;
    let m: RegExpExecArray | null;
    let changed = false;
    while ((m = re.exec(out)) !== null) {
      if (guard(m.index)) continue;
      // `, name(cols) AS (` must be a CTE list comma, not a function arg —
      // require the match to be at depth 0 relative to the statement.
      const before = out.slice(0, m.index);
      let depth = 0;
      const beforeGuard = makeGuard(before);
      for (let i = 0; i < before.length; i++) {
        if (beforeGuard(i)) continue;
        if (before[i] === "(") depth++;
        else if (before[i] === ")") depth--;
      }
      if (depth !== 0) continue;

      const bodyOpen = m.index + m[0].length - 1;
      const bodyClose = matchBracket(out, bodyOpen, guard);
      if (bodyClose === -1) continue;

      const body = out.slice(bodyOpen + 1, bodyClose);
      out =
        out.slice(0, m.index) +
        `${m[1]}${m[2]} AS (SELECT * FROM (${body}) AS __honey_ctecols(${m[3]}))` +
        out.slice(bodyClose + 1);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * Python-style lambda syntax: `lambda x, y : body` ->
 * `__honey_lambda('x,y', body)`. This form is unambiguous (the keyword), so
 * unlike arrow lambdas it can be rewritten anywhere it appears.
 */
function rewriteLambdaKeyword(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 30; pass++) {
    const guard = makeGuard(out);
    const re = /\blambda\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:/gi;
    const m = re.exec(out);
    if (!m || guard(m.index)) break;

    const bodyStart = m.index + m[0].length;
    // Body runs to the enclosing call's next top-level comma or close paren.
    let depth = 0;
    let end = out.length;
    for (let i = bodyStart; i < out.length; i++) {
      if (guard(i)) continue;
      const ch = out[i]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) { end = i; break; }
        depth--;
      } else if (ch === "," && depth === 0) { end = i; break; }
    }

    const params = m[1]!.replace(/\s+/g, "");
    const body = out.slice(bodyStart, end).trim();
    out =
      out.slice(0, m.index) +
      `${SENTINEL.lambda}(${q(params)}, ${body})` +
      out.slice(end);
  }
  return out;
}

/**
 * Named WINDOW clauses: `... WINDOW w AS (def) ... OVER w` — pgsql-ast-parser
 * has no WINDOW clause, so each definition is expanded inline into its OVER
 * references and the clause removed. Semantically identical; the inline shape
 * is what round-trips.
 */
function rewriteWindowClause(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 10; pass++) {
    const guard = makeGuard(out);
    const m = /\bWINDOW\s+([A-Za-z_]\w*|"[^"]+")\s+AS\s*\(/gi.exec(out);
    if (!m || guard(m.index)) break;

    // Collect the full comma-separated definition list.
    const defs = new Map<string, string>();
    let cursor = m.index + "WINDOW".length;
    let clauseEnd = cursor;
    for (;;) {
      const defM = /^\s*([A-Za-z_]\w*|"[^"]+")\s+AS\s*\(/i.exec(out.slice(cursor));
      if (!defM) break;
      const open = cursor + defM[0].length - 1;
      const close = matchBracket(out, open, guard);
      if (close === -1) return out;
      defs.set(defM[1]!.replace(/"/g, ""), out.slice(open + 1, close));
      clauseEnd = close + 1;
      const after = /^\s*,/.exec(out.slice(clauseEnd));
      if (!after) break;
      cursor = clauseEnd + after[0].length;
    }
    if (defs.size === 0) break;

    // Definitions may reference earlier windows: `w2 AS (w1 ORDER BY b)`.
    for (const [name, def] of defs) {
      const head = /^\s*([A-Za-z_]\w*)\b/.exec(def);
      if (head && defs.has(head[1]!)) {
        defs.set(name, def.replace(head[1]!, defs.get(head[1]!)!));
      }
    }

    // Remove the WINDOW clause, then expand OVER references.
    out = out.slice(0, m.index) + out.slice(clauseEnd);
    for (const [name, def] of defs) {
      out = out
        .replace(new RegExp(`\\bOVER\\s+${name}\\b`, "gi"), `OVER (${def})`)
        .replace(new RegExp(`\\bOVER\\s*\\(\\s*${name}\\s*\\)`, "gi"), `OVER (${def})`);
    }
  }
  return out;
}

/**
 * Window frames: `OVER (ORDER BY a ROWS BETWEEN ... [EXCLUDE ...])`.
 * pgsql-ast-parser cannot parse frame specifications at all, so the frame text
 * is carried through the parse as a marker expression prepended to PARTITION
 * BY (a constant partition key changes nothing), then moved onto the window
 * spec by reviveSentinels.
 */
function rewriteFrames(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 30; pass++) {
    const guard = makeGuard(out);
    const over = /\bOVER\s*\(/gi;
    let m: RegExpExecArray | null;
    let changed = false;
    while ((m = over.exec(out)) !== null) {
      if (guard(m.index)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchBracket(out, open, guard);
      if (close === -1) continue;

      const inner = out.slice(open + 1, close);
      const frameM = /\b(ROWS|RANGE|GROUPS)\s+(BETWEEN\b|UNBOUNDED\b|CURRENT\b|\d|INTERVAL\b|')/i.exec(inner);
      if (!frameM) continue;
      // Only a top-level frame keyword counts (not one inside a nested paren).
      const innerGuard = makeGuard(inner);
      let depth = 0;
      let topLevel = true;
      for (let i = 0; i < frameM.index; i++) {
        if (innerGuard(i)) continue;
        if (inner[i] === "(") depth++;
        else if (inner[i] === ")") depth--;
      }
      if (depth !== 0) topLevel = false;
      if (!topLevel) continue;

      const frameText = inner.slice(frameM.index).trim();
      const kept = inner.slice(0, frameM.index).trim().replace(/,\s*$/, "");
      const marker = `${SENTINEL.frame}(${q(frameText)})`;

      let rebuilt: string;
      if (/\bPARTITION\s+BY\b/i.test(kept)) {
        rebuilt = kept.replace(/\bPARTITION\s+BY\b/i, `PARTITION BY ${marker},`);
      } else {
        rebuilt = `PARTITION BY ${marker}${kept ? " " + kept : ""}`;
      }
      out = out.slice(0, open + 1) + rebuilt + out.slice(close);
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

/**
 * `agg(args) EXPORT_STATE` -> `__honey_export_state(agg(args))`.
 * DuckDB suffix that makes an aggregate return its intermediate state.
 */
function rewriteExportState(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 30; pass++) {
    const guard = makeGuard(out);
    const m = /\bEXPORT_STATE\b/i.exec(out);
    if (!m || guard(m.index)) break;
    const start = exprStartBackwards(out, m.index, guard);
    const call = out.slice(start, m.index).trim();
    if (!call.endsWith(")")) {
      // Not a call suffix we understand; leave it (and stop, to avoid looping).
      break;
    }
    out =
      out.slice(0, start) +
      `${SENTINEL.exportState}(${call})` +
      out.slice(m.index + m[0].length);
  }
  return out;
}

/**
 * `MAP {'k': v, ...}` -> `__honey_map('k', v, ...)`.
 * Runs before the struct rewrite so the braces are consumed as a map.
 */
function rewriteMapLiteral(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 20; pass++) {
    const guard = makeGuard(out);
    const m = /\bMAP\s*\{/gi.exec(out);
    if (!m || guard(m.index)) break;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(out, open, guard);
    if (close === -1) break;

    const inner = out.slice(open + 1, close);
    const args = splitStructEntries(inner);
    if (!args) break;
    out =
      out.slice(0, m.index) +
      `${SENTINEL.map}(${args.join(", ")})` +
      out.slice(close + 1);
  }
  return out;
}

/**
 * Split `{k: v, k2: v2}` body text into a flat [k, v, k2, v2] argument list,
 * or null when an entry has no top-level colon. Shared by struct and map.
 */
function splitStructEntries(inner: string): string[] | null {
  const entries = splitTopLevel(inner, makeGuard(inner), 0);
  const args: string[] = [];
  for (const entry of entries) {
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
    if (colon === -1) return null;
    args.push(entry.slice(0, colon).trim(), entry.slice(colon + 1).trim());
  }
  return args;
}

/**
 * Composite type names in cast position — `::STRUCT(a INT)`, `::MAP(K, V)`,
 * `::UNION(...)`, `::ENUM(...)`, `::INT[3]`, `::VARCHAR[][]` — are quoted so
 * pgsql-ast-parser sees a single (double-quoted) type token. The cast emitter
 * prints type names containing structure verbatim, so the text survives
 * unchanged. Applies to both `::T` and `CAST(x AS T)` spellings.
 */
function rewriteComplexCastTypes(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 40; pass++) {
    const guard = makeGuard(out);
    let changed = false;

    // ::STRUCT(...) / AS STRUCT(...) — composite heads with a paren body.
    const comp = /(::\s*|\bAS\s+)(STRUCT|MAP|UNION|ENUM|DECIMAL|NUMERIC)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = comp.exec(out)) !== null) {
      if (guard(m.index)) continue;
      // DECIMAL/NUMERIC(p,s) parse fine upstream — only quote them when the
      // body is not a plain precision list (e.g. nested inside STRUCT they
      // never reach here on their own).
      const open = m.index + m[0].length - 1;
      const close = matchBracket(out, open, guard);
      if (close === -1) continue;
      const head = m[2]!.toUpperCase();
      const body = out.slice(open + 1, close);
      if ((head === "DECIMAL" || head === "NUMERIC") && /^[\d\s,]*$/.test(body)) {
        continue;
      }
      // Trailing array suffixes belong to the type: STRUCT(...)[]
      let end = close + 1;
      const arr = /^(\s*\[\s*\d*\s*\])+/.exec(out.slice(end));
      if (arr) end += arr[0].length;

      const typeText = out.slice(m.index + m[1]!.length, end);
      out =
        out.slice(0, m.index) +
        m[1] +
        `"${typeText.replace(/"/g, '""')}"` +
        out.slice(end);
      changed = true;
      break;
    }
    if (changed) continue;

    // ::INT[3] / ::VARCHAR[][] — array suffixes with a size or multiple dims,
    // which upstream cannot parse (plain [] works).
    const arrT = /::\s*([A-Za-z_]\w*)((\s*\[\s*\d*\s*\]){1,})/g;
    while ((m = arrT.exec(out)) !== null) {
      if (guard(m.index)) continue;
      const suffix = m[2]!;
      // Plain single [] parses upstream; leave it alone.
      if (/^\s*\[\s*\]\s*$/.test(suffix) && !/\]\s*\[/.test(suffix)) continue;
      const typeText = (m[1]! + suffix).replace(/"/g, '""');
      out =
        out.slice(0, m.index) +
        `::"${typeText}"` +
        out.slice(m.index + m[0].length);
      changed = true;
      break;
    }

    if (!changed) break;
  }
  return out;
}

/**
 * Struct field access `(expr).name` / `call(args).name` ->
 * `__honey_field(expr, 'name')`. Valid PostgreSQL composite syntax that
 * pgsql-ast-parser lacks. Chains resolve inside-out across passes.
 */
function rewriteFieldAccess(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 40; pass++) {
    const guard = makeGuard(out);
    const re = /\)\s*\.\s*([A-Za-z_]\w*|"[^"]+")/g;
    let m: RegExpExecArray | null;
    let changed = false;
    while ((m = re.exec(out)) !== null) {
      if (guard(m.index)) continue;
      const start = exprStartBackwards(out, m.index + 1, guard);
      const target = out.slice(start, m.index + 1).trim();
      if (!target) continue;
      // A bare paren group like `(a, b).x` or a call — both are field access.
      // But `... FROM (SELECT ...).x` is not a thing; subqueries never take
      // field access directly, and a SELECT head inside the parens means this
      // is a scalar-subquery member access DuckDB spells the same way — treat
      // it identically.
      const fieldName = m[1]!.replace(/^"|"$/g, "").replace(/""/g, '"');
      out =
        out.slice(0, start) +
        `${SENTINEL.field}(${target}, ${q(fieldName)})` +
        out.slice(m.index + m[0].length);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * Scientific-notation literals with an exponent sign (`1.5e-3`, `1E+10`) fail
 * upstream; rewrite every exponent literal to `__honey_num('...')`, revived
 * to a plain numeric constant.
 */
function rewriteScientific(sql: string): string {
  const guard = makeGuard(sql);
  return sql.replace(
    /(^|[^\w.])((?:\d+\.?\d*|\.\d+)[eE][-+]?\d+)/g,
    (whole, pre: string, num: string, offset: number) =>
      guard(offset + pre.length) ? whole : `${pre}${SENTINEL.num}(${q(num)})`
  );
}

/**
 * `INTERVAL 5 SECOND` (DuckDB spelling) -> `INTERVAL '5 SECOND'`, which parses
 * upstream as a cast to interval and round-trips as
 * `CAST('5 SECOND' AS INTERVAL)` — same value in both dialects. The
 * expression form `INTERVAL (r) SECOND` becomes `(r) * INTERVAL '1 SECOND'`,
 * which is value-identical.
 *
 * (`INTERVAL (5) SECOND` also *parses* upstream unrewritten, but as a function
 * call INTERVAL(5) aliased "second" — syntax-valid, meaning-destroying.)
 */
function rewriteIntervalUnit(sql: string): string {
  const guard = makeGuard(sql);
  let out = sql.replace(
    /\bINTERVAL\s+(\d+(?:\.\d+)?)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR|MILLISECOND|MICROSECOND)S?\b/gi,
    (m, n: string, unit: string, offset: number) =>
      guard(offset) ? m : `INTERVAL '${n} ${unit.toUpperCase()}'`
  );

  // Expression operand: INTERVAL (expr) UNIT.
  for (let pass = 0; pass < 20; pass++) {
    const g = makeGuard(out);
    const m = /\bINTERVAL\s*\(/gi.exec(out);
    if (!m || g(m.index)) break;
    const open = out.indexOf("(", m.index);
    const close = matchBracket(out, open, g);
    if (close === -1) break;
    const unitM = /^\s*(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR|MILLISECOND|MICROSECOND)S?\b/i.exec(out.slice(close + 1));
    if (!unitM) break;
    const expr = out.slice(open + 1, close);
    out =
      out.slice(0, m.index) +
      `(${expr}) * INTERVAL '1 ${unitM[1]!.toUpperCase()}'` +
      out.slice(close + 1 + unitM[0].length);
  }
  return out;
}

/**
 * `expr COLLATE name` -> `__honey_collate(expr, 'name')`. Valid in both
 * dialects; pgsql-ast-parser simply lacks the production.
 */
function rewriteCollate(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 30; pass++) {
    const guard = makeGuard(out);
    const m = /\bCOLLATE\s+([A-Za-z_][\w.]*|"[^"]+")/gi.exec(out);
    if (!m || guard(m.index)) break;
    const start = exprStartBackwards(out, m.index, guard);
    const target = out.slice(start, m.index).trim();
    if (!target) break;
    const collation = m[1]!.replace(/^"|"$/g, "");
    out =
      out.slice(0, start) +
      `${SENTINEL.collate}(${target}, ${q(collation)})` +
      out.slice(m.index + m[0].length);
  }
  return out;
}

/**
 * `agg(x IGNORE NULLS)` / `agg(x RESPECT NULLS)` -> a sentinel wrap around the
 * argument; DuckDB-only aggregate modifier.
 */
function rewriteNullsModifier(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 20; pass++) {
    const guard = makeGuard(out);
    const m = /\s+(IGNORE|RESPECT)\s+NULLS\s*\)/gi.exec(out);
    if (!m || guard(m.index)) break;
    const sentinel = m[1]!.toUpperCase() === "IGNORE" ? SENTINEL.ignoreNulls : SENTINEL.respectNulls;
    // Wrap the argument expression that precedes the modifier.
    const start = exprStartBackwards(out, m.index + 1, guard);
    const arg = out.slice(start, m.index).trim();
    if (!arg) break;
    out =
      out.slice(0, start) +
      `${sentinel}(${arg})` +
      ")" +
      out.slice(m.index + m[0].length);
  }
  return out;
}

/**
 * Derived tables without an alias: `FROM (SELECT ...)` — mandatory alias in
 * PostgreSQL, optional in DuckDB. A numbered `__hsqN` alias is injected for
 * the parse and stripped again by reviveSentinels, so the clause map and the
 * emitted SQL never see it.
 */
function rewriteUnaliasedSubqueries(sql: string): string {
  let out = sql;
  let counter = 0;
  for (let pass = 0; pass < 50; pass++) {
    const guard = makeGuard(out);
    const re = /(\bFROM\s*|\bJOIN\s*|,\s*)\(/gi;
    let m: RegExpExecArray | null;
    let changed = false;
    while ((m = re.exec(out)) !== null) {
      const open = m.index + m[0].length - 1;
      if (guard(open)) continue;
      // Only derived tables (statement heads), not expression parens.
      if (!/^\s*(SELECT|VALUES|WITH|FROM)\b/i.test(out.slice(open + 1))) continue;
      const close = matchBracket(out, open, guard);
      if (close === -1) continue;
      // Already aliased? (AS name, bare name, or name(cols)). SELECT/VALUES
      // after the group is FROM-first tail syntax, not an alias.
      const after = out.slice(close + 1);
      if (/^\s*(AS\b|[A-Za-z_"]|\()/.test(after) && !/^\s*(WHERE|GROUP|HAVING|WINDOW|QUALIFY|ORDER|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT|USING|ON|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|SEMI|ANTI|ASOF|POSITIONAL|RETURNING|FOR|SELECT|VALUES)\b/i.test(after)) {
        continue;
      }
      // `, (` in a FROM list only; a comma inside a select list is depth>0
      // relative to the statement, which the FROM/JOIN alternatives don't hit.
      // For the comma form, require it to be at clause depth 0.
      if (m[1]!.startsWith(",")) {
        const before = out.slice(0, m.index);
        const bg = makeGuard(before);
        let depth = 0;
        for (let i = 0; i < before.length; i++) {
          if (bg(i)) continue;
          if (before[i] === "(") depth++;
          else if (before[i] === ")") depth--;
        }
        if (depth !== 0) continue;
        // And a FROM must be somewhere behind us at depth 0.
        if (!/\bFROM\b/i.test(before)) continue;
      }
      out =
        out.slice(0, close + 1) +
        ` AS ${SENTINEL.subqueryAlias}${counter++}` +
        out.slice(close + 1);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * Functions whose signatures take a LAMBDA-typed parameter, per DuckDB's own
 * catalog (duckdb_functions()). An arrow (`x -> body`) is rewritten as a
 * lambda ONLY in argument position of one of these — everywhere else `->`
 * keeps its PostgreSQL/DuckDB meaning of JSON extraction. duckdb.test.ts pins
 * this list against the generated catalog so a DuckDB upgrade that adds
 * lambda functions fails the test rather than silently missing them.
 */
export const LAMBDA_FUNCTIONS: ReadonlySet<string> = new Set([
  "array_transform", "list_transform", "apply", "array_apply", "list_apply",
  "array_filter", "list_filter", "filter",
  "array_reduce", "list_reduce", "reduce",
  "list_has_all_lambda", "list_has_any_lambda",
  // COLUMNS(...) is grammar rather than a catalog function, but its argument
  // is a lambda in the same way.
  "columns",
]);

const LAMBDA_PARAM =
  /^\s*([A-Za-z_]\w*|\(\s*[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*\))\s*->/;

/**
 * Arrow lambdas `x -> body` inside lambda-taking function calls ->
 * `__honey_lambda('x', body)`. See LAMBDA_FUNCTIONS for the disambiguation
 * contract with the JSON `->` operator.
 */
function rewriteArrowLambdas(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 40; pass++) {
    const guard = makeGuard(out);
    const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    let changed = false;

    while ((m = callRe.exec(out)) !== null) {
      if (guard(m.index) || !LAMBDA_FUNCTIONS.has(m[1]!.toLowerCase())) continue;
      const open = m.index + m[0].length - 1;
      const close = matchBracket(out, open, guard);
      if (close === -1) continue;

      const inner = out.slice(open + 1, close);
      const args = splitTopLevel(inner, makeGuard(inner), 0);
      let rewrote = false;
      const newArgs = args.map((arg) => {
        const lam = LAMBDA_PARAM.exec(arg);
        if (!lam) return arg;
        const params = lam[1]!.replace(/[()\s]/g, "");
        const body = arg.slice(lam[0].length).trim();
        rewrote = true;
        return `${SENTINEL.lambda}(${q(params)}, ${body})`;
      });
      if (!rewrote) continue;

      out = out.slice(0, open + 1) + newArgs.join(", ") + out.slice(close);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * Star modifiers in select lists: `* EXCLUDE (a, b)`, `* REPLACE (e AS n)`,
 * `t.* EXCLUDE c` -> `__honey_star('t', __honey_star_exclude(...), ...)`.
 *
 * EXCLUDE also appears in window frames (EXCLUDE CURRENT ROW / TIES / GROUP /
 * NO OTHERS) — those forms never take a parenthesized column list directly
 * after a `*`, and frames are rewritten into markers before this runs, so the
 * star match cannot collide with them.
 */
function rewriteStarModifiers(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 20; pass++) {
    const guard = makeGuard(out);
    const re = /((?:[A-Za-z_]\w*|"[^"]+")\s*\.\s*)?\*\s+(EXCLUDE|REPLACE)\b/gi;
    let m: RegExpExecArray | null;
    let changed = false;

    while ((m = re.exec(out)) !== null) {
      if (guard(m.index)) continue;
      // `COUNT(*)`-style: a star directly inside a call is not a select star.
      const before = out.slice(0, m.index).replace(/\s+$/, "");
      if (before.endsWith("(")) continue;

      const table = m[1] ? m[1].replace(/[.\s]+$/, "").replace(/^"|"$/g, "") : null;
      let cursor = m.index + m[0].length - m[2]!.length;
      const parts: string[] = [];

      // Consume EXCLUDE/REPLACE groups in either order.
      for (;;) {
        const kw = /^\s*(EXCLUDE|REPLACE)\b/i.exec(out.slice(cursor));
        if (!kw) break;
        const kind = kw[1]!.toUpperCase();
        let segStart = cursor + kw[0].length;
        let items: string[];
        const parenM = /^\s*\(/.exec(out.slice(segStart));
        let segEnd: number;
        if (parenM) {
          const open = segStart + parenM[0].length - 1;
          const close = matchBracket(out, open, guard);
          if (close === -1) return out;
          items = splitTopLevel(out.slice(open + 1, close), guard, open + 1);
          segEnd = close + 1;
        } else {
          // Bare form: a single item running to the next clause keyword,
          // comma, or EXCLUDE/REPLACE keyword.
          let depth = 0;
          let end = out.length;
          for (let i = segStart; i < out.length; i++) {
            if (guard(i)) continue;
            const ch = out[i]!;
            if (ch === "(" || ch === "[") depth++;
            else if (ch === ")" || ch === "]") { if (depth === 0) { end = i; break; } depth--; }
            else if (depth === 0 && (ch === "," || (/[A-Za-z]/.test(ch) && /[\s]/.test(out[i - 1] ?? "") && (CLAUSE_BOUNDARY.test(out.slice(i)) || /^(FROM|EXCLUDE|REPLACE)\b/i.test(out.slice(i)))))) { end = i; break; }
          }
          items = [out.slice(segStart, end).trim()];
          segEnd = end;
        }

        if (kind === "EXCLUDE") {
          parts.push(`${SENTINEL.starExclude}(${items.map((c) => q(c.replace(/^"|"$/g, ""))).join(", ")})`);
        } else {
          const ris = items.map((item) => {
            const asM = /\s+AS\s+([A-Za-z_]\w*|"[^"]+")\s*$/i.exec(item);
            if (!asM) return null;
            const expr = item.slice(0, asM.index).trim();
            const alias = asM[1]!.replace(/^"|"$/g, "");
            return `${SENTINEL.starReplaceItem}(${expr}, ${q(alias)})`;
          });
          if (ris.some((r) => r === null)) return out;
          parts.push(`${SENTINEL.starReplace}(${ris.join(", ")})`);
        }
        cursor = segEnd;
      }

      if (parts.length === 0) break;
      const tableArg = table ? q(table) : "NULL";
      out =
        out.slice(0, m.index) +
        `${SENTINEL.star}(${tableArg}, ${parts.join(", ")})` +
        out.slice(cursor);
      changed = true;
      break;
    }
    if (!changed) break;
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
 * `GROUP BY GROUPING SETS ((a, b), (a), ())` ->
 * `GROUP BY __honey_grouping_sets(__honey_gs(a, b), __honey_gs(a), __honey_gs())`.
 * Valid PostgreSQL that pgsql-ast-parser lacks (CUBE/ROLLUP parse upstream).
 */
function rewriteGroupingSets(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 10; pass++) {
    const guard = makeGuard(out);
    const m = /\bGROUPING\s+SETS\s*\(/gi.exec(out);
    if (!m || guard(m.index)) break;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(out, open, guard);
    if (close === -1) break;

    const sets = splitTopLevel(out.slice(open + 1, close), guard, open + 1).map(
      (s) => {
        const t = s.trim();
        if (t.startsWith("(") && t.endsWith(")")) {
          return `${SENTINEL.groupingSet}(${t.slice(1, -1)})`;
        }
        return `${SENTINEL.groupingSet}(${t})`;
      }
    );
    out =
      out.slice(0, m.index) +
      `${SENTINEL.groupingSets}(${sets.join(", ")})` +
      out.slice(close + 1);
  }
  return out;
}

/**
 * DuckDB join variants -> plain joins with a marker planted at the head of the
 * ON condition; reviveSentinels moves the entry to its own clause key.
 *
 *   ASOF JOIN u ON c        -> JOIN u ON __honey_jm('asof') AND (c)
 *   ASOF LEFT JOIN u ON c   -> LEFT JOIN u ON __honey_jm('asof') AND (c)
 *   SEMI JOIN u ON c        -> JOIN u ON __honey_jm('semi') AND (c)
 *   ANTI JOIN u ON c        -> JOIN u ON __honey_jm('anti') AND (c)
 *   POSITIONAL JOIN u       -> JOIN u ON __honey_jm('positional')
 *   ASOF JOIN u USING (a)   -> JOIN u ON __honey_jm('asof', 'using:a')
 *
 * POSITIONAL JOIN must be rewritten even though pgsql-ast-parser "accepts" the
 * text: it reads POSITIONAL as a table alias, a silent mis-parse.
 */
function rewriteJoins(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 30; pass++) {
    const guard = makeGuard(out);
    const m = /\b(ASOF|SEMI|ANTI|POSITIONAL)\s+(LEFT\s+|RIGHT\s+|FULL\s+|INNER\s+)?(OUTER\s+)?JOIN\b/gi.exec(out);
    if (!m || guard(m.index)) break;

    const variant = m[1]!.toLowerCase();
    const dir = (m[2] ?? "").trim().toUpperCase();
    const joinKw = `${dir ? dir + " " : ""}JOIN`;
    const afterJoin = m.index + m[0].length;

    // Find the joined table expression, then the ON/USING condition.
    const onM = /\b(ON|USING)\b/gi;
    onM.lastIndex = afterJoin;
    let cond: RegExpExecArray | null = null;
    // The ON belonging to THIS join is the first top-level ON after it.
    let depth = 0;
    for (let i = afterJoin; i < out.length; i++) {
      if (guard(i)) continue;
      const ch = out[i]!;
      if (ch === "(") depth++;
      else if (ch === ")") { if (depth === 0) break; depth--; }
      else if (depth === 0 && /[OoUu]/.test(ch)) {
        const rest = out.slice(i);
        if (/^(ON|USING)\b/i.test(rest) && /[\s)]/.test(out[i - 1] ?? " ")) {
          onM.lastIndex = i;
          cond = onM.exec(out);
          break;
        }
        if (/^(JOIN|WHERE|GROUP|ORDER|LIMIT|QUALIFY|UNION|SEMI|ANTI|ASOF|POSITIONAL|LEFT|RIGHT|INNER|FULL|CROSS)\b/i.test(rest)) break;
      }
    }

    const mark = (extra?: string) =>
      `${SENTINEL.joinMark}(${q(variant)}${extra ? `, ${q(extra)}` : ""})`;

    if (!cond) {
      // POSITIONAL JOIN (and bare SEMI/ANTI over comma-join corpora) — attach
      // a marker-only ON at the end of the table expression.
      let end = out.length;
      depth = 0;
      for (let i = afterJoin; i < out.length; i++) {
        if (guard(i)) continue;
        const ch = out[i]!;
        if (ch === "(") depth++;
        else if (ch === ")") { if (depth === 0) { end = i; break; } depth--; }
        else if (depth === 0 && ch === ",") { end = i; break; }
        else if (depth === 0 && /[A-Za-z]/.test(ch) && /\s/.test(out[i - 1] ?? "") &&
          (CLAUSE_BOUNDARY.test(out.slice(i)) || /^(JOIN|LEFT|RIGHT|INNER|FULL|CROSS|SEMI|ANTI|ASOF|POSITIONAL)\b/i.test(out.slice(i)))) { end = i; break; }
      }
      out =
        out.slice(0, m.index) + joinKw + out.slice(afterJoin, end).replace(/\s+$/, "") +
        ` ON ${mark()} ` + out.slice(end);
      continue;
    }

    if (cond[0].toUpperCase() === "USING") {
      const open = out.indexOf("(", cond.index);
      const close = matchBracket(out, open, guard);
      if (close === -1) break;
      const cols = out.slice(open + 1, close).replace(/\s+/g, "");
      out =
        out.slice(0, m.index) + joinKw + out.slice(afterJoin, cond.index) +
        `ON ${mark(`using:${cols}`)}` + out.slice(close + 1);
      continue;
    }

    // ON form: wrap the original condition. The condition ends at the next
    // clause keyword OR the next join keyword — findClauseEnd alone would
    // swallow a following `SEMI JOIN ...` into the wrapped parentheses.
    const condStart = cond.index + cond[0].length;
    let condEnd = findClauseEnd(out, condStart, guard);
    {
      let depth = 0;
      for (let i = condStart; i < condEnd; i++) {
        if (guard(i)) continue;
        const ch = out[i]!;
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        else if (
          depth === 0 &&
          /[A-Za-z]/.test(ch) &&
          /[\s)]/.test(out[i - 1] ?? " ") &&
          /^(JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|NATURAL\s+JOIN|SEMI\s+JOIN|ANTI\s+JOIN|ASOF\s+|POSITIONAL\s+JOIN)/i.test(out.slice(i))
        ) {
          condEnd = i;
          break;
        }
      }
    }
    const orig = out.slice(condStart, condEnd).trim();
    out =
      out.slice(0, m.index) + joinKw + out.slice(afterJoin, cond.index) +
      `ON ${mark()} AND (${orig}) ` + out.slice(condEnd);
  }
  return out;
}

/**
 * INSERT statement modifiers:
 *   `INSERT OR REPLACE INTO t`  -> `INSERT INTO t (__honey_ins_replace, ...)`
 *   `INSERT OR IGNORE INTO t`   -> `INSERT INTO t (__honey_ins_ignore, ...)`
 *   `INSERT INTO t BY NAME`     -> `INSERT INTO t (__honey_ins_by_name, ...)`
 * The markers ride in the column list and are stripped by reviveSentinels.
 */
function rewriteInsertModifiers(sql: string): string {
  let out = sql;
  const guard0 = makeGuard(out);
  out = out.replace(/\bINSERT\s+OR\s+(REPLACE|IGNORE)\s+INTO\b/gi, (m, kind: string, offset: number) =>
    guard0(offset) ? m : `INSERT INTO /*${kind.toLowerCase() === "replace" ? SENTINEL.insReplace : SENTINEL.insIgnore}*/`
  );

  // `BY NAME` after the table name.
  const guard1 = makeGuard(out);
  out = out.replace(/\bBY\s+NAME\b/gi, (m, offset: number) => {
    if (guard1(offset)) return m;
    // Only INSERT's BY NAME: preceded (somewhere earlier) by INSERT INTO on
    // this statement — a set-op BY NAME follows UNION/EXCEPT/INTERSECT.
    const before = out.slice(0, offset);
    const lastInsert = before.search(/\bINSERT\s+INTO\b(?![\s\S]*\bINSERT\s+INTO\b)/i);
    const lastSetOp = Math.max(
      before.toUpperCase().lastIndexOf("UNION"),
      before.toUpperCase().lastIndexOf("EXCEPT"),
      before.toUpperCase().lastIndexOf("INTERSECT")
    );
    if (lastInsert === -1 || lastSetOp > lastInsert) return m;
    return `/*${SENTINEL.insByName}*/`;
  });

  // Materialise the markers into the column list.
  for (const [comment, markerCol] of [
    [SENTINEL.insReplace, SENTINEL.insReplace],
    [SENTINEL.insIgnore, SENTINEL.insIgnore],
    [SENTINEL.insByName, SENTINEL.insByName],
  ] as const) {
    while (out.includes(`/*${comment}*/`)) {
      const at = out.indexOf(`/*${comment}*/`);
      const cleaned = out.slice(0, at) + out.slice(at + comment.length + 4);
      // Find the table name after INSERT INTO and inject a column-list marker.
      const insM = /\bINSERT\s+INTO\s+((?:[A-Za-z_]\w*|"[^"]+")(?:\s*\.\s*(?:[A-Za-z_]\w*|"[^"]+"))*)/gi;
      let target: RegExpExecArray | null = null;
      let mm: RegExpExecArray | null;
      while ((mm = insM.exec(cleaned)) !== null) {
        if (mm.index <= at) target = mm;
        else break;
      }
      if (!target) { out = cleaned; break; }
      const afterTable = target.index + target[0].length;
      const colsM = /^\s*\(/.exec(cleaned.slice(afterTable));
      if (colsM) {
        const open = afterTable + colsM[0].length - 1;
        // Existing column list: prepend the marker. But a parenthesized SELECT
        // source also matches — only treat as a column list when the content
        // does not start with SELECT/WITH/VALUES/FROM.
        const g = makeGuard(cleaned);
        const close = matchBracket(cleaned, open, g);
        const inner = cleaned.slice(open + 1, close === -1 ? undefined : close);
        if (!/^\s*(SELECT|WITH|VALUES|FROM)\b/i.test(inner)) {
          out = cleaned.slice(0, open + 1) + `${markerCol}, ` + cleaned.slice(open + 1);
          continue;
        }
      }
      out = cleaned.slice(0, afterTable) + ` (${markerCol})` + cleaned.slice(afterTable);
    }
  }
  return out;
}

/**
 * `USING SAMPLE <spec>` -> a `__honey_sample('<spec>')` marker merged into the
 * scope's WHERE clause (created if absent); reviveSentinels lifts it onto the
 * clause map as a structured `sample` key.
 */
function rewriteUsingSample(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 20; pass++) {
    const guard = makeGuard(out);
    const m = /\bUSING\s+SAMPLE\s+/gi.exec(out);
    if (!m || guard(m.index)) break;

    const specStart = m.index + m[0].length;
    const specEnd = findClauseEnd(out, specStart, guard);
    let spec = out.slice(specStart, specEnd).trim();
    // REPEATABLE (n) belongs to the spec but findClauseEnd may include it —
    // it does, since REPEATABLE is not a clause boundary. Good.

    // Was there a WHERE at this scope before the sample?
    let whereAt = -1;
    let depth = 0;
    for (let i = m.index - 1; i >= 0; i--) {
      if (guard(i)) continue;
      const ch = out[i]!;
      if (ch === ")") depth++;
      else if (ch === "(") { if (depth === 0) break; depth--; }
      else if (depth === 0 && /[Ww]/.test(ch) && /^WHERE\b/i.test(out.slice(i)) && /[\s(]/.test(out[i - 1] ?? " ")) {
        whereAt = i;
        break;
      }
    }

    const marker = `${SENTINEL.sample}(${q(spec)})`;
    if (whereAt !== -1) {
      out = out.slice(0, m.index).replace(/\s+$/, " ") + `AND ${marker} ` + out.slice(specEnd);
    } else {
      out = out.slice(0, m.index) + `WHERE ${marker} ` + out.slice(specEnd);
    }
  }
  return out;
}

/**
 * `QUALIFY <expr>` -> a `__honey_qualify(<expr>)` marker merged into the
 * scope's HAVING when a GROUP BY exists, or its WHERE otherwise —
 * pgsql-ast-parser rejects HAVING without GROUP BY, but accepts window
 * functions inside WHERE, so the marker always has a valid home.
 * reviveSentinels splits it back out into the clause map's `qualify` key from
 * either location.
 */
function rewriteQualify(sql: string): string {
  let out = sql;
  for (let pass = 0; pass < 20; pass++) {
    const guard = makeGuard(out);
    const m = /\bQUALIFY\b/gi.exec(out);
    if (!m || guard(m.index)) break;

    const exprStart = m.index + m[0].length;
    const exprEnd = findClauseEnd(out, exprStart, guard);
    const expr = out.slice(exprStart, exprEnd).trim();
    const marker = `${SENTINEL.qualify}(${expr})`;

    // Find a same-scope clause to merge into, scanning backwards at depth 0.
    let havingAt = -1;
    let groupAt = -1;
    let whereAt = -1;
    let depth = 0;
    for (let i = m.index - 1; i >= 0; i--) {
      if (guard(i)) continue;
      const ch = out[i]!;
      if (ch === ")") depth++;
      else if (ch === "(") { if (depth === 0) break; depth--; }
      else if (depth === 0 && /[HGWhgw]/.test(ch) && /[\s(]/.test(out[i - 1] ?? " ")) {
        const rest = out.slice(i);
        if (havingAt === -1 && /^HAVING\b/i.test(rest)) havingAt = i;
        else if (groupAt === -1 && /^GROUP\s+BY\b/i.test(rest)) groupAt = i;
        else if (whereAt === -1 && /^WHERE\b/i.test(rest)) whereAt = i;
      }
    }

    if (havingAt !== -1) {
      // HAVING h QUALIFY q -> HAVING h AND marker
      out = out.slice(0, m.index).replace(/\s+$/, " ") + `AND ${marker} ` + out.slice(exprEnd);
    } else if (groupAt !== -1) {
      // GROUP BY g QUALIFY q -> GROUP BY g HAVING marker
      out = out.slice(0, m.index) + `HAVING ${marker} ` + out.slice(exprEnd);
    } else if (whereAt !== -1) {
      // WHERE w ... QUALIFY q -> the marker joins the WHERE; QUALIFY sits
      // directly after the WHERE expression when no GROUP BY intervenes.
      out = out.slice(0, m.index).replace(/\s+$/, " ") + `AND ${marker} ` + out.slice(exprEnd);
    } else {
      out = out.slice(0, m.index) + `WHERE ${marker} ` + out.slice(exprEnd);
    }
  }
  return out;
}

/**
 * Integer division `a // b` -> `a / __honey_idiv() / b`. Division is
 * left-associative, so the parse comes back as (a / marker) / b and
 * reviveSentinels folds it into ["//", a, b].
 */
function rewriteIdiv(sql: string): string {
  const guard = makeGuard(sql);
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    if (!guard(i) && sql[i] === "/" && sql[i + 1] === "/") {
      out += `/ ${SENTINEL.idiv}() /`;
      i++;
      continue;
    }
    out += sql[i];
  }
  return out;
}

/**
 * Statements embedded as derived tables — `FROM (PIVOT ...)`,
 * `FROM (DESCRIBE ...)`, `FROM (SUMMARIZE ...)`, and the postfix
 * `FROM t PIVOT(...) / UNPIVOT(...)` form — are carried through the parse as
 * `(SELECT * FROM __honey_stmt('<raw>'))` and re-parsed by reviveSentinels.
 */
function rewriteEmbeddedStatements(sql: string): string {
  let out = sql;
  // (PIVOT ...) / (UNPIVOT ...) / (DESCRIBE ...) / (SUMMARIZE ...)
  for (let pass = 0; pass < 10; pass++) {
    const guard = makeGuard(out);
    const m = /\(\s*(PIVOT|UNPIVOT|DESCRIBE|SUMMARIZE)\b/gi.exec(out);
    if (!m || guard(m.index)) break;
    const close = matchBracket(out, m.index, guard);
    if (close === -1) break;
    const raw = out.slice(m.index + 1, close).trim();
    // Emitted as a bare table-function call: pgsql-ast-parser requires an
    // alias on parenthesized subqueries, but not on FROM-position calls.
    out =
      out.slice(0, m.index) +
      `${SENTINEL.stmt}(${q(raw)})` +
      out.slice(close + 1);
  }

  // Postfix pivot: `FROM <table-or-(subquery)> PIVOT( ... )`. The raw text is
  // preserved in its original source form (`t PIVOT(...)`), which the pivot
  // mini-parser recognises by shape.
  for (let pass = 0; pass < 10; pass++) {
    const guard = makeGuard(out);
    const re = /\b(UN)?PIVOT\s*\(/gi;
    let m: RegExpExecArray | null;
    let changed = false;
    while ((m = re.exec(out)) !== null) {
      if (guard(m.index)) continue;
      const start = exprStartBackwards(out, m.index, guard);
      // Only FROM position — a source table/subquery directly after FROM/JOIN.
      if (!/\b(FROM|JOIN)\s*$/i.test(out.slice(0, start))) continue;
      const source = out.slice(start, m.index).trim();
      if (!source) continue;
      const open = out.indexOf("(", m.index);
      const close = matchBracket(out, open, guard);
      if (close === -1) continue;
      const kind = m[1] ? "UNPIVOT" : "PIVOT";
      const raw = `${source} ${kind}(${out.slice(open + 1, close)})`;
      out =
        out.slice(0, start) +
        `${SENTINEL.stmt}(${q(raw)})` +
        out.slice(close + 1);
      changed = true;
      break;
    }
    if (!changed) break;
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
 * Order matters, and each placement below is load-bearing:
 *  - dollar quotes first, so later passes see only ordinary string literals;
 *  - statement embeddings before expression rewrites, so a PIVOT body is
 *    carried opaquely rather than half-rewritten;
 *  - window expansion before frames (frames live inside the expanded OVER) and
 *    before QUALIFY (whose position is a HAVING position only once the WINDOW
 *    clause is gone);
 *  - named args (`=>`) before arrow lambdas (`->`), so `=>` is never read as
 *    an arrow;
 *  - map before struct (both start at `{`, MAP is the narrower case), slices
 *    before lists (both start at `[`);
 *  - sample before QUALIFY, both before BY ALL / FROM-first, which reshape the
 *    text those passes scan.
 */
export function preprocessDuckDb(sql: string): string {
  let out = sql;
  out = rewriteStripComments(out);
  out = rewriteDollarQuotes(out);
  out = rewriteEqEq(out);
  out = rewriteEmbeddedStatements(out);
  out = rewriteMaterialized(out);
  out = rewriteCteColumnAliases(out);
  out = rewriteTryCast(out);
  out = rewriteInsertModifiers(out);
  out = rewriteWindowClause(out);
  out = rewriteFrames(out);
  out = rewriteExportState(out);
  out = rewriteLambdaKeyword(out);
  out = rewriteNamedArgs(out);
  out = rewriteArrowLambdas(out);
  out = rewriteStarModifiers(out);
  out = rewriteMapLiteral(out);
  out = rewriteStructLiterals(out);
  // Slices before literals: both start at `[`, and slicing is the narrower case.
  out = rewriteSlices(out);
  out = rewriteListLiterals(out);
  out = rewriteComplexCastTypes(out);
  out = rewriteFieldAccess(out);
  out = rewriteScientific(out);
  out = rewriteIntervalUnit(out);
  out = rewriteCollate(out);
  out = rewriteNullsModifier(out);
  out = rewriteUnaliasedSubqueries(out);
  out = rewriteAggOrderBy(out);
  out = rewriteGroupingSets(out);
  out = rewriteJoins(out);
  out = rewriteUsingSample(out);
  out = rewriteQualify(out);
  out = rewriteIdiv(out);
  out = rewriteByAll(out);
  out = rewriteFromFirst(out);
  return out;
}

// ===========================================================================
// Post-parse revival
// ===========================================================================

/** Context for revival: how to parse an embedded DuckDB statement. */
export interface ReviveContext {
  /** Parses PIVOT/DESCRIBE/... raw text captured by rewriteEmbeddedStatements. */
  parseStatement?: (sql: string) => SqlClause;
}

/** Unwrap an inlined constant ({v: x}) to its string value. */
function constString(x: unknown): string {
  return x && typeof x === "object" && "v" in (x as object)
    ? String((x as { v: unknown }).v)
    : String(x);
}

/** Is this expression a call to the given sentinel? */
function isSentinelCall(x: unknown, name: string): x is SqlExpr[] {
  return (
    Array.isArray(x) &&
    typeof x[0] === "string" &&
    (x[0].startsWith("%") ? x[0].slice(1) : x[0]).toLowerCase() === name
  );
}

/**
 * Parse a `USING SAMPLE` spec string into a structured value; the raw text is
 * always kept so emission is verbatim.
 */
function parseSampleSpec(raw: string): Record<string, unknown> {
  const spec: Record<string, unknown> = { raw };
  const seed = /\bREPEATABLE\s*\(\s*(\d+)\s*\)/i.exec(raw);
  if (seed) spec.seed = Number(seed[1]);
  const method = /^(reservoir|bernoulli|system)\s*\(/i.exec(raw.trim());
  if (method) spec.method = method[1]!.toLowerCase();
  const size = /(\d+(?:\.\d+)?)\s*(%|PERCENT|ROWS?)?/i.exec(raw);
  if (size) {
    spec.value = Number(size[1]);
    if (size[2]) spec.unit = /%|PERCENT/i.test(size[2]) ? "%" : "rows";
  }
  return spec;
}

/**
 * Parse a window frame spec string ("ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
 * EXCLUDE TIES") into a structured value; bounds stay as raw SQL text.
 */
function parseFrameSpec(raw: string): Record<string, unknown> {
  const frame: Record<string, unknown> = { raw };
  const units = /^(ROWS|RANGE|GROUPS)\b/i.exec(raw.trim());
  if (units) frame.units = units[1]!.toLowerCase();
  const exclude = /\bEXCLUDE\s+(CURRENT\s+ROW|TIES|GROUP|NO\s+OTHERS)\s*$/i.exec(raw);
  if (exclude) {
    frame.exclude = exclude[1]!.toLowerCase().replace(/\s+/g, "-");
  }
  const body = raw
    .replace(/^(ROWS|RANGE|GROUPS)\s+/i, "")
    .replace(/\s*\bEXCLUDE\s+(CURRENT\s+ROW|TIES|GROUP|NO\s+OTHERS)\s*$/i, "");
  const between = /^BETWEEN\s+(.+?)\s+AND\s+(.+)$/i.exec(body.trim());
  if (between) {
    frame.start = between[1]!.trim();
    frame.end = between[2]!.trim();
  } else if (body.trim()) {
    frame.start = body.trim();
  }
  return frame;
}

/**
 * Fold join-variant markers out of a JoinClause and report which variant each
 * entry belongs to. Returns null when no entry is marked.
 */
function splitJoinVariants(
  pairs: unknown,
  baseKey: string
): Map<string, [SqlExpr, SqlExpr][]> | null {
  if (!Array.isArray(pairs)) return null;
  const byKey = new Map<string, [SqlExpr, SqlExpr][]>();
  let anyMarked = false;

  for (const pair of pairs as [SqlExpr, SqlExpr][]) {
    const [table, cond] = pair;
    let variant: string | null = null;
    let extra: string | null = null;
    let newCond: SqlExpr = cond;

    if (isSentinelCall(cond, SENTINEL.joinMark)) {
      variant = constString(cond[1]);
      if (cond.length > 2) extra = constString(cond[2]);
      newCond = null as unknown as SqlExpr;
    } else if (
      Array.isArray(cond) &&
      typeof cond[0] === "string" &&
      cond[0].toLowerCase() === "and" &&
      isSentinelCall(cond[1], SENTINEL.joinMark)
    ) {
      const mark = cond[1] as SqlExpr[];
      variant = constString(mark[1]);
      if (mark.length > 2) extra = constString(mark[2]);
      newCond = cond.length === 3 ? (cond[2] as SqlExpr) : (["and", ...cond.slice(2)] as SqlExpr);
    }

    if (variant === null) {
      const list = byKey.get(baseKey) ?? [];
      list.push(pair);
      byKey.set(baseKey, list);
      continue;
    }

    anyMarked = true;
    // "join" + asof -> "asof-join"; "left-join" + asof -> "asof-left-join".
    const key = `${variant}-${baseKey === "join" ? "join" : baseKey}`;
    if (extra?.startsWith("using:")) {
      newCond = ["using", ...extra.slice(6).split(",")] as SqlExpr;
    }
    const list = byKey.get(key) ?? [];
    list.push([table, newCond]);
    byKey.set(key, list);
  }

  return anyMarked ? byKey : null;
}

/**
 * Extract `__honey_qualify(...)` / `__honey_sample(...)` markers from a WHERE
 * or HAVING expression. Returns the cleaned expression (undefined when the
 * marker was the whole thing) and the extracted marker payloads.
 */
function extractMarkers(
  expr: SqlExpr,
  names: string[]
): { rest: SqlExpr | undefined; found: Map<string, SqlExpr[]> } {
  const found = new Map<string, SqlExpr[]>();

  const nameOf = (x: unknown): string | null => {
    for (const n of names) if (isSentinelCall(x, n)) return n;
    return null;
  };

  const walk = (e: SqlExpr): SqlExpr | undefined => {
    const direct = nameOf(e);
    if (direct) {
      found.set(direct, (e as SqlExpr[]).slice(1));
      return undefined;
    }
    if (Array.isArray(e) && typeof e[0] === "string" && e[0].toLowerCase() === "and") {
      const kept = (e.slice(1) as SqlExpr[])
        .map(walk)
        .filter((x): x is SqlExpr => x !== undefined);
      if (kept.length === 0) return undefined;
      if (kept.length === 1) return kept[0];
      return ["and", ...kept];
    }
    return e;
  };

  return { rest: expr === undefined ? undefined : walk(expr), found };
}

/**
 * Turn sentinel function calls in a parsed clause map back into honey-ts's
 * native DuckDB constructs, so the result is indistinguishable from what a
 * DuckDB-native parser would have produced.
 */
export function reviveSentinels(value: unknown, ctx: ReviveContext = {}): unknown {
  const revive = (v: unknown) => reviveSentinels(v, ctx);

  if (Array.isArray(value)) {
    const head = value[0];
    const revivedArgs = value.slice(1).map(revive) as SqlExpr[];

    // A non-string head is a nested expression (e.g. the sole item of a select
    // list), and must be revived too — not passed through untouched.
    if (typeof head !== "string") {
      return [revive(head), ...revivedArgs];
    }

    if (typeof head === "string") {
      const name = head.startsWith("%") ? head.slice(1) : head;

      // `a / __honey_idiv() / b` parses as ["/", ["/", a, marker], b] by left
      // associativity; fold back into ["//", a, b]. Inner folds have already
      // happened because args are revived bottom-up.
      if (name === "/" && revivedArgs.length === 2) {
        const left = revivedArgs[0];
        if (
          Array.isArray(left) &&
          left[0] === "/" &&
          isSentinelCall(left[2], SENTINEL.idiv)
        ) {
          return ["//", left[1], revivedArgs[1]];
        }
      }

      switch (name.toLowerCase()) {
        case SENTINEL.lambda: {
          const params = constString(revivedArgs[0]).split(",").filter(Boolean);
          return ["lambda", params.length === 1 ? params[0]! : params, revivedArgs[1]!];
        }

        case SENTINEL.exportState:
          return ["export-state", revivedArgs[0]!];

        case SENTINEL.field:
          return ["field", revivedArgs[0]!, constString(revivedArgs[1])];

        case SENTINEL.num:
          // Verbatim, not Number(...): `1.5e-3` typed as DOUBLE must not come
          // back as the DECIMAL literal 0.0015 — same value, different type.
          return { __raw: constString(revivedArgs[0]) };

        case SENTINEL.map: {
          const pairs: SqlExpr[] = [];
          for (let i = 0; i < revivedArgs.length; i += 2) {
            pairs.push([revivedArgs[i]!, revivedArgs[i + 1]!] as SqlExpr);
          }
          return ["map", ...pairs];
        }

        case SENTINEL.star: {
          const spec: Record<string, unknown> = {};
          const table = revivedArgs[0];
          if (table !== null && table !== undefined) {
            spec.table = constString(table);
          }
          for (const part of revivedArgs.slice(1)) {
            if (isSentinelCall(part, SENTINEL.starExclude)) {
              spec.exclude = (part as SqlExpr[]).slice(1).map(constString);
            } else if (isSentinelCall(part, SENTINEL.starReplace)) {
              spec.replace = (part as SqlExpr[]).slice(1).map((ri) => {
                const item = ri as SqlExpr[];
                return [item[1], constString(item[2])];
              });
            }
          }
          return ["star", spec];
        }

        case SENTINEL.groupingSets:
          return [
            "grouping-sets",
            ...revivedArgs.map((s) =>
              isSentinelCall(s, SENTINEL.groupingSet) ? (s as SqlExpr[]).slice(1) : [s]
            ),
          ];

        case SENTINEL.stmt: {
          const raw = constString(revivedArgs[0]);
          if (!ctx.parseStatement) {
            throw new Error("embedded statement revival requires a parseStatement context");
          }
          return ctx.parseStatement(raw);
        }

        case SENTINEL.collate:
          return ["collate", revivedArgs[0]!, constString(revivedArgs[1])];

        case SENTINEL.ignoreNulls:
          return ["ignore-nulls", revivedArgs[0]!];

        case SENTINEL.respectNulls:
          return ["respect-nulls", revivedArgs[0]!];

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
      out[k] = revive(v);
    }

    // --- clause-level marker extraction --------------------------------

    // Strip the aliases injected onto unaliased derived tables — PostgreSQL
    // demanded them; the clause map should not keep them.
    if (out.from !== undefined) {
      const stripAlias = (item: unknown): unknown => {
        if (
          Array.isArray(item) &&
          item.length === 2 &&
          typeof item[1] === "string" &&
          item[1].startsWith(SENTINEL.subqueryAlias)
        ) {
          return item[0];
        }
        return item;
      };
      out.from = Array.isArray(out.from)
        ? (out.from as unknown[]).map(stripAlias)
        : stripAlias(out.from);
    }

    // QUALIFY and USING SAMPLE ride through the parse inside HAVING/WHERE.
    for (const clauseKey of ["having", "where"] as const) {
      if (out[clauseKey] === undefined) continue;
      const { rest, found } = extractMarkers(out[clauseKey] as SqlExpr, [
        SENTINEL.qualify,
        SENTINEL.sample,
      ]);
      if (found.size === 0) continue;
      if (rest === undefined) delete out[clauseKey];
      else out[clauseKey] = rest;
      const qualify = found.get(SENTINEL.qualify);
      if (qualify) out.qualify = qualify.length === 1 ? qualify[0] : ["and", ...qualify];
      const sample = found.get(SENTINEL.sample);
      if (sample) out.sample = parseSampleSpec(constString(sample[0]));
    }

    // Join-variant markers -> their own clause keys.
    for (const joinKey of ["join", "left-join", "right-join", "full-join", "inner-join"]) {
      if (out[joinKey] === undefined) continue;
      const split = splitJoinVariants(out[joinKey], joinKey);
      if (!split) continue;
      delete out[joinKey];
      for (const [key, pairs] of split) out[key] = pairs;
    }

    // INSERT modifier markers ride in the column list.
    if (Array.isArray(out.columns)) {
      const cols = out.columns as unknown[];
      const has = (n: string) => cols.some((c) => typeof c === "string" && c === n);
      if (has(SENTINEL.insReplace) || has(SENTINEL.insIgnore) || has(SENTINEL.insByName)) {
        const kept = cols.filter(
          (c) =>
            c !== SENTINEL.insReplace &&
            c !== SENTINEL.insIgnore &&
            c !== SENTINEL.insByName
        );
        if (kept.length > 0) out.columns = kept;
        else delete out.columns;
        if (has(SENTINEL.insByName)) out["by-name"] = true;
        if (has(SENTINEL.insReplace) && out["insert-into"] !== undefined) {
          out["insert-or-replace-into"] = out["insert-into"];
          delete out["insert-into"];
        }
        if (has(SENTINEL.insIgnore) && out["insert-into"] !== undefined) {
          out["insert-or-ignore-into"] = out["insert-into"];
          delete out["insert-into"];
        }
      }
    }

    // Frame markers ride at the head of PARTITION BY inside window specs; the
    // clause map shape here is the over-spec object {partition-by, order-by}.
    if (Array.isArray(out["partition-by"])) {
      const parts = out["partition-by"] as SqlExpr[];
      const markerAt = parts.findIndex((p) => isSentinelCall(p, SENTINEL.frame));
      if (markerAt !== -1) {
        const marker = parts[markerAt] as SqlExpr[];
        out.frame = parseFrameSpec(constString(marker[1]));
        const kept = parts.filter((_, i) => i !== markerAt);
        if (kept.length > 0) out["partition-by"] = kept;
        else delete out["partition-by"];
      }
    }

    return out;
  }

  return value;
}
