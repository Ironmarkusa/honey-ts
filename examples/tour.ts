/**
 * honey-ts tour — the full query-builder loop against a real DuckDB database.
 *
 * Run with:  npx tsx examples/tour.ts
 */

import { DuckDBInstance } from "@duckdb/node-api";
import {
  createEnv, schemaFromDuckDb,
  fromSql, toSql, sql, $, duckdb,
  modify, rewrite, matchers, paths, analyze, raw,
} from "../src/index.js";
import { DUCKDB_FUNCTIONS_BY_NAME } from "../src/duckdb-ops.generated.js";

const h = (title: string) => console.log(`\n\x1b[1m━━ ${title} ━━\x1b[0m`);

// ═══════════════════════════════════════════════════════════════════════════
// 0. A real database with some data in it
// ═══════════════════════════════════════════════════════════════════════════

const conn = await (await DuckDBInstance.create(":memory:")).connect();
await conn.run(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    plan TEXT NOT NULL,
    tenant_id TEXT NOT NULL
  )`);
await conn.run(`
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    total DECIMAL(10,2) NOT NULL,
    placed_at TIMESTAMP NOT NULL,
    tenant_id TEXT NOT NULL
  )`);
await conn.run(`
  INSERT INTO users VALUES
    (1, 'ada@ironmark.io',  'pro',  't1'),
    (2, 'gray@ironmark.io', 'free', 't1'),
    (3, 'mallory@evil.com', 'pro',  't2')`);
await conn.run(`
  INSERT INTO orders VALUES
    (10, 1, 120.00, '2026-07-03', 't1'),
    (11, 1,  80.00, '2026-08-01', 't1'),
    (12, 2,  15.50, '2026-08-05', 't1'),
    (13, 3, 999.99, '2026-08-06', 't2')`);

const run = async (q: string) =>
  (await (await conn.run(q)).getRowObjectsJson());

// ═══════════════════════════════════════════════════════════════════════════
// 1. Introspect the schema, build the environment — the composition root
// ═══════════════════════════════════════════════════════════════════════════

h("1. schema introspection → createEnv");

const schema = await schemaFromDuckDb(async (q) => (await run(q)) as never);
console.log(
  "tables:",
  schema.tables.map((t) => `${t.name}(${t.columns.length} cols)`).join(", ")
);
const fk = schema.tables.find((t) => t.name === "orders")!.columns.find((c) => c.isForeignKey)!;
console.log(`FK found: orders.${fk.name} → ${fk.references!.table}.${fk.references!.column}`);

const env = createEnv({
  dialect: "duckdb",
  schema,
  catalog: DUCKDB_FUNCTIONS_BY_NAME,
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. An "LLM" hands us SQL. Parse it — it's just data now.
// ═══════════════════════════════════════════════════════════════════════════

h("2. parse LLM SQL → plain-data clause map");

const llmSql = `
  SELECT u.plan, sum(o.total) AS revenue, count(*) AS orders
  FROM users u JOIN orders o ON u.id = o.user_id
  WHERE o.placed_at >= '2026-08-01'
  GROUP BY u.plan`;

let doc = env.parse(llmSql);
console.log(JSON.stringify(doc, null, 2).slice(0, 400) + " …");

// ═══════════════════════════════════════════════════════════════════════════
// 3. Tenant isolation — one call, reaches every subquery and join
// ═══════════════════════════════════════════════════════════════════════════

h("3. modify.addWhere — tenant isolation");

doc = modify.addWhere(doc, ["=", "o.tenant_id", $("t1")]);
console.log(env.emit(doc, { inline: true })[0]);

// ═══════════════════════════════════════════════════════════════════════════
// 4. Types for the UI — including computed columns
// ═══════════════════════════════════════════════════════════════════════════

h("4. type inference");

for (const [label, expr] of [
  ["u.plan               ", "u.plan"],
  ["sum(o.total)         ", ["%sum", "o.total"]],
  ["date_trunc month     ", ["%date_trunc", { v: "month" }, "o.placed_at"]],
  ["total > 100 (predicate)", [">", "o.total", $(100)]],
] as const) {
  console.log(`${label} :`, env.typeOf(doc, expr as never));
}

console.log("operators for text     :", env.operatorsFor("text").map((o) => o.op).join(" "));
console.log("functions for timestamp:", env.functionsFor("timestamp").slice(0, 8).map((f) => f.label).join(", "), "…");

// ═══════════════════════════════════════════════════════════════════════════
// 5. Validation — UI-ready errors with did-you-mean
// ═══════════════════════════════════════════════════════════════════════════

h("5. validation");

console.log("current doc valid?", env.validate(doc).valid);

const typo = env.parse("SELECT plann, sum(total) FROM orders");
for (const p of env.validate(typo).problems) {
  console.log(`[${p.severity}] ${p.code} @ ${p.scope}\n  ${p.message}${p.hint ? `\n  ${p.hint}` : ""}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Address a node like a UI would — edit exactly one predicate
// ═══════════════════════════════════════════════════════════════════════════

h("6. paths — the 'user clicked this chip' primitive");

const [hit] = paths.findPaths(doc, matchers.op(">="));
console.log("found predicate at path:", JSON.stringify(hit!.path), "=", JSON.stringify(hit!.node));
doc = paths.setAt(doc, hit!.path, [">=", "o.placed_at", $("2026-07-01")]);
console.log("after edit:", env.emit(doc, { inline: true })[0].match(/placed_at >= '[^']+'/)![0]);

// ═══════════════════════════════════════════════════════════════════════════
// 7. Portability — can this document run on Postgres too?
// ═══════════════════════════════════════════════════════════════════════════

h("7. emittable — document portability");

console.log("this report runs on:", env.emittable(doc).join(", "));

const duckOnly = { select: [duckdb.list($(1), $(2)), duckdb.star({ exclude: ["tenant_id"] })], from: "orders" };
console.log("list + EXCLUDE runs on:", env.emittable(duckOnly as never).join(", "));

const pgOnly = fromSql("SELECT * FROM orders WHERE doc @@ query");
console.log("@@ full-text runs on  :", env.emittable(pgOnly).join(", "));

// ═══════════════════════════════════════════════════════════════════════════
// 8. Emit and EXECUTE — the round trip ends in real rows
// ═══════════════════════════════════════════════════════════════════════════

h("8. execute");

const [finalSql] = env.emit(doc, { inline: true });
console.log(finalSql);
console.table(await run(finalSql));

// Note what tenant isolation did: mallory's 999.99 order (tenant t2) is gone.

// ═══════════════════════════════════════════════════════════════════════════
// 9. Sugar worth knowing: sql`` fragments and cross-dialect emission
// ═══════════════════════════════════════════════════════════════════════════

h("9. sql`` fragments + dialect transpilation");

const fragment = {
  select: ["email"],
  from: "users",
  where: sql`plan = ${"pro"} AND tenant_id = ${"t1"}`,
};
const [fsql, ...fparams] = env.emit(fragment as never);
console.log("fragment:", fsql, "| params:", JSON.stringify(fparams));

const pgRegex = fromSql("SELECT email FROM users WHERE email ~* '^a'");
console.log("pg emit  :", toSql(pgRegex, { inline: true })[0]);
console.log("duck emit:", toSql(pgRegex, { dialect: "duckdb", inline: true })[0], " ← ~* lowered");

// And overrideSelects, the LLM-guardrail classic:
const masked = rewrite.overrideSelects(env.parse("SELECT u.email FROM users u"), {
  "users.email": raw("md5(u.email)"),
});
console.log("masked   :", env.emit(masked, { inline: true })[0]);

// Column lineage for a UI tooltip:
const lineage = analyze.analyzeSelects(doc);
console.log("lineage  :", lineage.items.map((i) => `${i.alias} ← ${i.sources.join("+") || "(computed)"}`).join(" | "));
