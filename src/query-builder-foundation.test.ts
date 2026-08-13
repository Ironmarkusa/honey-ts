/**
 * Tests for the query-builder foundation: schema loaders, type inference,
 * deep validation, and path addressing — plus an end-to-end scenario walking
 * the full loop a UI would drive.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  fromSql, toSql, $, modify, matchers, paths,
  createInferrer, validateQuery, normalizeType, typesComparable,
  schemaFromDuckDb,
} from "./index.js";
import { DUCKDB_FUNCTIONS_BY_NAME } from "./duckdb-ops.generated.js";
import type { DatabaseSchema, SqlClause } from "./index.js";

// A hand schema mirroring the loader test, used by inference/validation tests.
const SCHEMA: DatabaseSchema = {
  tables: [
    {
      name: "users", schema: "main",
      columns: [
        { name: "id", type: "INTEGER", nullable: false, isPrimaryKey: true },
        { name: "email", type: "VARCHAR", nullable: false },
        { name: "name", type: "VARCHAR", nullable: true },
        { name: "created_at", type: "TIMESTAMP", nullable: false },
      ],
    },
    {
      name: "orders", schema: "main",
      columns: [
        { name: "id", type: "INTEGER", nullable: false, isPrimaryKey: true },
        { name: "user_id", type: "INTEGER", nullable: false, isForeignKey: true, references: { table: "users", column: "id" } },
        { name: "total", type: "DECIMAL(10,2)", nullable: false },
        { name: "status", type: "VARCHAR", nullable: false },
        { name: "placed_at", type: "TIMESTAMPTZ", nullable: false },
      ],
    },
  ],
};

// ===========================================================================
describe("type normalization", () => {
  test("aliases collapse to canonical names", () => {
    assert.equal(normalizeType("VARCHAR"), "text");
    assert.equal(normalizeType("character varying"), "text");
    assert.equal(normalizeType("DOUBLE PRECISION"), "double");
    assert.equal(normalizeType("DECIMAL(10,2)"), "numeric(10,2)");
    assert.equal(normalizeType("INT8"), "bigint");
    assert.equal(normalizeType("BOOL"), "boolean");
  });

  test("comparability groups numerics and temporals", () => {
    assert.ok(typesComparable("integer", "numeric(10,2)"));
    assert.ok(typesComparable("timestamp", "date"));
    assert.ok(!typesComparable("text", "integer"));
    assert.ok(!typesComparable("boolean", "integer"));
  });
});

// ===========================================================================
describe("type inference", () => {
  const clause = fromSql(
    "SELECT * FROM users u JOIN orders o ON u.id = o.user_id"
  );
  const infer = createInferrer(SCHEMA, clause);

  const cases: Array<[string, unknown, string | null]> = [
    ["qualified column", "u.email", "text"],
    ["unqualified column", "total", "numeric(10,2)"],
    ["alias-resolved column", "o.placed_at", "timestamptz"],
    ["unknown column", "u.nope", null],
    ["integer literal", 42, "integer"],
    ["float literal", 4.5, "double"],
    ["string param", { $: "x" }, "text"],
    ["cast", ["cast", "u.id", "text"], "text"],
    ["cast keeps precision", ["cast", "o.total", "numeric(7,4)"], "numeric(7,4)"],
    ["comparison is boolean", ["=", "u.id", { $: 1 }], "boolean"],
    ["AND is boolean", ["and", ["=", "u.id", 1], ["=", "o.status", { $: "a" }]], "boolean"],
    ["count is bigint", ["%count", "*"], "bigint"],
    ["sum widens integer", ["%sum", "u.id"], "bigint"],
    ["sum keeps numeric", ["%sum", "o.total"], "numeric(10,2)"],
    ["min follows arg", ["%min", "o.placed_at"], "timestamptz"],
    ["coalesce follows args", ["%coalesce", "u.name", { $: "anon" }], "text"],
    ["lower is text", ["%lower", "u.email"], "text"],
    ["date_trunc", ["%date_trunc", { v: "month" }, "o.placed_at"], "timestamp"],
    ["arith promotes", ["+", "u.id", "o.total"], "numeric(10,2)"],
    ["timestamp + interval", ["+", "o.placed_at", ["interval", { v: "1 day" }]], "timestamptz"],
    ["case branches", ["case", ["=", "u.id", 1], { $: "yes" }, { $: "no" }], "text"],
    ["window fn passthrough", ["over", ["%row_number"], {}], "bigint"],
    ["scalar subquery", { select: [["%count", "*"]], from: "orders" }, "bigint"],
    ["concat", ["||", "u.email", { $: "!" }], "text"],
  ];

  for (const [name, expr, expected] of cases) {
    test(name, () => {
      const t = infer.typeOf(expr as never);
      if (expected === null) assert.equal(t, null);
      else assert.equal(t?.type, expected, JSON.stringify(t));
    });
  }

  test("nullable tracking", () => {
    assert.equal(infer.typeOf("u.name")?.nullable, true);
    assert.equal(infer.typeOf("u.email")?.nullable, false);
    assert.equal(infer.typeOf(["try-cast", "u.email", "integer"])?.nullable, true);
  });

  test("duckdb catalog lookup via injected catalog", () => {
    const dInfer = createInferrer(SCHEMA, clause, {
      dialect: "duckdb",
      catalog: (name) => DUCKDB_FUNCTIONS_BY_NAME.get(name)?.returnType,
    });
    assert.equal(dInfer.typeOf(["%levenshtein", "u.email", { $: "x" }])?.type, "bigint");
    assert.equal(dInfer.typeOf(["%to_hex", "u.id"])?.type, "text");
  });
});

// ===========================================================================
describe("validateQuery", () => {
  test("clean query validates", () => {
    const clause = fromSql(
      "SELECT u.email, count(*) AS n FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.email"
    );
    const result = validateQuery(clause, SCHEMA);
    assert.deepEqual(result.problems, []);
    assert.ok(result.valid);
  });

  test("unknown table, with hint", () => {
    const result = validateQuery(fromSql("SELECT * FROM userz"), SCHEMA);
    assert.ok(!result.valid);
    const p = result.problems.find((x) => x.code === "unknown-table")!;
    assert.match(p.message, /userz/);
    assert.match(p.hint ?? "", /users/);
  });

  test("unknown column, with did-you-mean", () => {
    const result = validateQuery(fromSql("SELECT emial FROM users"), SCHEMA);
    const p = result.problems.find((x) => x.code === "unknown-column")!;
    assert.match(p.message, /emial/);
    assert.match(p.hint ?? "", /email/);
    assert.equal(p.scope, "root.select");
  });

  test("ungrouped column", () => {
    const result = validateQuery(
      fromSql("SELECT status, count(*) FROM orders"), SCHEMA
    );
    const p = result.problems.find((x) => x.code === "ungrouped-column")!;
    assert.match(p.message, /status/);
  });

  test("GROUP BY covers the column — no problem", () => {
    const result = validateQuery(
      fromSql("SELECT status, count(*) FROM orders GROUP BY status"), SCHEMA
    );
    assert.equal(result.problems.filter((p) => p.code === "ungrouped-column").length, 0);
  });

  test("GROUP BY ALL suppresses the check", () => {
    const clause = fromSql("SELECT status, count(*) FROM orders GROUP BY ALL", { dialect: "duckdb" });
    const result = validateQuery(clause, SCHEMA);
    assert.equal(result.problems.filter((p) => p.code === "ungrouped-column").length, 0);
  });

  test("aggregate in WHERE", () => {
    const result = validateQuery(
      fromSql("SELECT id FROM orders WHERE sum(total) > 10"), SCHEMA
    );
    assert.ok(result.problems.some((p) => p.code === "aggregate-in-where"));
  });

  test("nested aggregates", () => {
    const result = validateQuery(
      { select: [["%sum", ["%count", "*"]]], from: "orders" } as SqlClause, SCHEMA
    );
    assert.ok(result.problems.some((p) => p.code === "nested-aggregate"));
  });

  test("type mismatch warning", () => {
    const result = validateQuery(
      fromSql("SELECT id FROM orders WHERE status = 5"), SCHEMA
    );
    const p = result.problems.find((x) => x.code === "type-mismatch")!;
    assert.equal(p.severity, "warning");
    assert.match(p.message, /text.*integer|integer.*text/);
    assert.ok(result.valid, "warnings don't invalidate");
  });

  test("strictTypes upgrades mismatches to errors", () => {
    const result = validateQuery(
      fromSql("SELECT id FROM orders WHERE status = 5"), SCHEMA,
      { strictTypes: true }
    );
    assert.ok(!result.valid);
  });

  test("ORDER BY ordinal out of range", () => {
    const result = validateQuery(
      fromSql("SELECT id FROM orders ORDER BY 3"), SCHEMA
    );
    assert.ok(result.problems.some((p) => p.code === "order-by-ordinal"));
  });

  test("subquery scopes validate independently", () => {
    const result = validateQuery(
      fromSql("SELECT id FROM orders WHERE user_id IN (SELECT nope FROM users)"), SCHEMA
    );
    const p = result.problems.find((x) => x.code === "unknown-column")!;
    assert.match(p.scope, /where/);
  });

  test("correlated subqueries resolve outer aliases", () => {
    const result = validateQuery(
      fromSql("SELECT u.email FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)"),
      SCHEMA
    );
    const unknown = result.problems.filter((x) => x.code === "unknown-column");
    assert.deepEqual(unknown, [], JSON.stringify(unknown));
  });

  test("correlated resolution still catches real typos in the inner scope", () => {
    const result = validateQuery(
      fromSql("SELECT u.email FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_idz = u.id)"),
      SCHEMA
    );
    const p = result.problems.find((x) => x.code === "unknown-column")!;
    assert.match(p.message, /user_idz/);
  });
});

// ===========================================================================
describe("paths", () => {
  const clause = fromSql(
    "SELECT id, status FROM orders WHERE status = 'a' AND total > 10 ORDER BY id"
  );

  test("findPaths locates predicates with addresses", () => {
    // col() matches ident nodes; op() matches predicate heads.
    const colHits = paths.findPaths(clause, matchers.col("total"));
    assert.ok(colHits.length >= 1, "found the total ident");
    const hits = paths.findPaths(clause, matchers.op(">"));
    assert.equal(hits.length, 1);
    assert.deepEqual(paths.getAt(clause, hits[0]!.path), hits[0]!.node);
  });

  test("setAt replaces exactly one node, immutably", () => {
    const hits = paths.findPaths(clause, matchers.op(">"));
    const edited = paths.setAt(clause, hits[0]!.path, [">=", "total", $(50)]);
    assert.notEqual(edited, clause);
    assert.match(toSql(edited, { inline: true })[0], /total >= 50/);
    // original untouched
    assert.match(toSql(clause, { inline: true })[0], /total > 10/);
  });

  test("removeAt heals a two-arm AND", () => {
    const hits = paths.findPaths(clause, matchers.op(">"));
    const removed = paths.removeAt(clause, hits[0]!.path);
    const [sql] = toSql(removed, { inline: true });
    assert.match(sql, /WHERE status = 'a'/);
    assert.doesNotMatch(sql, /AND|total/);
  });

  test("updateAt transforms in place", () => {
    const hits = paths.findPaths(clause, matchers.op(">"));
    const edited = paths.updateAt(clause, hits[0]!.path, (n) => ["not", n as never]);
    assert.match(toSql(edited, { inline: true })[0], /NOT \(?total > 10\)?/);
  });

  test("paths reach into joins and subqueries", () => {
    const q = fromSql(
      "SELECT * FROM orders o JOIN (SELECT id FROM users WHERE email = 'x') u ON o.user_id = u.id"
    );
    // The email ident lives inside the joined subquery's WHERE.
    const hits = paths.findPaths(q, matchers.col("email"));
    assert.ok(hits.length >= 1);
    for (const h of hits) {
      assert.deepEqual(paths.getAt(q, h.path), h.node);
      assert.ok(h.path[0] === "join", `path enters the join: ${JSON.stringify(h.path)}`);
    }
  });
});

// ===========================================================================
describe("end to end: the query-builder loop", () => {
  test("introspect → build → infer → validate → address → emit → execute", async () => {
    // 1. Real database, real introspection.
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    await conn.run("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, plan TEXT)");
    await conn.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), total DECIMAL(10,2) NOT NULL)");
    await conn.run("INSERT INTO users VALUES (1, 'a@x.com', 'pro'), (2, 'b@x.com', 'free')");
    await conn.run("INSERT INTO orders VALUES (10, 1, 100.00), (11, 1, 50.00), (12, 2, 5.00)");
    const schema = await schemaFromDuckDb(async (sql) =>
      (await (await conn.run(sql)).getRowObjectsJson()) as never
    );
    assert.equal(schema.tables.length, 2);

    // 2. Build the query the way a UI would.
    let clause: SqlClause = fromSql(
      "SELECT u.plan, sum(o.total) AS revenue FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.plan",
      { dialect: "duckdb" }
    );
    clause = modify.addWhere(clause, [">", "o.total", $(1)]);

    // 3. Types for UI labels.
    const infer = createInferrer(schema, clause, { dialect: "duckdb" });
    assert.equal(infer.typeOf("u.plan")?.type, "text");
    assert.equal(infer.typeOf(["%sum", "o.total"])?.type, "numeric(10,2)");

    // 4. Validation is clean.
    const validation = validateQuery(clause, schema, { dialect: "duckdb" });
    assert.deepEqual(validation.problems, []);

    // 5. Address and tweak one predicate.
    const hit = paths.findPaths(clause, matchers.op(">"))[0]!;
    clause = paths.setAt(clause, hit.path, [">", "o.total", $(10)]);

    // 6. Emit and actually run it.
    const [sql, ...params] = toSql(clause, { dialect: "duckdb" });
    const prepared = sql.replace(/\?/g, () => String(params.shift()));
    const rows = await (await conn.run(prepared)).getRowObjectsJson();
    const byPlan = Object.fromEntries(rows.map((r) => [r.plan, Number(r.revenue)]));
    assert.equal(byPlan.pro, 150);
    assert.equal(byPlan.free, undefined); // 5.00 order filtered out
  });
});
