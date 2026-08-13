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
  fromSql, modify, paths, $, createEnv,
  type SqlClause, type SqlExpr, type Env, type DatabaseSchema,
} from "../../src/index.js";
import { DUCKDB_FUNCTIONS_BY_NAME } from "../../src/duckdb-ops.generated.js";
import type { Path } from "../../src/paths.js";
import { createQueryBuilder } from "../../src/builder.js";
import { renderBuilder, renderOutput, renderProblems, renderStatus } from "./render.js";

const PORT = Number(process.env.PORT ?? 4321);
const here = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Demo schema — lets the env infer column types, so operator dropdowns are
// enumerated per type (text vs numeric vs timestamp vs json).
// ============================================================================

const DEMO_SCHEMA: DatabaseSchema = {
  tables: [
    {
      name: "users", schema: "public",
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimaryKey: true },
        { name: "company_id", type: "integer", nullable: true, isForeignKey: true, references: { table: "companies", column: "id" } },
        { name: "email", type: "text", nullable: false },
        { name: "name", type: "text", nullable: true },
        { name: "plan", type: "text", nullable: false },
        { name: "gmv_cents", type: "bigint", nullable: false },
        { name: "created_at", type: "timestamp", nullable: false },
      ],
    },
    {
      name: "orders", schema: "public",
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimaryKey: true },
        { name: "user_id", type: "integer", nullable: false, isForeignKey: true, references: { table: "users", column: "id" } },
        { name: "tenant_id", type: "text", nullable: false },
        { name: "status", type: "text", nullable: false },
        { name: "total", type: "numeric", nullable: false },
        { name: "placed_at", type: "timestamp", nullable: false },
        { name: "meta", type: "jsonb", nullable: true },
        { name: "region", type: "text", nullable: true },
        { name: "plan", type: "text", nullable: true },
      ],
    },
    {
      name: "companies", schema: "public",
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimaryKey: true },
        { name: "name", type: "text", nullable: false },
        { name: "region", type: "text", nullable: true },
      ],
    },
    {
      name: "refunds", schema: "public",
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimaryKey: true },
        { name: "order_id", type: "integer", nullable: false, isForeignKey: true, references: { table: "orders", column: "id" } },
      ],
    },
    {
      name: "events", schema: "public",
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimaryKey: true },
        { name: "ts", type: "timestamp", nullable: false },
        { name: "total", type: "numeric", nullable: true },
        { name: "status", type: "text", nullable: true },
        { name: "payload", type: "jsonb", nullable: true },
        { name: "raw_payload", type: "text", nullable: true },
      ],
    },
  ],
};

const ENVS: Record<string, Env> = {
  postgres: createEnv({ dialect: "postgres", schema: DEMO_SCHEMA }),
  duckdb: createEnv({ dialect: "duckdb", schema: DEMO_SCHEMA, catalog: DUCKDB_FUNCTIONS_BY_NAME }),
};
const envFor = (dialect: string): Env => ENVS[dialect] ?? ENVS.postgres;

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
  history?: string;
}

function getDoc(signals: Signals): SqlClause | null {
  if (!signals.docjson) return null;
  try {
    return JSON.parse(signals.docjson) as SqlClause;
  } catch {
    return null;
  }
}

/** "42" → 42, "null" → null, "true" → true, anything else → string. */
function coerceScalar(raw: string): unknown {
  const t = raw.trim();
  if (t.toLowerCase() === "null") return null;
  if (t.toLowerCase() === "true") return true;
  if (t.toLowerCase() === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

const BLANK_CONDITION: SqlExpr = ["=", "column", { $: "value" }];

/** Everything the client needs after any change. */
function respond(
  res: ServerResponse,
  doc: SqlClause | null,
  dialect: string,
  status: string | null = null,
  history?: string,
  extraSignals?: Record<string, unknown>
): void {
  sseStart(res);
  patchSignals(res, {
    docjson: doc ? JSON.stringify(doc) : "",
    ...(history !== undefined ? { history } : {}),
    ...extraSignals,
  });
  patchElements(res, renderBuilder(doc, dialect, envFor(dialect)));
  patchElements(res, renderOutput(doc, dialect, envFor(dialect)));
  patchElements(res, renderProblems(doc, envFor(dialect)));
  patchElements(res, renderStatus(status));
  res.end();
}

/** Current document snapshot pushed onto the undo stack (capped at 50). */
function pushedHistory(signals: Signals): string | undefined {
  if (!signals.docjson) return undefined;
  try {
    const h = JSON.parse(signals.history ?? "[]") as string[];
    h.push(signals.docjson);
    while (h.length > 50) h.shift();
    return JSON.stringify(h);
  } catch {
    return undefined;
  }
}

/** respond() for mutating routes: snapshots the pre-edit document for undo. */
function respondM(
  res: ServerResponse,
  signals: Signals,
  doc: SqlClause | null,
  status: string | null = null,
  extraSignals?: Record<string, unknown>
): void {
  respond(res, doc, signals.dialect ?? "postgres", status, pushedHistory(signals), extraSignals);
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
      respond(res, doc, dialect, null, "[]"); // fresh document, fresh undo stack
    } catch (e) {
      respond(res, getDoc(signals), dialect, e instanceof Error ? e.message : String(e));
    }
  },

  // Dialect changed (or any re-render request): keep the document, re-emit.
  "/render": (res, signals) => {
    respond(res, getDoc(signals), signals.dialect ?? "postgres");
  },

  // Edit any leaf slot. kind: ident | param | lit | fn.
  "/edit": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    const kind = query.get("kind") ?? "ident";
    const edit = signals.edit ?? "";
    const value: SqlExpr =
      kind === "param" ? ({ $: coerceScalar(edit) } as SqlExpr)
      : kind === "lit" ? ({ v: coerceScalar(edit) } as SqlExpr)
      : kind === "fn" ? (("%" + edit.trim().replace(/^%/, "").toLowerCase()) as SqlExpr)
      : (edit.trim() as SqlExpr);
    respondM(res, signals, paths.setAt(doc, path, value));
  },

  // Change a predicate's operator, reshaping the node when the new operator
  // wants a different value shape (single / none / list / range).
  "/set-op": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const dialect = signals.dialect ?? "postgres";
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    const op = (signals.edit ?? "").trim();
    const env = envFor(dialect);

    // op → valueType, from the env's operator table across common types.
    let shape: "single" | "none" | "list" | "range" = "single";
    for (const t of ["text", "integer", "numeric", "timestamp", "jsonb"]) {
      const hit = env.operatorsFor(t).find((o) => o.op === op);
      if (hit) { shape = hit.valueType as typeof shape; break; }
    }

    const next = paths.updateAt(doc, path, (node) => {
      const arr = node as SqlExpr[];
      const lhs = arr[1];
      const prev = arr[2];
      const prevScalar: SqlExpr =
        prev !== undefined && prev !== null && !Array.isArray(prev)
          ? prev
          : Array.isArray(prev) && prev.length ? (prev[0] as SqlExpr) : ({ $: "" } as SqlExpr);
      switch (shape) {
        case "none": return [op, lhs, null];
        case "list": return [op, lhs, Array.isArray(prev) ? prev : [prevScalar]];
        case "range": return [op, lhs, prevScalar, { $: 100 } as SqlExpr];
        default: return [op, lhs, prevScalar];
      }
    });
    respondM(res, signals, next);
  },

  // Change an arithmetic/concat head in place (same arity, no reshape).
  "/set-head": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    respondM(res, signals, paths.setAt(doc, [...path, 0], (signals.edit ?? "").trim() as SqlExpr));
  },

  // Append an item to a value-list (IN) or expression-list (PARTITION BY).
  "/add-item": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    const item: SqlExpr = query.get("kind") === "ident" ? "column" : ({ $: "" } as SqlExpr);
    const next = paths.updateAt(doc, path, (node) => [
      ...(node as SqlExpr[]),
      item,
    ]);
    respondM(res, signals, next);
  },

  // Strip a wrapper (e.g. NOT) — replaces the node with its operand.
  "/unwrap": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    const next = paths.updateAt(doc, path, (node) =>
      Array.isArray(node) && node.length >= 2 ? (node[1] as SqlExpr) : (node as SqlExpr)
    );
    respondM(res, signals, next);
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
    respondM(res, signals, next);
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
    respondM(res, signals, next);
  },

  "/remove": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    respondM(res, signals, paths.removeAt(doc, path));
  },

  "/add-select": (res, signals) => {
    const doc = getDoc(signals);
    const col = (signals.newcol ?? "").trim();
    if (!doc || !col) return respond(res, doc, signals.dialect ?? "postgres");
    respondM(res, signals, modify.addSelect(doc, col), null, { newcol: "" });
  },

  // Pop the undo stack and restore that document.
  "/undo": (res, signals) => {
    const dialect = signals.dialect ?? "postgres";
    let h: string[] = [];
    try { h = JSON.parse(signals.history ?? "[]") as string[]; } catch { /* fresh stack */ }
    if (!h.length) return respond(res, getDoc(signals), dialect);
    const prev = h.pop()!;
    let doc: SqlClause | null = null;
    try { doc = JSON.parse(prev) as SqlClause; } catch { /* unparseable snapshot */ }
    respond(res, doc, dialect, null, JSON.stringify(h));
  },

  // Wrap a node: kind=not → ["not", node]; kind=fn → ["%lower", node] (name editable after).
  "/wrap": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const path = JSON.parse(query.get("path") ?? "[]") as Path;
    const kind = query.get("kind") ?? "not";
    const next = paths.updateAt(doc, path, (node) =>
      kind === "fn" ? (["%lower", node] as SqlExpr) : (["not", node] as SqlExpr)
    );
    respondM(res, signals, next);
  },

  // Add a suggested FK join (table name from the suggestion button).
  "/add-join": (res, signals, query) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const table = query.get("table") ?? "";
    const qb = createQueryBuilder(DEMO_SCHEMA);
    const hit = qb.getJoinableTables(doc).find((j) => j.table.name === table);
    if (!hit) return respond(res, doc, signals.dialect ?? "postgres", `No joinable table "${table}".`);
    respondM(res, signals, qb.addJoin(doc, hit.table.name, hit.suggestedOn, hit.joinType));
  },

  "/add-groupby": (res, signals) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const items = doc["group-by"] === undefined ? [] : Array.isArray(doc["group-by"]) ? doc["group-by"] : [doc["group-by"]];
    respondM(res, signals, { ...doc, "group-by": [...items, "column"] } as SqlClause);
  },

  "/add-orderby": (res, signals) => {
    const doc = getDoc(signals);
    if (!doc) return respond(res, null, signals.dialect ?? "postgres");
    const items = doc["order-by"] === undefined ? [] : Array.isArray(doc["order-by"]) ? doc["order-by"] : [doc["order-by"]];
    respondM(res, signals, { ...doc, "order-by": [...items, ["column", "asc"]] } as SqlClause);
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
    respondM(res, signals, next);
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
    respondM(res, signals, next);
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
      console.error(`[${url.pathname}]`, e);
      // Any handler error becomes a status banner rather than a dead socket —
      // unless the stream already started, in which case just close it.
      if (res.headersSent) {
        res.end();
      } else {
        respond(
          res,
          getDoc(signals),
          signals.dialect ?? "postgres",
          e instanceof Error ? e.message : String(e)
        );
      }
    }
    return;
  }

  res.writeHead(404).end("not found");
}).listen(PORT, () => {
  console.log(`query-builder demo → http://localhost:${PORT}`);
});
