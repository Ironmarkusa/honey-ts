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
      assert.deepStrictEqual(clause.select, [":id", ":name"]);
      assert.strictEqual(clause.from, ":users");
    });

    it("parses SELECT *", () => {
      const clause = fromSql("SELECT * FROM users");
      assert.deepStrictEqual(clause.select, ["*"]);
    });

    it("parses SELECT with WHERE", () => {
      const clause = fromSql("SELECT * FROM users WHERE id = 1");
      assert.deepStrictEqual(clause.where, ["=", ":id", 1]);
    });

    it("parses SELECT with complex WHERE", () => {
      const clause = fromSql("SELECT * FROM users WHERE status = 'active' AND age > 18");
      assert.strictEqual(clause.where![0], "and");
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
      assert.strictEqual(clause.limit, 10);
      assert.strictEqual(clause.offset, 20);
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
      assert.strictEqual(clause["insert-into"], ":users");
      assert.ok(clause.columns);
      assert.ok(clause.values);
    });
  });

  describe("UPDATE", () => {
    it("parses basic UPDATE", () => {
      const clause = fromSql("UPDATE users SET name = 'Bob' WHERE id = 1");
      assert.strictEqual(clause.update, ":users");
      assert.ok(clause.set);
      assert.ok(clause.where);
    });
  });

  describe("DELETE", () => {
    it("parses basic DELETE", () => {
      const clause = fromSql("DELETE FROM users WHERE id = 1");
      assert.strictEqual(clause["delete-from"], ":users");
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
      // Parse to clause
      const clause = fromSql(sql);

      // Format back to SQL (inline mode for direct comparison)
      const [resultSql] = toSql(clause, { inline: true, quoted: true });

      // Normalize both for comparison (removes formatting differences)
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
