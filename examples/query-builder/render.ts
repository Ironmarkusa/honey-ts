/**
 * HTML renderers for the query-builder demo. Pure functions: clause document
 * in, HTML fragment out. All user-derived text is escaped; every interactive
 * element carries the path of the node it edits.
 *
 * The heart is renderExpr: a recursive editor over the clause data. Idents,
 * parameters and literals become inputs; operator applications get a dropdown
 * enumerated from the env's typed operator table (arity-aware — the server
 * reshapes the node when the new operator wants a different value shape);
 * function calls, casts, lambdas, subscripts, CASE and star-modifiers all
 * break down structurally. Anything unrecognized falls back to a SQL chip.
 */

import {
  format, createQueryBuilder, analyze,
  type SqlClause, type SqlExpr, type Env, type DatabaseSchema,
} from "../../src/index.js";
import type { Path } from "../../src/paths.js";

export const esc = (s: unknown): string =>
  String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const p = (path: Path) => encodeURIComponent(JSON.stringify(path));

/** Render an arbitrary expression as inline SQL (fallback chip content). */
function exprSql(expr: SqlExpr, dialect: string): string {
  try {
    return format(expr, { dialect: dialect as never, inline: true })[0];
  } catch {
    return JSON.stringify(expr);
  }
}

// ============================================================================
// Small UI atoms
// ============================================================================

const removeBtn = (path: Path, title = "Remove") => `
  <button data-on:click="@post('/remove?path=${p(path)}')" title="${title}"
    class="ml-1 grid h-5 w-5 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-rose-500/20 hover:text-rose-400 transition-colors">
    <svg viewBox="0 0 20 20" fill="currentColor" class="h-3 w-3"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/></svg>
  </button>`;

const chip = (inner: string, path: Path | null) => `
  <span class="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 font-mono text-xs text-slate-200">
    ${inner}${path ? removeBtn(path) : ""}
  </span>`;

const sectionLabel = (label: string) => `
  <div class="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">${label}</div>`;

/** Mono punctuation / keyword atoms. */
const punct = (s: string) => `<span class="font-mono text-xs text-slate-500">${s}</span>`;
const kw = (s: string) => `<span class="font-mono text-[10px] font-bold tracking-wider text-violet-300">${s}</span>`;

/** Width that tracks content length (mono font, so ch units are exact). */
const grow = (s: string, min = 2) =>
  `style="width: calc(${Math.max(min, s.length)}ch + 1.25rem)"`;

const INPUT_BASE =
  "rounded-md border border-slate-700/80 bg-slate-900 px-2 py-1 font-mono text-xs outline-none focus:border-sky-500";

/** An editable slot. kind: ident | param | lit | fn | type. */
function slot(value: string, path: Path, kindName: string, color: string): string {
  const list = kindName === "ident" ? ` list="dl-cols"` : kindName === "fn" ? ` list="dl-fns"` : "";
  return `<input value="${esc(value)}" spellcheck="false" ${grow(value)}${list}
    data-on:change="$edit = evt.target.value; @post('/edit?path=${p(path)}&kind=${kindName}')"
    class="${INPUT_BASE} ${color}"/>`;
}

// ============================================================================
// Operator metadata (from the env's typed table)
// ============================================================================

type OpInfo = { op: string; label: string; valueType: "single" | "none" | "list" | "range" };

const FALLBACK_TYPES = ["text", "integer", "numeric", "timestamp", "jsonb"];

/** Operators to offer for a given LHS, typed when inference succeeds. */
function opsForLhs(lhs: SqlExpr, doc: SqlClause, env: Env): OpInfo[] {
  let types: string[] | null = null;
  try {
    const t = env.typeOf(doc, lhs)?.type;
    if (t) types = [t];
  } catch { /* inference is best-effort */ }
  const seen = new Map<string, OpInfo>();
  for (const t of types ?? FALLBACK_TYPES) {
    for (const op of env.operatorsFor(t)) {
      if (!seen.has(op.op)) seen.set(op.op, op as OpInfo);
    }
  }
  // A typed list can be narrow — make sure the basics are always offerable.
  if (types) {
    for (const op of env.operatorsFor("text")) {
      if ((op.op === "=" || op.op === "<>") && !seen.has(op.op)) seen.set(op.op, op as OpInfo);
    }
  }
  return [...seen.values()];
}

const SHAPE_LABEL: Record<OpInfo["valueType"], string> = {
  single: "compare", none: "null checks", list: "lists", range: "ranges",
};

function opSelect(current: string, ops: OpInfo[], path: Path): string {
  if (!ops.some((o) => o.op === current)) {
    ops = [{ op: current, label: current, valueType: "single" }, ...ops];
  }
  const groups: Record<string, OpInfo[]> = {};
  for (const o of ops) (groups[o.valueType] ??= []).push(o);
  const body = (["single", "none", "list", "range"] as const)
    .filter((s) => groups[s]?.length)
    .map((s) => `<optgroup label="${SHAPE_LABEL[s]}">${groups[s]
      .map((o) => `<option value="${esc(o.op)}" title="${esc(o.label)}" ${o.op === current ? "selected" : ""}>${esc(o.op)}</option>`)
      .join("")}</optgroup>`)
    .join("");
  return `<select data-on:change="$edit = evt.target.value; @post('/set-op?path=${p(path)}')"
    class="${INPUT_BASE} text-amber-300">${body}</select>`;
}

/** Head dropdown for arithmetic / concat nodes (no reshaping needed). */
function headSelect(current: string, path: Path, dialect: string): string {
  const ops = ["+", "-", "*", "/", "%", "||", ...(dialect === "duckdb" ? ["//"] : [])];
  if (!ops.includes(current)) ops.unshift(current);
  return `<select data-on:change="$edit = evt.target.value; @post('/set-head?path=${p(path)}')"
    class="${INPUT_BASE} text-amber-300">${ops
      .map((o) => `<option value="${esc(o)}" ${o === current ? "selected" : ""}>${esc(o)}</option>`)
      .join("")}</select>`;
}

const ARITH = new Set(["+", "-", "*", "/", "%", "||", "//", "^", "&", "|", "<<", ">>"]);

// ============================================================================
// renderExpr — the recursive expression editor
// ============================================================================

interface Ctx { env: Env; dialect: string; doc: SqlClause; depth?: number }

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isSubquery = (x: unknown): boolean =>
  isPlainObject(x) && ("select" in x || "from" in x || "union" in x || "union-all" in x);

function scalarText(v: unknown): string | null {
  if (v === null) return "null";
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean" ? String(v) : null;
}

export function renderExpr(expr: SqlExpr, path: Path, ctx: Ctx): string {
  // ---- scalars -------------------------------------------------------------
  if (expr === null) return kw("NULL");
  if (typeof expr === "string") {
    if (expr === "*") return `<span class="font-mono text-sm text-violet-300">*</span>`;
    if (expr.startsWith("%")) {
      return `<span class="font-mono text-xs text-amber-200">${esc(expr.slice(1).toUpperCase())}()</span>`;
    }
    return slot(expr, path, "ident", "text-sky-300");
  }
  if (typeof expr === "number" || typeof expr === "boolean") {
    return slot(String(expr), path, "lit", "text-teal-300");
  }

  // ---- special objects -----------------------------------------------------
  if (isPlainObject(expr)) {
    if ("ident" in expr && Array.isArray(expr.ident)) {
      return slot((expr.ident as string[]).join("."), path, "ident", "text-sky-300");
    }
    if ("$" in expr) {
      const s = scalarText((expr as { $: unknown }).$);
      if (s !== null) return slot(s, path, "param", "text-emerald-300");
    }
    if ("v" in expr) {
      const s = scalarText((expr as { v: unknown }).v);
      if (s !== null) return slot(s, path, "lit", "text-teal-300");
    }
    if ("__raw" in expr || "raw" in expr) {
      return chip(`<span class="text-slate-400">${esc(exprSql(expr, ctx.dialect))}</span>`, null);
    }
    if (isSubquery(expr)) return renderSubquery(expr as SqlClause, path, ctx);
    return chip(esc(exprSql(expr, ctx.dialect)), null);
  }

  // ---- arrays --------------------------------------------------------------
  if (Array.isArray(expr) && expr.length > 0) {
    const head = expr[0];
    if (typeof head === "string") {
      const h = head.toLowerCase();

      if (h === "and" || h === "or") return renderGroup(expr, path, ctx);

      if (h === "not" && expr.length === 2) {
        return `${kwButton("NOT", path, "Remove NOT")} ${renderExpr(expr[1] as SqlExpr, [...path, 1], ctx)}`;
      }

      if (h === "lambda" && expr.length === 3) {
        return `<span class="font-mono text-xs text-fuchsia-300">${esc(String(expr[1]))}</span> ${punct("->")}
          ${renderExpr(expr[2] as SqlExpr, [...path, 2], ctx)}`;
      }

      if (h === "cast" && expr.length === 3) {
        return `${renderExpr(expr[1] as SqlExpr, [...path, 1], ctx)}${punct("::")}${
          slot(String(expr[2]), [...path, 2], "ident", "text-orange-300")}`;
      }

      if (h === "at" && expr.length === 3) {
        return `${renderExpr(expr[1] as SqlExpr, [...path, 1], ctx)}${punct("[")}${
          renderExpr(expr[2] as SqlExpr, [...path, 2], ctx)}${punct("]")}`;
      }

      if (h === "over" && expr.length >= 3) return renderOver(expr, path, ctx);

      if (h === "case") return renderCase(expr, path, ctx);

      if (h === "star") return renderStar(expr, path, ctx);

      if (h === "%exists" && expr.length === 2) {
        return `${kw("EXISTS")} ${renderExpr(expr[1] as SqlExpr, [...path, 1], ctx)}`;
      }

      if (head.startsWith("%")) return renderCall(expr, path, ctx);

      if (ARITH.has(head) && expr.length === 3) {
        return `${renderExpr(expr[1] as SqlExpr, [...path, 1], ctx)}
          ${headSelect(head, path, ctx.dialect)}
          ${renderExpr(expr[2] as SqlExpr, [...path, 2], ctx)}`;
      }

      // Operator application — the granular predicate row.
      if (expr.length >= 2) return renderPredicate(expr, path, ctx);
    }
  }

  return chip(esc(exprSql(expr, ctx.dialect)), null);
}

/** A keyword rendered as a button (click posts /unwrap to strip the wrapper). */
const kwButton = (label: string, path: Path, title: string) => `
  <button data-on:click="@post('/unwrap?path=${p(path)}')" title="${title}"
    class="rounded-md bg-violet-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-violet-300 hover:brightness-125">${label}</button>`;

function renderPredicate(expr: SqlExpr[], path: Path, ctx: Ctx): string {
  const op = String(expr[0]);
  const lhs = expr[1] as SqlExpr;
  const ops = opsForLhs(lhs, ctx.doc, ctx.env);
  const parts = [renderExpr(lhs, [...path, 1], ctx), opSelect(op, ops, path)];

  // The operator's own table entry decides the value shape — never guess
  // from the data (an arithmetic RHS is also an array).
  const opLower = op.toLowerCase();
  const shape = ops.find((o) => o.op === op)?.valueType;
  if (opLower === "is" || opLower === "is-not") {
    parts.push(kw("NULL"));
  } else if (expr.length === 4) {
    // range: x BETWEEN lo AND hi
    parts.push(renderExpr(expr[2] as SqlExpr, [...path, 2], ctx));
    parts.push(kw("AND"));
    parts.push(renderExpr(expr[3] as SqlExpr, [...path, 3], ctx));
  } else if (shape === "list" && Array.isArray(expr[2])) {
    // list: x IN (a, b, c) — an array of values, not an operator application
    const items = expr[2] as SqlExpr[];
    parts.push(punct("("));
    items.forEach((item, i) => {
      if (i > 0) parts.push(punct(","));
      parts.push(renderExpr(item, [...path, 2, i], ctx));
    });
    parts.push(`<button data-on:click="@post('/add-item?path=${p([...path, 2])}')" title="Add value"
      class="rounded-md border border-slate-700 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 hover:bg-slate-700 hover:text-slate-200">+</button>`);
    parts.push(punct(")"));
  } else if (expr.length >= 3) {
    parts.push(renderExpr(expr[2] as SqlExpr, [...path, 2], ctx));
  }

  return `<span class="inline-flex flex-wrap items-center gap-1.5">${parts.join(" ")}</span>`;
}

function renderCall(expr: SqlExpr[], path: Path, ctx: Ctx): string {
  const name = String(expr[0]).slice(1);
  const parts: string[] = [
    slot(name, [...path, 0], "fn", "text-amber-200"),
    punct("("),
  ];
  expr.slice(1).forEach((arg, i) => {
    if (i > 0) parts.push(punct(","));
    parts.push(renderExpr(arg as SqlExpr, [...path, i + 1], ctx));
  });
  parts.push(punct(")"));
  return `<span class="inline-flex flex-wrap items-center gap-1">${parts.join("")}</span>`;
}

function renderCase(expr: SqlExpr[], path: Path, ctx: Ctx): string {
  const parts: string[] = [kw("CASE")];
  for (let i = 1; i < expr.length; i += 2) {
    if (String(expr[i]).toLowerCase() === "else") {
      parts.push(kw("ELSE"), renderExpr(expr[i + 1] as SqlExpr, [...path, i + 1], ctx));
    } else {
      parts.push(kw("WHEN"), renderExpr(expr[i] as SqlExpr, [...path, i], ctx));
      parts.push(kw("THEN"), renderExpr(expr[i + 1] as SqlExpr, [...path, i + 1], ctx));
    }
  }
  parts.push(kw("END"));
  return `<span class="inline-flex flex-wrap items-center gap-1.5">${parts.join(" ")}</span>`;
}

function renderStar(expr: SqlExpr[], path: Path, ctx: Ctx): string {
  const mods = (expr[1] ?? {}) as { exclude?: string[]; replace?: [SqlExpr, string][] };
  const parts: string[] = [`<span class="font-mono text-sm text-violet-300">*</span>`];
  if (mods.exclude?.length) {
    parts.push(kw("EXCLUDE"), punct("("));
    mods.exclude.forEach((col, i) => {
      if (i > 0) parts.push(punct(","));
      parts.push(slot(String(col), [...path, 1, "exclude", i], "ident", "text-sky-300"));
    });
    parts.push(punct(")"));
  }
  if (mods.replace?.length) {
    parts.push(kw("REPLACE"), punct("("));
    mods.replace.forEach(([e, name], i) => {
      if (i > 0) parts.push(punct(","));
      parts.push(renderExpr(e, [...path, 1, "replace", i, 0], ctx));
      parts.push(kw("AS"), slot(String(name), [...path, 1, "replace", i, 1], "ident", "text-sky-300"));
    });
    parts.push(punct(")"));
  }
  return `<span class="inline-flex flex-wrap items-center gap-1.5">${parts.join(" ")}</span>`;
}

/** Window application: fn OVER (PARTITION BY … ORDER BY … [frame]) — all editable. */
function renderOver(expr: SqlExpr[], path: Path, ctx: Ctx): string {
  const spec = (expr[2] ?? {}) as Record<string, unknown>;
  const parts: string[] = [renderExpr(expr[1] as SqlExpr, [...path, 1], ctx), kw("OVER"), punct("(")];

  const partitions = spec["partition-by"] as SqlExpr[] | undefined;
  if (partitions?.length) {
    parts.push(kw("PARTITION BY"));
    partitions.forEach((e, i) => {
      if (i > 0) parts.push(punct(","));
      parts.push(renderExpr(e, [...path, 2, "partition-by", i], ctx));
    });
    parts.push(`<button data-on:click="@post('/add-item?path=${p([...path, 2, "partition-by"])}&kind=ident')" title="Add partition key"
      class="rounded-md border border-slate-700 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 hover:bg-slate-700 hover:text-slate-200">+</button>`);
  }

  const orders = spec["order-by"] as SqlExpr[] | undefined;
  if (orders?.length) {
    parts.push(kw("ORDER BY"));
    orders.forEach((o, i) => {
      if (i > 0) parts.push(punct(","));
      const isPair = Array.isArray(o) && o.length === 2 && (o[1] === "asc" || o[1] === "desc");
      const e = isPair ? (o as SqlExpr[])[0] : o;
      const ePath: Path = isPair ? [...path, 2, "order-by", i, 0] : [...path, 2, "order-by", i];
      const dir = isPair ? String((o as SqlExpr[])[1]) : "asc";
      parts.push(renderExpr(e as SqlExpr, ePath, ctx));
      parts.push(`<button data-on:click="@post('/order-dir?path=${p([...path, 2, "order-by", i])}')"
        class="rounded bg-slate-700/80 px-1.5 text-[10px] font-bold ${dir === "desc" ? "text-rose-300" : "text-emerald-300"} hover:brightness-125">${dir.toUpperCase()}</button>`);
    });
  }

  for (const [k, v] of Object.entries(spec)) {
    if (k === "partition-by" || k === "order-by") continue;
    parts.push(`<span class="font-mono text-[10px] text-slate-500">${esc(k)}: ${esc(JSON.stringify(v))}</span>`);
  }

  parts.push(punct(")"));
  return `<span class="inline-flex flex-wrap items-center gap-1.5">${parts.join(" ")}</span>`;
}

const SUB_CLAUSE_KEYS = ["select", "from", "where"] as const;

/** A nested SELECT rendered as a mini-builder — same paths, same routes. */
function renderSubquery(sub: SqlClause, path: Path, ctx: Ctx): string {
  const depth = ctx.depth ?? 0;
  if (depth >= 3) {
    const sql = exprSql(sub, ctx.dialect);
    return chip(`<span class="text-slate-400">(${esc(sql.length > 60 ? sql.slice(0, 57) + "…" : sql)})</span>`, null);
  }
  const sctx: Ctx = { ...ctx, depth: depth + 1 };
  const rows: string[] = [];

  const label = (s: string) =>
    `<span class="w-14 shrink-0 pt-1.5 text-right font-mono text-[9px] font-bold uppercase tracking-widest text-slate-600">${s}</span>`;

  const selItems = sub.select === undefined ? [] : Array.isArray(sub.select) ? sub.select : [sub.select];
  if (selItems.length) {
    rows.push(`<div class="flex items-start gap-2">${label("select")}
      <div class="flex flex-wrap items-center gap-1.5">${
        selItems.map((item, i) => renderSelectItem(item as SqlExpr, [...path, "select", i], sctx)).join(punct(","))
      }</div></div>`);
  }

  const fromItems = sub.from === undefined ? [] : Array.isArray(sub.from) ? sub.from : [sub.from];
  if (fromItems.length) {
    const fromLabel = (f: SqlExpr): string => {
      if (Array.isArray(f) && f.length === 2 && typeof f[1] === "string") {
        return `${esc(exprSql(f[0] as SqlExpr, ctx.dialect))} <span class="text-slate-500">AS</span> ${esc(String(f[1]))}`;
      }
      return esc(exprSql(f, ctx.dialect));
    };
    rows.push(`<div class="flex items-start gap-2">${label("from")}
      <div class="flex flex-wrap items-center gap-1.5 pt-0.5 font-mono text-xs text-slate-300">${
        fromItems.map((f) => fromLabel(f as SqlExpr)).join(", ")
      }</div></div>`);
  }

  if (sub.where !== undefined) {
    rows.push(`<div class="flex items-start gap-2">${label("where")}
      <div class="min-w-0 flex-1">${renderWhereNode(sub.where as SqlExpr, [...path, "where"], sctx)}</div></div>`);
  }

  const rest = Object.keys(sub).filter((k) => !(SUB_CLAUSE_KEYS as readonly string[]).includes(k));
  if (rest.length) {
    const restDoc = Object.fromEntries(rest.map((k) => [k, sub[k]])) as SqlClause;
    rows.push(`<div class="flex items-start gap-2">${label("")}
      <span class="pt-0.5 font-mono text-[10px] text-slate-500">${esc(exprSql(restDoc, ctx.dialect))}</span></div>`);
  }

  return `<span class="block min-w-0 rounded-xl border border-slate-600/60 bg-slate-900/60 p-2.5 space-y-1.5">${rows.join("")}</span>`;
}

/** Wrap-in-function button: turns expr into ["%lower", expr] (name then editable). */
const wrapFnBtn = (path: Path) => `
  <button data-on:click="@post('/wrap?path=${p(path)}&kind=fn')" title="Wrap in function"
    class="grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[11px] italic text-slate-500 hover:bg-amber-500/20 hover:text-amber-300 transition-colors">ƒ</button>`;

/** Wrap-in-NOT button for predicates. */
const wrapNotBtn = (path: Path) => `
  <button data-on:click="@post('/wrap?path=${p(path)}&kind=not')" title="Negate (wrap in NOT)"
    class="grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[11px] font-bold text-slate-500 hover:bg-violet-500/20 hover:text-violet-300 transition-colors">¬</button>`;

/** [expr, alias] in select position → expr AS alias, both editable. */
function renderSelectItem(item: SqlExpr, path: Path, ctx: Ctx): string {
  if (
    Array.isArray(item) && item.length === 2 &&
    typeof item[1] === "string" && !item[1].startsWith("%") &&
    !(typeof item[0] === "string" && item[0].startsWith("%")) &&
    !(typeof item[0] === "string" && ARITH.has(item[0]))
  ) {
    return `${renderExpr(item[0] as SqlExpr, [...path, 0], ctx)}${wrapFnBtn([...path, 0])} ${kw("AS")} ${
      slot(String(item[1]), [...path, 1], "ident", "text-sky-300")}`;
  }
  return `${renderExpr(item, path, ctx)}${wrapFnBtn(path)}`;
}

// ============================================================================
// WHERE tree
// ============================================================================

function renderGroup(expr: SqlExpr[], path: Path, ctx: Ctx): string {
  const head = String(expr[0]).toLowerCase();
  const children = expr.slice(1).map((child, i) =>
    `<div class="flex items-start gap-2">
       ${renderWhereNode(child as SqlExpr, [...path, i + 1], ctx)}
     </div>`
  );
  return `
  <div class="w-full rounded-xl border border-slate-700/70 bg-slate-800/40 p-2.5 space-y-2">
    <div class="flex items-center gap-2">
      <button data-on:click="@post('/toggle?path=${p(path)}')"
        class="rounded-md ${head === "and" ? "bg-sky-500/20 text-sky-300" : "bg-fuchsia-500/20 text-fuchsia-300"} px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest hover:brightness-125"
        title="Toggle AND / OR">${head.toUpperCase()}</button>
      <div class="h-px flex-1 bg-slate-700/60"></div>
      <button data-on:click="@post('/add?path=${p(path)}')"
        class="rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 hover:bg-slate-700 hover:text-slate-200">+ condition</button>
    </div>
    ${children.join("")}
  </div>`;
}

function renderWhereNode(expr: SqlExpr, path: Path, ctx: Ctx): string {
  if (Array.isArray(expr) && typeof expr[0] === "string") {
    const head = String(expr[0]).toLowerCase();
    if (head === "and" || head === "or") return renderGroup(expr as SqlExpr[], path, ctx);
  }
  return `<div class="flex flex-wrap items-center gap-1.5">${renderExpr(expr, path, ctx)}${wrapNotBtn(path)}${removeBtn(path)}</div>`;
}

// ============================================================================
// The builder panel
// ============================================================================

export function renderBuilder(doc: SqlClause | null, dialect: string, env: Env): string {
  if (!doc) {
    return `<div id="builder" class="grid place-items-center rounded-2xl border border-dashed border-slate-700 p-10 text-sm text-slate-500">
      Paste a query and hit <span class="mx-1 font-semibold text-slate-300">Parse</span> to build.
    </div>`;
  }
  const ctx: Ctx = { env, dialect, doc };
  const out: string[] = [];
  const schema = (env.config as { schema?: DatabaseSchema }).schema;

  // Autocomplete datalists: alias-qualified columns of in-query tables + fn names.
  if (schema) {
    const aliasMap = (() => {
      try { return analyze.getTableAliases(doc).aliases; } catch { return new Map<string, string>(); }
    })();
    const cols: string[] = [];
    for (const [tableName, alias] of aliasMap) {
      const table = schema.tables.find((t) => t.name === tableName);
      if (!table) continue;
      for (const c of table.columns) cols.push(`${alias || tableName}.${c.name}`);
      if (aliasMap.size === 1) for (const c of table.columns) cols.push(c.name);
    }
    const fns = new Set<string>();
    for (const t of FALLBACK_TYPES) {
      for (const f of env.functionsFor(t)) fns.add(f.name.replace(/^%/, ""));
    }
    out.push(`
      <datalist id="dl-cols">${cols.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>
      <datalist id="dl-fns">${[...fns].sort().map((f) => `<option value="${esc(f)}"></option>`).join("")}</datalist>`);
  }

  // SELECT ------------------------------------------------------------------
  const selectItems = doc.select === undefined ? [] : Array.isArray(doc.select) ? doc.select : [doc.select];
  out.push(`
  <div>
    ${sectionLabel("Select")}
    <div class="flex flex-wrap items-center gap-1.5">
      ${selectItems.map((item, i) => `
        <span class="inline-flex flex-wrap items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-2 py-1">
          ${renderSelectItem(item as SqlExpr, ["select", i], ctx)}${removeBtn(["select", i])}
        </span>`).join("")}
      <span class="inline-flex items-center gap-1">
        <input placeholder="add column…" data-bind:newcol spellcheck="false"
          data-on:keydown="evt.key === 'Enter' && @post('/add-select')"
          class="w-32 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 font-mono text-xs text-slate-300 outline-none placeholder:text-slate-600 focus:border-sky-500"/>
        <button data-on:click="@post('/add-select')"
          class="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:bg-slate-700 hover:text-slate-200">+</button>
      </span>
    </div>
  </div>`);

  // FROM + JOINs -------------------------------------------------------------
  const fromItems = doc.from === undefined ? [] : Array.isArray(doc.from) ? doc.from : [doc.from];
  const joinRows: string[] = fromItems.map((f) => {
    const pair = Array.isArray(f) && f.length === 2 && typeof f[1] === "string";
    const label = pair
      ? `${esc(exprSql((f as SqlExpr[])[0] as SqlExpr, dialect))}&nbsp;<span class="text-slate-500">AS</span>&nbsp;${esc(String((f as SqlExpr[])[1]))}`
      : esc(exprSql(f as SqlExpr, dialect));
    return chip(`<span class="text-violet-300">FROM</span>&nbsp;${label}`, null);
  });
  for (const key of ["join", "left-join", "right-join", "inner-join", "full-join",
    "asof-join", "semi-join", "anti-join", "positional-join"]) {
    const pairs = doc[key] as [SqlExpr, SqlExpr][] | undefined;
    if (!pairs) continue;
    pairs.forEach(([table, cond], i) => {
      const kwText = key === "join" ? "JOIN" : key.replace(/-/g, " ").toUpperCase();
      const tablePair = Array.isArray(table) && table.length === 2 && typeof table[1] === "string";
      const tableLabel = tablePair
        ? `${esc(exprSql((table as SqlExpr[])[0] as SqlExpr, dialect))} <span class="text-slate-500">AS</span> ${esc(String((table as SqlExpr[])[1]))}`
        : esc(exprSql(table, dialect));
      joinRows.push(`
        <span class="inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-2 py-1 font-mono text-xs">
          <span class="text-violet-300">${kwText}</span> <span class="text-slate-200">${tableLabel}</span>
          ${cond ? `<span class="text-slate-500">ON</span> ${renderExpr(cond, [key, i, 1], ctx)}` : ""}
          ${removeBtn([key, i])}
        </span>`);
    });
  }
  // FK-based join suggestions (ghost buttons).
  if (schema) {
    try {
      const joinable = createQueryBuilder(schema).getJoinableTables(doc);
      for (const j of joinable) {
        joinRows.push(`
          <button data-on:click="@post('/add-join?table=${encodeURIComponent(j.table.name)}')"
            class="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-600 px-2.5 py-1 font-mono text-xs text-slate-500 hover:border-emerald-500/60 hover:text-emerald-300 transition-colors">
            + ${esc(j.joinType.toUpperCase())} JOIN ${esc(j.table.name)}
            <span class="text-slate-600">ON ${esc(exprSql(j.suggestedOn, dialect))}</span>
          </button>`);
      }
    } catch { /* suggestions are best-effort */ }
  }
  if (joinRows.length) {
    out.push(`<div>${sectionLabel("From / Joins")}<div class="flex flex-wrap gap-1.5">${joinRows.join("")}</div></div>`);
  }

  // WHERE --------------------------------------------------------------------
  out.push(`
  <div>
    <div class="mb-1.5 flex items-center justify-between">
      ${sectionLabel("Where").replace('mb-1.5 ', '')}
      <button data-on:click="@post('/add')"
        class="rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 hover:bg-slate-700 hover:text-slate-200">+ filter</button>
    </div>
    ${doc.where !== undefined
      ? renderWhereNode(doc.where as SqlExpr, ["where"], ctx)
      : `<div class="rounded-xl border border-dashed border-slate-700/70 p-3 text-center text-xs text-slate-600">no filters</div>`}
  </div>`);

  // HAVING -------------------------------------------------------------------
  if (doc.having !== undefined) {
    out.push(`<div>${sectionLabel("Having")}${renderWhereNode(doc.having as SqlExpr, ["having"], ctx)}</div>`);
  }

  // QUALIFY (duckdb) ---------------------------------------------------------
  if (doc.qualify !== undefined) {
    out.push(`<div>${sectionLabel("Qualify")}${renderWhereNode(doc.qualify as SqlExpr, ["qualify"], ctx)}</div>`);
  }

  // GROUP BY -----------------------------------------------------------------
  const groupItems = doc["group-by"] === undefined ? [] : Array.isArray(doc["group-by"]) ? doc["group-by"] : [doc["group-by"]];
  const addBtn = (route: string, label: string) => `
    <button data-on:click="@post('${route}')"
      class="rounded-lg border border-dashed border-slate-600 px-2 py-1 text-[11px] font-semibold text-slate-500 hover:border-sky-500/60 hover:text-sky-300 transition-colors">${label}</button>`;
  out.push(`<div>${sectionLabel("Group by")}<div class="flex flex-wrap items-center gap-1.5">${
    groupItems.map((g, i) => `
      <span class="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-2 py-1">
        ${renderExpr(g as SqlExpr, ["group-by", i], ctx)}${removeBtn(["group-by", i])}
      </span>`).join("")
  }${addBtn("/add-groupby", "+ group by")}</div></div>`);

  // ORDER BY -----------------------------------------------------------------
  const orderItems = doc["order-by"] === undefined ? [] : Array.isArray(doc["order-by"]) ? doc["order-by"] : [doc["order-by"]];
  {
    out.push(`<div>${sectionLabel("Order by")}<div class="flex flex-wrap items-center gap-1.5">${
      orderItems.map((o, i) => {
        const isPair = Array.isArray(o) && o.length === 2 && (o[1] === "asc" || o[1] === "desc");
        const expr = isPair ? (o as SqlExpr[])[0] : o;
        const exprPath: Path = isPair ? ["order-by", i, 0] : ["order-by", i];
        const dir = isPair ? String((o as SqlExpr[])[1]) : "asc";
        return `
        <span class="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-2 py-1">
          ${renderExpr(expr as SqlExpr, exprPath, ctx)}
          <button data-on:click="@post('/order-dir?path=${p(["order-by", i])}')"
            class="rounded bg-slate-700/80 px-1.5 text-[10px] font-bold ${dir === "desc" ? "text-rose-300" : "text-emerald-300"} hover:brightness-125">${dir.toUpperCase()}</button>
          ${removeBtn(["order-by", i])}
        </span>`;
      }).join("")
    }${addBtn("/add-orderby", "+ order by")}</div></div>`);
  }

  // LIMIT --------------------------------------------------------------------
  const limitVal = (() => {
    const l = doc.limit as unknown;
    if (l === undefined) return "";
    if (typeof l === "object" && l !== null) {
      const o = l as Record<string, unknown>;
      return String(o.$ ?? o.v ?? "");
    }
    return String(l);
  })();
  out.push(`
  <div>${sectionLabel("Limit")}
    <input value="${esc(limitVal)}" placeholder="∞" inputmode="numeric"
      data-on:change="$edit = evt.target.value; @post('/set-limit')"
      class="w-24 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-500"/>
  </div>`);

  return `<div id="builder" class="space-y-5 rounded-2xl border border-slate-700/70 bg-slate-800/30 p-5">${out.join("")}</div>`;
}

// ============================================================================
// Output panel + status
// ============================================================================

export function renderOutput(doc: SqlClause | null, dialect: string, env: Env): string {
  if (!doc) {
    return `<div id="output" class="rounded-2xl border border-slate-700/70 bg-slate-800/30 p-5 text-sm text-slate-600">SQL appears here.</div>`;
  }
  let pretty = "";
  let params: unknown[] = [];
  let error: string | null = null;
  try {
    const [sql, ...rest] = env.emit(doc, { pretty: true });
    pretty = sql;
    params = rest;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const runsOn = env.emittable(doc);
  const badge = (d: string) => {
    const ok = runsOn.includes(d as never);
    return `<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
      ok ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
         : "border-slate-700 bg-slate-800 text-slate-600 line-through"}">
      <span class="h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-slate-600"}"></span>${d}</span>`;
  };

  return `
  <div id="output" class="rounded-2xl border border-slate-700/70 bg-slate-800/30 p-5 space-y-3">
    <div class="flex items-center justify-between">
      <div class="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Output — ${esc(dialect)}</div>
      <div class="flex items-center gap-1.5">
        ${badge("postgres")}${badge("duckdb")}
        <button data-on:click="navigator.clipboard.writeText(document.getElementById('sqlpre').textContent)"
          class="ml-2 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400 hover:bg-slate-700 hover:text-slate-200">copy</button>
      </div>
    </div>
    ${error
      ? `<pre class="overflow-x-auto rounded-xl bg-rose-950/40 p-4 text-xs leading-relaxed text-rose-300">${esc(error)}</pre>`
      : `<pre id="sqlpre" class="overflow-x-auto rounded-xl bg-slate-950 p-4 font-mono text-xs leading-relaxed text-sky-200">${esc(pretty)}</pre>
         ${params.length ? `<div class="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">params:${
           params.map((v, i) => `<span class="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-emerald-300">$${i + 1} = ${esc(JSON.stringify(v))}</span>`).join("")
         }</div>` : ""}`}
    <details class="group">
      <summary class="cursor-pointer text-[11px] text-slate-600 hover:text-slate-400">clause document (JSON)</summary>
      <pre class="mt-2 max-h-64 overflow-auto rounded-xl bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-400">${esc(JSON.stringify(doc, null, 2))}</pre>
    </details>
  </div>`;
}

/** Schema-validation problems (unknown columns, ungrouped selects, …) with hints. */
export function renderProblems(doc: SqlClause | null, env: Env): string {
  if (!doc) return `<div id="problems"></div>`;
  let problems: Array<{ severity: string; code: string; scope?: string; message: string; hint?: string }> = [];
  try {
    problems = env.validate(doc).problems as typeof problems;
  } catch { /* validation is best-effort on odd documents */ }
  if (!problems.length) return `<div id="problems"></div>`;
  return `
  <div id="problems" class="space-y-1.5">
    ${problems.map((pr) => {
      const isErr = pr.severity === "error";
      return `
      <div class="flex items-start gap-2.5 rounded-xl border ${isErr
        ? "border-rose-500/30 bg-rose-950/20" : "border-amber-500/30 bg-amber-950/20"} px-3.5 py-2 text-xs">
        <span class="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${isErr ? "bg-rose-400" : "bg-amber-400"}"></span>
        <div class="min-w-0">
          <span class="${isErr ? "text-rose-300" : "text-amber-300"}">${esc(pr.message)}</span>
          ${pr.hint ? `<span class="ml-1.5 italic text-slate-400">${esc(pr.hint)}</span>` : ""}
          <span class="ml-1.5 font-mono text-[10px] text-slate-600">${esc(pr.code)}${pr.scope ? ` · ${esc(pr.scope)}` : ""}</span>
        </div>
      </div>`;
    }).join("")}
  </div>`;
}

export function renderStatus(message: string | null, kind: "error" | "ok" = "error"): string {
  if (!message) return `<div id="status"></div>`;
  return `
  <div id="status" class="rounded-xl border ${kind === "error"
    ? "border-rose-500/40 bg-rose-950/30 text-rose-300"
    : "border-emerald-500/40 bg-emerald-950/30 text-emerald-300"} px-4 py-3">
    <pre class="whitespace-pre-wrap font-mono text-xs leading-relaxed">${esc(message)}</pre>
  </div>`;
}
