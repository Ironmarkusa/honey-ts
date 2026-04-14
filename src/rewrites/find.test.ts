import { describe, it } from "node:test";
import assert from "node:assert";
import { fromSql } from "../index.js";
import {
  findPredicates,
  findSelects,
  findTables,
  findJoins,
  findSubqueries,
  findFunctions,
  findParams,
} from "./find.js";
import { col, op, fn, dateRange, and, not } from "./matchers.js";

describe("findPredicates", () => {
  it("finds every matching predicate in a flat WHERE", () => {
    const clause = fromSql("SELECT * FROM t WHERE a = 1 AND b = 2 AND c = 3");
    const hits = findPredicates(clause, and(op("="), not(op("and"))));
    assert.strictEqual(hits.length, 3);
  });

  it("finds predicates inside subqueries (IN)", () => {
    const clause = fromSql(
      "SELECT * FROM a WHERE y IN (SELECT id FROM b WHERE date >= '2024-01-01')"
    );
    const hits = findPredicates(clause, dateRange("date"));
    assert.strictEqual(hits.length, 1);
    assert.match(hits[0]!.scope, /where/);
  });

  it("finds predicates inside CTEs", () => {
    const clause = fromSql(
      "WITH c AS (SELECT * FROM t WHERE d >= '2024-01-01') SELECT * FROM c WHERE d < '2025-01-01'"
    );
    const hits = findPredicates(clause, dateRange("d"));
    assert.strictEqual(hits.length, 2);
    const scopes = hits.map((h) => h.scope);
    assert.ok(scopes.some((s) => s.includes("with:")));
  });

  it("finds predicates in HAVING", () => {
    const clause = fromSql("SELECT status FROM t GROUP BY status HAVING count(*) > 5");
    const hits = findPredicates(clause, op(">"));
    assert.strictEqual(hits.length, 1);
    assert.match(hits[0]!.scope, /having/);
  });

  it("constrains dateRange matcher to specific columns", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE created_at >= '2024-01-01' AND updated_at < '2024-02-01'"
    );
    const hits = findPredicates(clause, dateRange("created_at"));
    assert.strictEqual(hits.length, 1);
  });

  it("handles BETWEEN", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE d BETWEEN '2024-01-01' AND '2024-12-31'"
    );
    const hits = findPredicates(clause, op("between"));
    assert.strictEqual(hits.length, 1);
  });
});

describe("findSelects", () => {
  it("finds bare column selects", () => {
    const clause = fromSql("SELECT id, email FROM users");
    const hits = findSelects(clause, col("email"));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0]!.alias, "email");
  });

  it("finds aliased expressions", () => {
    const clause = fromSql("SELECT COUNT(*) as total FROM users");
    const hits = findSelects(clause, fn("count"));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0]!.alias, "total");
  });

  it("finds selects across CTEs", () => {
    const clause = fromSql(
      "WITH c AS (SELECT id FROM t) SELECT id FROM c"
    );
    const hits = findSelects(clause, col("id"));
    assert.strictEqual(hits.length, 2);
  });
});

describe("findTables", () => {
  it("finds tables in FROM", () => {
    const clause = fromSql("SELECT * FROM users");
    const hits = findTables(clause);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0]!.table, "users");
    assert.strictEqual(hits[0]!.alias, null);
  });

  it("finds aliased tables", () => {
    const clause = fromSql("SELECT * FROM users u");
    const hits = findTables(clause);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0]!.table, "users");
    assert.strictEqual(hits[0]!.alias, "u");
  });

  it("finds tables in JOINs", () => {
    const clause = fromSql(
      "SELECT * FROM users u JOIN orders o ON u.id = o.user_id"
    );
    const hits = findTables(clause);
    const tables = hits.map((h) => h.table).sort();
    assert.deepStrictEqual(tables, ["orders", "users"]);
  });

  it("finds tables across CTEs and subqueries", () => {
    const clause = fromSql(
      "WITH c AS (SELECT * FROM a) SELECT * FROM c WHERE x IN (SELECT y FROM b)"
    );
    const hits = findTables(clause);
    const tables = hits.map((h) => h.table).sort();
    assert.deepStrictEqual(tables, ["a", "b", "c"]);
  });
});

describe("findJoins", () => {
  it("returns all joins when no matcher given", () => {
    const clause = fromSql(
      "SELECT * FROM a JOIN b ON a.id = b.a_id LEFT JOIN c ON b.id = c.b_id"
    );
    const hits = findJoins(clause);
    assert.strictEqual(hits.length, 2);
    const types = hits.map((h) => h.joinType).sort();
    assert.deepStrictEqual(types, ["join", "left-join"]);
  });

  it("filters by matcher on the join condition", () => {
    const clause = fromSql(
      "SELECT * FROM a JOIN b ON a.id = b.a_id JOIN c ON c.status = 'x'"
    );
    const hits = findJoins(clause, op("="));
    assert.strictEqual(hits.length, 2);
  });
});

describe("findSubqueries", () => {
  it("returns nested clauses excluding root", () => {
    const clause = fromSql(
      "SELECT * FROM a WHERE x IN (SELECT y FROM b)"
    );
    const subs = findSubqueries(clause);
    assert.strictEqual(subs.length, 1);
    assert.ok(subs[0]!.node.from === "b");
  });

  it("handles multi-CTE", () => {
    const clause = fromSql(
      "WITH c AS (SELECT * FROM a), d AS (SELECT * FROM b) SELECT * FROM c"
    );
    const subs = findSubqueries(clause);
    assert.strictEqual(subs.length, 2);
    const fromTables = subs.map((s) => s.node.from).sort();
    assert.deepStrictEqual(fromTables, ["a", "b"]);
  });

  it("walks UNION branches constructed programmatically", () => {
    const clause = {
      union: [
        { select: ["*"], from: "a", where: ["=", "x", { $: 1 }] },
        { select: ["*"], from: "b", where: ["=", "y", { $: 2 }] },
      ],
    };
    const subs = findSubqueries(clause);
    assert.strictEqual(subs.length, 2);
    const scopes = subs.map((s) => s.scope);
    assert.ok(scopes.some((s) => s.includes("union[0]")));
    assert.ok(scopes.some((s) => s.includes("union[1]")));
  });
});

describe("findFunctions", () => {
  it("finds COUNT in SELECT", () => {
    const clause = fromSql("SELECT COUNT(*) FROM t");
    const hits = findFunctions(clause, "count");
    assert.strictEqual(hits.length, 1);
  });

  it("finds functions in HAVING and GROUP BY", () => {
    const clause = fromSql(
      "SELECT status FROM t GROUP BY status HAVING COUNT(*) > 5"
    );
    const hits = findFunctions(clause, "count");
    assert.strictEqual(hits.length, 1);
  });

  it("accepts name with or without leading %", () => {
    const clause = fromSql("SELECT SUM(amount) FROM t");
    assert.strictEqual(findFunctions(clause, "sum").length, 1);
    assert.strictEqual(findFunctions(clause, "%sum").length, 1);
  });
});

describe("findParams", () => {
  it("finds literal values in WHERE", () => {
    const clause = fromSql("SELECT * FROM t WHERE a = 1 AND b = 'x'");
    const hits = findParams(clause);
    assert.strictEqual(hits.length, 2);
  });

  it("finds params across subqueries", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE x IN (SELECT y FROM b WHERE z = 10)"
    );
    const hits = findParams(clause);
    assert.ok(hits.length >= 1);
  });
});
