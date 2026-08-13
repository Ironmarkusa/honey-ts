/**
 * Mini-parsers for DuckDB statement forms that have no PostgreSQL analogue at
 * all: PIVOT/UNPIVOT (both the DuckDB `PIVOT t ON ...` statement form and the
 * SQL-standard `t PIVOT(...)` postfix form), DESCRIBE, SUMMARIZE and SHOW.
 *
 * These are dispatched by fromSql({dialect:"duckdb"}) before the PostgreSQL
 * parser ever sees the text, and again by reviveSentinels for the derived-
 * table embeddings (`FROM (PIVOT ...)`) the preprocessor carries through as
 * `__honey_stmt('<raw>')`.
 *
 * Sub-expressions (pivot sources, ON items, USING aggregates) are parsed by
 * calling back into the real parser, so every nested piece is a normal clause
 * map rather than a string.
 */

import type { SqlClause, SqlExpr } from "./types.js";
import { makeGuard, matchBracket, splitTopLevel } from "./duckdb-preprocess.js";

/** Callbacks into the full parser; avoids a module cycle with parser.ts. */
export interface StatementParseContext {
  /** Parse a complete statement (recursive fromSql with the duckdb dialect). */
  parseSub: (sql: string) => SqlClause;
  /** Parse a single scalar expression. */
  parseExpr: (sql: string) => SqlExpr;
  /** Parse one select-list item (alias-aware). */
  parseSelectItem: (sql: string) => SqlExpr;
}

/** Keywords that end a PIVOT segment. */
const PIVOT_BOUNDARY = /^(ON|USING|GROUP|ORDER|LIMIT|INTO)\b/i;

/** Split `A, B, C` at top level and parse each piece with `parse`. */
function parseList(text: string, parse: (s: string) => SqlExpr): SqlExpr[] {
  return splitTopLevel(text, makeGuard(text), 0).map((piece) => parse(piece.trim()));
}

/** Read the source of a PIVOT: a table name or a parenthesized subquery. */
function parseSource(text: string, ctx: StatementParseContext): SqlExpr {
  const t = text.trim();
  if (t.startsWith("(") && t.endsWith(")")) {
    return ctx.parseSub(t.slice(1, -1)) as SqlExpr;
  }
  return t;
}

/** Segment `PIVOT src ON ... USING ... GROUP BY ...` by top-level keywords. */
function segment(sql: string, from: number): Map<string, string> {
  const guard = makeGuard(sql);
  const segments = new Map<string, string>();
  let currentKey = "source";
  let start = from;
  let depth = 0;

  for (let i = from; i < sql.length; i++) {
    if (guard(i)) continue;
    const ch = sql[i]!;
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && /[A-Za-z]/.test(ch) && /[\s)]/.test(sql[i - 1] ?? " ")) {
      const m = PIVOT_BOUNDARY.exec(sql.slice(i));
      if (m) {
        segments.set(currentKey, sql.slice(start, i).trim());
        currentKey = m[1]!.toUpperCase();
        start = i + m[0].length;
        // GROUP is followed by BY; INTO by NAME — skip the helper word.
        const helper = /^\s*(BY|NAME)\b/i.exec(sql.slice(start));
        if (helper) start += helper[0].length;
        i = start - 1;
      }
    }
  }
  segments.set(currentKey, sql.slice(start).trim());
  return segments;
}

/** DuckDB-style `PIVOT src ON a, b IN (x, y) USING sum(c) [GROUP BY d]`. */
function parseDuckPivot(sql: string, ctx: StatementParseContext): SqlClause {
  const seg = segment(sql, sql.match(/^\s*PIVOT\s+/i)![0].length);
  const pivot: Record<string, unknown> = {
    style: "duckdb",
    source: parseSource(seg.get("source") ?? "", ctx),
  };
  if (seg.has("ON")) pivot.on = parseList(seg.get("ON")!, ctx.parseExpr);
  if (seg.has("USING")) pivot.using = parseList(seg.get("USING")!, ctx.parseSelectItem);
  if (seg.has("GROUP")) pivot["group-by"] = parseList(seg.get("GROUP")!, ctx.parseExpr);
  return { pivot } as SqlClause;
}

/** DuckDB-style `UNPIVOT src ON a, b INTO NAME n VALUE v`. */
function parseDuckUnpivot(sql: string, ctx: StatementParseContext): SqlClause {
  const seg = segment(sql, sql.match(/^\s*UNPIVOT\s+/i)![0].length);
  const unpivot: Record<string, unknown> = {
    style: "duckdb",
    source: parseSource(seg.get("source") ?? "", ctx),
  };
  if (seg.has("ON")) unpivot.on = parseList(seg.get("ON")!, ctx.parseExpr);
  if (seg.has("INTO")) {
    // `NAME <ident> VALUE <ident-list>` (NAME already consumed by segment()).
    const into = seg.get("INTO")!;
    const m = /^([\w"]+)\s+VALUE\s+(.+)$/is.exec(into.trim());
    if (m) {
      unpivot["into-name"] = m[1]!.replace(/"/g, "");
      unpivot["into-value"] = parseList(m[2]!, ctx.parseExpr);
    }
  }
  return { unpivot } as SqlClause;
}

/**
 * SQL-standard postfix form: `src PIVOT(agg [AS a], ... FOR col IN (v, ...))`
 * and `src UNPIVOT [INCLUDE NULLS] (val FOR name IN (cols))`.
 */
function parseStdPivot(sql: string, ctx: StatementParseContext): SqlClause | null {
  const guard = makeGuard(sql);
  const m = /\b(UN)?PIVOT\s*(INCLUDE\s+NULLS\s*)?\(/i.exec(sql);
  if (!m || guard(m.index)) return null;

  const open = sql.indexOf("(", m.index + m[0].length - 1);
  const close = matchBracket(sql, open, guard);
  if (close === -1 || sql.slice(close + 1).trim() !== "") return null;

  const source = parseSource(sql.slice(0, m.index), ctx);
  const body = sql.slice(open + 1, close);

  const bodyGuard = makeGuard(body);
  const forM = (() => {
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      if (bodyGuard(i)) continue;
      const ch = body[i]!;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && /^FOR\b/i.test(body.slice(i)) && /\s/.test(body[i - 1] ?? "")) {
        return i;
      }
    }
    return -1;
  })();
  if (forM === -1) return null;

  const inM = /\bIN\s*\(/gi;
  inM.lastIndex = forM;
  const inMatch = inM.exec(body);
  if (!inMatch || bodyGuard(inMatch.index)) return null;
  const inOpen = body.indexOf("(", inMatch.index);
  const inClose = matchBracket(body, inOpen, bodyGuard);
  if (inClose === -1) return null;

  const head = body.slice(0, forM).trim();
  const forExpr = body.slice(forM + 3, inMatch.index).trim();
  const inList = body.slice(inOpen + 1, inClose);

  const key = m[1] ? "unpivot" : "pivot";
  const node: Record<string, unknown> = {
    style: "standard",
    source,
    for: ctx.parseExpr(forExpr),
    in: parseList(inList, ctx.parseExpr),
  };
  if (m[2]) node["include-nulls"] = true;
  if (key === "pivot") node.aggs = parseList(head, ctx.parseSelectItem);
  else node.value = ctx.parseExpr(head);
  return { [key]: node } as SqlClause;
}

/**
 * Parse a DuckDB-only statement. Returns null when the text is not one of the
 * dispatched forms (the caller then falls through to the normal parse path).
 */
export function parseDuckDbStatement(
  sql: string,
  ctx: StatementParseContext
): SqlClause | null {
  const t = sql.trim().replace(/;\s*$/, "");

  if (/^PIVOT\b/i.test(t)) return parseDuckPivot(t, ctx);
  if (/^UNPIVOT\b/i.test(t)) return parseDuckUnpivot(t, ctx);

  const desc = /^(DESCRIBE|SUMMARIZE)\b\s*/i.exec(t);
  if (desc) {
    const key = desc[1]!.toLowerCase();
    let rest = t.slice(desc[0].length).trim();
    const tableKw = /^TABLE\s+/i.exec(rest);
    if (tableKw) rest = rest.slice(tableKw[0].length).trim();
    // A bare name describes a table; anything statement-shaped is recursive.
    if (/^(SELECT|WITH|FROM|VALUES)\b/i.test(rest)) {
      return { [key]: ctx.parseSub(rest) } as SqlClause;
    }
    return { [key]: rest.replace(/^"|"$/g, "") } as SqlClause;
  }

  if (/^SHOW\b/i.test(t)) {
    return { show: t.replace(/^SHOW\s*/i, "").trim() } as SqlClause;
  }

  // Postfix `src PIVOT(...)` — only when the whole text is that form (the
  // derived-table embedding hands us exactly this).
  if (/\b(UN)?PIVOT\s*(INCLUDE\s+NULLS\s*)?\(/i.test(t) && !/^\s*SELECT\b/i.test(t)) {
    return parseStdPivot(t, ctx);
  }

  return null;
}
