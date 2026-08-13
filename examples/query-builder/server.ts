/**
 * Query-builder demo server.
 *
 * Architecture: the clause document lives in a Datastar signal (as a JSON
 * string) — the server is stateless. Every interaction POSTs the signals,
 * the server parses/edits/emits with honey-ts, and answers over SSE with
 * patched fragments (+ the updated document signal).
 *
 * Run:  npx tsx examples/query-builder/server.ts   → http://localhost:4321
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  fromSql, modify, paths, $, type SqlClause, type SqlExpr,
} from "../../src/index.js";
import type { Path } from "../../src/paths.js";
import { renderBuilder, renderOutput, renderStatus } from "./render.js";

const PORT = Number(process.env.PORT ?? 4321);
const here = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Datastar SSE protocol (v1.0.0): patch-elements / patch-signals
// ============================================================================

function sseStart(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function patchElements(res: ServerResponse, html: string): void {
  res.write("event: datastar-patch-elements\n");
  for (const line of html.split("\n")) res.write(`data: elements ${line}\n`);
  res.write("\n");
}

function patchSignals(res: ServerResponse, signals: Record<string, unknown>): void {
  res.write("event: datastar-patch-signals\n");
  res.write(`data: signals ${JSON.stringify(signals)}\n\n`);
}

async function readSignals(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

// ============================================================================
// Document helpers
// ============================================================================

interface Signals {
  sql?: string;
  dialect?: string;
  edit?: string;
  newcol?: string;
  docjson?: string;
}

function getDoc(signals: Signals): SqlClause | null {
  if (!signals.docjson) return null;
  try {
    return JSON.parse(signals.docjson) as SqlClause;
  } catch {
    return null;
  }
}

/** "42" → 42, "null" → null, anything else → string. */
function coerceValue(raw: string): SqlExpr {
  const t = raw.trim();
  if (t.toLowerCase() === "null") return null;
  if (t.toLowerCase() === "true") return $(true) as SqlExpr;
  if (t.toLowerCase() === "false") return $(false) as SqlExpr;
  if (/^-?\d+(\.\d+)?$/.test(t)) return $(Number(t)) as SqlExpr;
  return $(t) as SqlExpr;
}

const BLANK_CONDITION: SqlExpr = ["=", "column", { $: "value" }];

/** Everything the client needs after any change. */
function respond(
  res: ServerResponse,
  doc: SqlClause | null,
  dialect: string,
  status: string | null = null
): void {
  sseStart(res);
  patchSignals(res, { docjson: doc ? JSON.stringify(doc) : "" });
  patchElements(res, renderBuilder(doc, dialect));
  patchElements(res, renderOutput(doc, dialect));
  patchElements(res, renderStatus(status));
  res.end();
}

// ============================================================================
// Routes
// ============================================================================

type Handler = (
  res: ServerResponse,
  signals: Signals,
  query: URLSearchParams
) => void;

const routes: Record<string, Handler> = {
  "/parse": (res, signals) => {
    const dialect = signals.dialect ?? "postgres";
    const sql = signals.sql ?? "";
    if (!sql.trim()) return respond(res, null, dialect, "Paste some SQL first.");
    try {
      const doc =
        dialect === "duckdb" ? fromSql(sql, { dialect: "duckdb" }) : fromSql(sql);
      respond(res, doc, dialect);
    } catch (e) {
      respond(res, getDoc(signals), dialect, e instanceof Error ? e.message : String(e));
    }
  },

  // Dialect changed (or any re-render request): keep the document, re-emit.
  "/render": (res, signals) => {
    respond(res, getDoc(signals), signals.dialect ?? "postgres");
  },

  "/set": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    const slot = query.get("slot");
    const edit = signals.edit ?? "";
    const slotIndex = slot === "op" ? 0 : slot === "col" ? 1 : 2;
    const value: SqlExpr =
      slot === "value" ? coerceValue(edit) : (edit.trim() as SqlExpr);
    const next = paths.setAt(doc, [...path, slotIndex], value);
    respond(res, next, signals.dialect ?? "postgres");
  },

  "/toggle": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    const next = paths.updateAt(doc, path, (node) => {
      const arr = node as SqlExpr[];
      const head = String(arr[0]).toLowerCase() === "and" ? "or" : "and";
      return [head, ...arr.slice(1)];
    });
    respond(res, next, signals.dialect ?? "postgres");
  },

  "/add": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const rawPath = query.get("path");
    let next: SqlClause;
    if (rawPath) {
      // Append a condition to an AND/OR group.
      const path = JSON.parse(rawPath) as Path;
      next = paths.updateAt(doc, path, (node) => [
        ...(node as SqlExpr[]),
        BLANK_CONDITION,
      ]);
    } else {
      next = modify.addWhere(doc, BLANK_CONDITION);
    }
    respond(res, next, signals.dialect ?? "postgres");
  },

  "/remove": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    respond(res, paths.removeAt(doc, path), signals.dialect ?? "postgres");
  },

  "/add-select": (res, signals) => {
    const doc = getDoc(signals);
    const col = (signals.newcol ?? "").trim();
    if (!doc || !col) return respond(res, doc, signals.dialect ?? "postgres");
    const next = modify.addSelect(doc, col);
    sseStart(res);
    patchSignals(res, { docjson: JSON.stringify(next), newcol: "" });
    patchElements(res, renderBuilder(next, signals.dialect ?? "postgres"));
    patchElements(res, renderOutput(next, signals.dialect ?? "postgres"));
    patchElements(res, renderStatus(null));
    res.end();
  },

  "/set-limit": (res, signals) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const edit = (signals.edit ?? "").trim();
    let next: SqlClause;
    if (edit === "") {
      const { limit: _limit, ...rest } = doc;
      next = rest as SqlClause;
    } else {
      next = { ...doc, limit: $(Number(edit) || 0) };
    }
    respond(res, next, signals.dialect ?? "postgres");
  },

  "/order-dir": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    const next = paths.updateAt(doc, path, (node) => {
      const isPair =
        Array.isArray(node) && node.length === 2 &&
        (node[1] === "asc" || node[1] === "desc");
      if (isPair) {
        const [expr, dir] = node as [SqlExpr, string];
        return [expr, dir === "asc" ? "desc" : "asc"];
      }
      return [node as SqlExpr, "desc"];
    });
    respond(res, next, signals.dialect ?? "postgres");
  },
};

// ============================================================================
// Server
// ============================================================================

const indexHtml = readFileSync(join(here, "index.html"), "utf8");

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(indexHtml);
    return;
  }

  const handler = routes[url.pathname];
  if (handler && req.method === "POST") {
    const signals = (await readSignals(req)) as Signals;
    try {
      handler(res, signals, url.searchParams);
    } catch (e) {
      // Any handler error becomes a status banner rather than a dead socket.
      respond(
        res,
        getDoc(signals),
        signals.dialect ?? "postgres",
        e instanceof Error ? e.message : String(e)
      );
    }
    return;
  }

  res.writeHead(404).end("not found");
}).listen(PORT, () => {
  console.log(`query-builder demo → http://localhost:${PORT}`);
});
