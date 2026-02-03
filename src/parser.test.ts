/**
 * Tests for SQL parsing and round-trip conversion.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { toSql, fromSql, normalizeSql } from "./index.js";

describe("fromSql", () => {
  describe("SELECT", () => {
    it("parses basic SELECT", () => {
      const clause = fromSql("SELECT id, name FROM users");
      assert.deepStrictEqual(clause.select, ["id", "name"]);
      assert.strictEqual(clause.from, "users");
    });

    it("parses SELECT *", () => {
      const clause = fromSql("SELECT * FROM users");
      assert.deepStrictEqual(clause.select, ["*"]);
    });

    it("parses SELECT with WHERE", () => {
      const clause = fromSql("SELECT * FROM users WHERE id = 1");
      assert.deepStrictEqual(clause.where, ["=", "id", { $: 1 }]);
    });

    it("parses SELECT with complex WHERE", () => {
      const clause = fromSql("SELECT * FROM users WHERE status = 'active' AND age > 18");
      assert.strictEqual((clause.where as unknown[])[0], "and");
    });

    it("parses SELECT with JOIN", () => {
      const clause = fromSql("SELECT u.id FROM users u JOIN orders o ON u.id = o.user_id");
      assert.ok(clause.join);
    });

    it("parses SELECT with ORDER BY", () => {
      const clause = fromSql("SELECT * FROM users ORDER BY created_at DESC");
      assert.ok(clause["order-by"]);
    });

    it("parses SELECT with LIMIT and OFFSET", () => {
      const clause = fromSql("SELECT * FROM users LIMIT 10 OFFSET 20");
      assert.deepStrictEqual(clause.limit, { $: 10 });
      assert.deepStrictEqual(clause.offset, { $: 20 });
    });

    it("parses SELECT with GROUP BY and HAVING", () => {
      const clause = fromSql("SELECT status, COUNT(*) FROM users GROUP BY status HAVING COUNT(*) > 5");
      assert.ok(clause["group-by"]);
      assert.ok(clause.having);
    });
  });

  describe("INSERT", () => {
    it("parses basic INSERT", () => {
      const clause = fromSql("INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')");
      assert.strictEqual(clause["insert-into"], "users");
      assert.ok(clause.columns);
      assert.ok(clause.values);
    });
  });

  describe("UPDATE", () => {
    it("parses basic UPDATE", () => {
      const clause = fromSql("UPDATE users SET name = 'Bob' WHERE id = 1");
      assert.strictEqual(clause.update, "users");
      assert.ok(clause.set);
      assert.ok(clause.where);
    });
  });

  describe("DELETE", () => {
    it("parses basic DELETE", () => {
      const clause = fromSql("DELETE FROM users WHERE id = 1");
      assert.strictEqual(clause["delete-from"], "users");
      assert.ok(clause.where);
    });
  });
});

describe("round-trip", () => {
  const testCases = [
    'SELECT "id", "name" FROM "users"',
    'SELECT * FROM "users" WHERE "id" = 1',
    'SELECT * FROM "users" WHERE "status" = \'active\'',
    'SELECT * FROM "users" ORDER BY "created_at" DESC',
    'SELECT * FROM "users" LIMIT 10',
    'SELECT "status", count(*) FROM "users" GROUP BY "status"',
    'DELETE FROM "users" WHERE "id" = 1',
  ];

  for (const sql of testCases) {
    it(`round-trips: ${sql.substring(0, 50)}...`, () => {
      const clause = fromSql(sql);
      const [resultSql] = toSql(clause, { inline: true, quoted: true });
      const normalizedInput = normalizeSql(sql);
      const normalizedOutput = normalizeSql(resultSql);
      assert.strictEqual(normalizedOutput, normalizedInput);
    });
  }
});

describe("round-trip edge cases", () => {
  const edgeCases = [
    // Qualified star
    "SELECT u.* FROM users u",

    // Aliased aggregates
    "SELECT SUM(total) as order_total FROM orders",
    "SELECT COUNT(*) as cnt FROM orders",

    // Window functions
    "SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) as rn FROM users",
    "SELECT id, ROW_NUMBER() OVER (ORDER BY id) as rn, SUM(amount) OVER (PARTITION BY category ORDER BY id) as running_total FROM orders",
    "SELECT COUNT(*) OVER () FROM users",

    // Nested subqueries
    "SELECT * FROM (SELECT * FROM (SELECT id FROM users) AS a) AS b",

    // CASE expression
    "SELECT CASE WHEN status = 'active' THEN 'Yes' ELSE 'No' END AS is_active FROM users",

    // COALESCE and NULL handling
    "SELECT COALESCE(name, 'Unknown') FROM users WHERE deleted_at IS NULL",

    // Multiple JOINs
    "SELECT u.name, o.total, p.name as product FROM users u JOIN orders o ON u.id = o.user_id JOIN products p ON o.product_id = p.id",

    // GROUP BY with HAVING
    "SELECT category, COUNT(*) as cnt FROM products GROUP BY category HAVING COUNT(*) > 5",

    // DISTINCT ON (PostgreSQL specific)
    "SELECT DISTINCT ON (user_id) * FROM orders ORDER BY user_id, created_at DESC",

    // Subquery in WHERE with IN
    "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > 100)",

    // Correlated subquery with EXISTS
    "SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)",

    // Scalar subquery in SELECT
    "SELECT name, (SELECT COUNT(*) FROM orders WHERE user_id = users.id) AS order_count FROM users",

    // CTE (WITH clause)
    "WITH active_users AS (SELECT * FROM users WHERE active = true) SELECT * FROM active_users",

    // UNION
    "SELECT id, name FROM users WHERE role = 'admin' UNION SELECT id, name FROM users WHERE role = 'superuser'",

    // Complex boolean expressions
    "SELECT * FROM users WHERE (status = 'active' OR status = 'pending') AND age >= 18 AND deleted_at IS NULL",

    // BETWEEN
    "SELECT * FROM orders WHERE total BETWEEN 100 AND 500",

    // LIKE patterns
    "SELECT * FROM users WHERE name LIKE 'A%'",

    // NOT IN
    "SELECT * FROM users WHERE id NOT IN (1, 2, 3)",

    // IS NOT NULL
    "SELECT * FROM users WHERE email IS NOT NULL",

    // Multiple ORDER BY columns
    "SELECT * FROM users ORDER BY last_name, first_name, created_at DESC",

    // COUNT(DISTINCT)
    "SELECT department, COUNT(DISTINCT user_id) as unique_users FROM orders GROUP BY department",

    // FILTER clause on aggregate
    "SELECT COUNT(*) FILTER (WHERE status = 'active') as active_count FROM users",

    // LATERAL subquery
    "SELECT u.id FROM users u, LATERAL (SELECT * FROM orders WHERE user_id = u.id LIMIT 3) o",

    // ON CONFLICT DO UPDATE
    "INSERT INTO users (id, name) VALUES (1, 'Alice') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",

    // ARRAY constructor
    "SELECT ARRAY[1, 2, 3]",
    "SELECT * FROM users WHERE id = ANY(ARRAY[1, 2, 3])",

    // WITH RECURSIVE
    "WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 10) SELECT * FROM nums",

    // GROUP BY CUBE and ROLLUP
    "SELECT a, b, SUM(c) FROM t GROUP BY CUBE (a, b)",
    "SELECT a, b, SUM(c) FROM t GROUP BY ROLLUP (a, b)",

    // RETURNING with expressions
    "INSERT INTO t (a) VALUES (1) RETURNING *, a + 1 as next",
  ];

  for (const sql of edgeCases) {
    it(`round-trips: ${sql.substring(0, 60)}${sql.length > 60 ? "..." : ""}`, () => {
      const clause = fromSql(sql);
      const [resultSql] = toSql(clause, { inline: true, quoted: true });
      const normalizedInput = normalizeSql(sql);
      const normalizedOutput = normalizeSql(resultSql);
      assert.strictEqual(normalizedOutput, normalizedInput);
    });
  }
});

describe("normalizeSql", () => {
  it("normalizes whitespace", () => {
    const sql1 = "SELECT   id,  name   FROM   users";
    const sql2 = "SELECT id, name FROM users";
    assert.strictEqual(normalizeSql(sql1), normalizeSql(sql2));
  });

  it("normalizes case", () => {
    const sql1 = "select ID, NAME from USERS";
    const sql2 = "SELECT id, name FROM users";
    assert.strictEqual(normalizeSql(sql1), normalizeSql(sql2));
  });
});
