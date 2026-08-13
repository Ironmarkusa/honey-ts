/**
 * HTML renderers for the query-builder demo. Pure functions: clause document
 * in, HTML fragment out. All user-derived text is escaped; every interactive
 * element carries the path of the node it edits.
 */

import {
  format, createEnv, paths as _paths,
  type SqlClause, type SqlExpr, type Env,
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

/**
 * Render a select/from item, honoring `[expr, alias]` pairs — in expression
 * position those would format as tuples (`(SUM(x), revenue)`) or calls
 * (`users(u)`), which is not what a chip should say.
 */
function itemSql(item: SqlExpr, dialect: string): string {
  if (
    Array.isArray(item) &&
    item.length === 2 &&
    typeof item[1] === "string" &&
    !item[1].startsWith("%") &&
    !(typeof item[0] === "string" && item[0].startsWith("%"))
  ) {
    return `${exprSql(item[0] as SqlExpr, dialect)} AS ${String(item[1])}`;
  }
  return exprSql(item, dialect);
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

// ============================================================================
// WHERE tree
// ============================================================================

/** Binary single-value operators offered in the dropdown. */
function opChoices(env: Env): string[] {
  const seen = new Set<string>();
  for (const t of ["text", "integer", "timestamp"]) {
    for (const op of env.operatorsFor(t)) {
      if (op.valueType === "single") seen.add(op.op);
    }
  }
  return [...seen];
}

/** A leaf row is editable when it's [op, columnish, simple-value]. */
function leafParts(expr: SqlExpr): { op: string; col: string; val: string } | null {
  if (!Array.isArray(expr) || expr.length !== 3 || typeof expr[0] !== "string") return null;
  const [op, colNode, valNode] = expr;
  if (op.toLowerCase() === "and" || op.toLowerCase() === "or") return null;

  let col: string | null = null;
  if (typeof colNode === "string" && !colNode.startsWith("%")) col = colNode;
  else if (colNode && typeof colNode === "object" && "ident" in colNode) {
    col = (colNode as { ident: string[] }).ident.join(".");
  }
  if (col === null) return null;

  let val: string | null = null;
  if (valNode === null) val = "null";
  else if (typeof valNode === "object" && valNode !== null && !Array.isArray(valNode)) {
    if ("$" in valNode) val = String((valNode as { $: unknown }).$);
    else if ("v" in valNode) val = String((valNode as { v: unknown }).v);
  } else if (typeof valNode === "number" || typeof valNode === "boolean") {
    val = String(valNode);
  }
  if (val === null) return null;

  return { op, col, val };
}

function renderLeaf(expr: SqlExpr, path: Path, env: Env, dialect: string): string {
  const parts = leafParts(expr);
  if (!parts) {
    // Complex expression — honest fallback: show its SQL, allow removal.
    return `<div class="flex items-center">${chip(esc(exprSql(expr, dialect)), path)}</div>`;
  }
  const ops = opChoices(env);
  if (!ops.includes(parts.op)) ops.unshift(parts.op);
  return `
  <div class="flex flex-wrap items-center gap-1.5">
    <input value="${esc(parts.col)}" spellcheck="false"
      data-on:change="$edit = evt.target.value; @post('/set?path=${p(path)}&slot=col')"
      class="w-36 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-sky-300 outline-none focus:border-sky-500"/>
    <select data-on:change="$edit = evt.target.value; @post('/set?path=${p(path)}&slot=op')"
      class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs text-amber-300 outline-none focus:border-sky-500">
      ${ops.map((o) => `<option value="${esc(o)}" ${o === parts.op ? "selected" : ""}>${esc(o)}</option>`).join("")}
    </select>
    <input value="${esc(parts.val)}" spellcheck="false"
      data-on:change="$edit = evt.target.value; @post('/set?path=${p(path)}&slot=value')"
      class="w-36 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-emerald-300 outline-none focus:border-sky-500"/>
    ${removeBtn(path)}
  </div>`;
}

function renderWhereNode(expr: SqlExpr, path: Path, env: Env, dialect: string): string {
  if (Array.isArray(expr) && typeof expr[0] === "string") {
    const head = expr[0].toLowerCase();
    if (head === "and" || head === "or") {
      const children = expr.slice(1).map((child, i) =>
        `<div class="flex items-start gap-2">
           ${renderWhereNode(child as SqlExpr, [...path, i + 1], env, dialect)}
         </div>`
      );
      return `
      <div class="rounded-xl border border-slate-700/70 bg-slate-800/40 p-2.5 space-y-2">
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
  }
  return renderLeaf(expr, path, env, dialect);
}

// ============================================================================
// The builder panel
// ============================================================================

export function renderBuilder(doc: SqlClause | null, dialect: string): string {
  if (!doc) {
    return `<div id="builder" class="grid place-items-center rounded-2xl border border-dashed border-slate-700 p-10 text-sm text-slate-500">
      Paste a query and hit <span class="mx-1 font-semibold text-slate-300">Parse</span> to build.
    </div>`;
  }
  const env = createEnv({ dialect: dialect as never });
  const out: string[] = [];

  // SELECT ------------------------------------------------------------------
  const selectItems = doc.select === undefined ? [] : Array.isArray(doc.select) ? doc.select : [doc.select];
  out.push(`
  <div>
    ${sectionLabel("Select")}
    <div class="flex flex-wrap items-center gap-1.5">
      ${selectItems.map((item, i) => chip(esc(itemSql(item as SqlExpr, dialect)), ["select", i])).join("")}
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
  const joinRows: string[] = fromItems.map((f) =>
    chip(`<span class="text-violet-300">FROM</span>&nbsp;${esc(itemSql(f as SqlExpr, dialect))}`, null)
  );
  for (const key of ["join", "left-join", "right-join", "inner-join", "full-join",
    "asof-join", "semi-join", "anti-join", "positional-join"]) {
    const pairs = doc[key] as [SqlExpr, SqlExpr][] | undefined;
    if (!pairs) continue;
    pairs.forEach(([table, cond], i) => {
      const kw = key === "join" ? "JOIN" : key.replace(/-/g, " ").toUpperCase();
      joinRows.push(chip(
        `<span class="text-violet-300">${kw}</span>&nbsp;${esc(itemSql(table, dialect))}` +
        (cond ? `&nbsp;<span class="text-slate-500">ON</span>&nbsp;${esc(exprSql(cond, dialect))}` : ""),
        [key, i]
      ));
    });
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
      ? renderWhereNode(doc.where as SqlExpr, ["where"], env, dialect)
      : `<div class="rounded-xl border border-dashed border-slate-700/70 p-3 text-center text-xs text-slate-600">no filters</div>`}
  </div>`);

  // QUALIFY (duckdb) ---------------------------------------------------------
  if (doc.qualify !== undefined) {
    out.push(`<div>${sectionLabel("Qualify")}<div class="flex flex-wrap gap-1.5">${
      chip(esc(exprSql(doc.qualify as SqlExpr, dialect)), ["qualify"])
    }</div></div>`);
  }

  // GROUP BY -----------------------------------------------------------------
  const groupItems = doc["group-by"] === undefined ? [] : Array.isArray(doc["group-by"]) ? doc["group-by"] : [doc["group-by"]];
  if (groupItems.length) {
    out.push(`<div>${sectionLabel("Group by")}<div class="flex flex-wrap gap-1.5">${
      groupItems.map((g, i) => chip(esc(exprSql(g as SqlExpr, dialect)), ["group-by", i])).join("")
    }</div></div>`);
  }

  // ORDER BY -----------------------------------------------------------------
  const orderItems = doc["order-by"] === undefined ? [] : Array.isArray(doc["order-by"]) ? doc["order-by"] : [doc["order-by"]];
  if (orderItems.length) {
    out.push(`<div>${sectionLabel("Order by")}<div class="flex flex-wrap gap-1.5">${
      orderItems.map((o, i) => {
        const isPair = Array.isArray(o) && o.length === 2 && (o[1] === "asc" || o[1] === "desc");
        const expr = isPair ? (o as SqlExpr[])[0] : o;
        const dir = isPair ? String((o as SqlExpr[])[1]) : "asc";
        return chip(
          `${esc(exprSql(expr as SqlExpr, dialect))}
           <button data-on:click="@post('/order-dir?path=${p(["order-by", i])}')"
             class="rounded bg-slate-700/80 px-1.5 text-[10px] font-bold ${dir === "desc" ? "text-rose-300" : "text-emerald-300"} hover:brightness-125">${dir.toUpperCase()}</button>`,
          ["order-by", i]
        );
      }).join("")
    }</div></div>`);
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

export function renderOutput(doc: SqlClause | null, dialect: string): string {
  if (!doc) {
    return `<div id="output" class="rounded-2xl border border-slate-700/70 bg-slate-800/30 p-5 text-sm text-slate-600">SQL appears here.</div>`;
  }
  const env = createEnv({ dialect: dialect as never });
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

export function renderStatus(message: string | null, kind: "error" | "ok" = "error"): string {
  if (!message) return `<div id="status"></div>`;
  return `
  <div id="status" class="rounded-xl border ${kind === "error"
    ? "border-rose-500/40 bg-rose-950/30 text-rose-300"
    : "border-emerald-500/40 bg-emerald-950/30 text-emerald-300"} px-4 py-3">
    <pre class="whitespace-pre-wrap font-mono text-xs leading-relaxed">${esc(message)}</pre>
  </div>`;
}
