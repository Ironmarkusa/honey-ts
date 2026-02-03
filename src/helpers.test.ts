/**
 * Tests for query manipulation helpers.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { overrideSelects, injectWhere, getSelectAliases, fromSql } from "./index.js";
import type { SqlClause } from "./types.js";

describe("overrideSelects", () => {
  it("overrides bare column by name", () => {
    const clause: SqlClause = {
      select: ["id", "email"],
      from: "users",
    };

    const result = overrideSelects(clause, {
      email: ["%sha256", "email"],
    });

    assert.deepStrictEqual(result.select, [
      "id",
      [["%sha256", "email"], "email"],
    ]);
  });

  it("overrides aliased column by alias", () => {
    const clause: SqlClause = {
      select: ["id", ["email", "email_hash"]],
      from: "users",
    };

    const result = overrideSelects(clause, {
      email_hash: ["%sha256", ["%lower", "email"]],
    });

    assert.deepStrictEqual(result.select, [
      "id",
      [["%sha256", ["%lower", "email"]], "email_hash"],
    ]);
  });

  it("overrides expression with alias", () => {
    const clause: SqlClause = {
      select: ["id", [["%count", "*"], "total"]],
      from: "users",
    };

    const result = overrideSelects(clause, {
      total: ["%count-distinct", "user_id"],
    });

    assert.deepStrictEqual(result.select, [
      "id",
      [["%count-distinct", "user_id"], "total"],
    ]);
  });

  it("handles qualified column names with unqualified override", () => {
    const clause: SqlClause = {
      select: ["u.id", "u.email"],
      from: [["users", "u"]],
    };

    const result = overrideSelects(clause, {
      email: ["%sha256", "u.email"],
    });

    assert.deepStrictEqual(result.select, [
      "u.id",
      [["%sha256", "u.email"], "email"],
    ]);
  });

  it("resolves table alias to actual table name", () => {
    const clause: SqlClause = {
      select: ["u.id", "u.email"],
      from: [["users", "u"]],
    };

    // Override using actual table name, not the alias
    const result = overrideSelects(clause, {
      "users.email": ["%sha256", "u.email"],
    });

    assert.deepStrictEqual(result.select, [
      "u.id",
      [["%sha256", "u.email"], "email"],
    ]);
  });

  it("matches specific table when multiple tables have same column", () => {
    const clause: SqlClause = {
      select: ["u.email", "t.email"],
      from: [["users", "u"]],
      join: [[["temp", "t"], ["=", "u.id", "t.user_id"]]],
    };

    // Only override users.email, not temp.email
    const result = overrideSelects(clause, {
      "users.email": ["%sha256", "u.email"],
    });

    assert.deepStrictEqual(result.select, [
      [["%sha256", "u.email"], "email"],  // matched users.email
      "t.email",  // unchanged (temp.email didn't match)
    ]);
  });

  it("table.column takes precedence over bare column", () => {
    const clause: SqlClause = {
      select: ["u.email", "t.email"],
      from: [["users", "u"]],
      join: [[["temp", "t"], ["=", "u.id", "t.user_id"]]],
    };

    const result = overrideSelects(clause, {
      "users.email": ["%sha256", "u.email"],  // specific to users
      "email": ["%lower", "email"],            // fallback for others
    });

    assert.deepStrictEqual(result.select, [
      [["%sha256", "u.email"], "email"],  // matched users.email
      [["%lower", "email"], "email"],     // matched email fallback (temp.email)
    ]);
  });

  it("works with bare table names (no alias)", () => {
    const clause: SqlClause = {
      select: ["users.id", "users.email"],
      from: "users",
    };

    const result = overrideSelects(clause, {
      "users.email": ["%sha256", "users.email"],
    });

    assert.deepStrictEqual(result.select, [
      "users.id",
      [["%sha256", "users.email"], "email"],
    ]);
  });

  it("leaves unmatched columns unchanged", () => {
    const clause: SqlClause = {
      select: ["id", "name", "email"],
      from: "users",
    };

    const result = overrideSelects(clause, {
      email: ["%sha256", "email"],
    });

    assert.deepStrictEqual(result.select, [
      "id",
      "name",
      [["%sha256", "email"], "email"],
    ]);
  });

  it("handles multiple overrides", () => {
    const clause: SqlClause = {
      select: ["id", "email", "name"],
      from: "users",
    };

    const result = overrideSelects(clause, {
      email: ["%sha256", "email"],
      name: ["%upper", "name"],
    });

    assert.deepStrictEqual(result.select, [
      "id",
      [["%sha256", "email"], "email"],
      [["%upper", "name"], "name"],
    ]);
  });

  it("works with select-distinct", () => {
    const clause: SqlClause = {
      "select-distinct": ["status", "email"],
      from: "users",
    };

    const result = overrideSelects(clause, {
      email: ["%lower", "email"],
    });

    assert.deepStrictEqual(result["select-distinct"], [
      "status",
      [["%lower", "email"], "email"],
    ]);
  });

  it("works with select-distinct-on", () => {
    const clause: SqlClause = {
      "select-distinct-on": [["user_id"], "*", "email"],
      from: "orders",
    };

    const result = overrideSelects(clause, {
      email: ["%sha256", "email"],
    });

    assert.deepStrictEqual(result["select-distinct-on"], [
      ["user_id"],
      "*",
      [["%sha256", "email"], "email"],
    ]);
  });

  it("handles empty overrides", () => {
    const clause: SqlClause = {
      select: ["id", "email"],
      from: "users",
    };

    const result = overrideSelects(clause, {});

    assert.deepStrictEqual(result.select, ["id", "email"]);
  });

  it("preserves other clause properties", () => {
    const clause: SqlClause = {
      select: ["id", "email"],
      from: "users",
      where: ["=", "active", { $: true }],
      limit: { $: 10 },
    };

    const result = overrideSelects(clause, {
      email: ["%sha256", "email"],
    });

    assert.strictEqual(result.from, "users");
    assert.deepStrictEqual(result.where, ["=", "active", { $: true }]);
    assert.deepStrictEqual(result.limit, { $: 10 });
  });
});

describe("injectWhere", () => {
  it("injects into main query", () => {
    const clause: SqlClause = {
      select: ["*"],
      from: "users",
    };

    const result = injectWhere(clause, ["=", "tenant_id", { $: "t1" }]);

    assert.deepStrictEqual(result.where, ["=", "tenant_id", { $: "t1" }]);
  });

  it("ANDs with existing where", () => {
    const clause: SqlClause = {
      select: ["*"],
      from: "users",
      where: ["=", "active", { $: true }],
    };

    const result = injectWhere(clause, ["=", "tenant_id", { $: "t1" }]);

    assert.deepStrictEqual(result.where, [
      "and",
      ["=", "active", { $: true }],
      ["=", "tenant_id", { $: "t1" }],
    ]);
  });

  it("injects into subqueries", () => {
    const clause: SqlClause = {
      select: ["*"],
      from: "orders",
      where: [
        "in",
        "user_id",
        {
          select: ["id"],
          from: "users",
        },
      ],
    };

    const result = injectWhere(clause, ["=", "tenant_id", { $: "t1" }]);

    // Main query has tenant filter
    assert.ok(JSON.stringify(result.where).includes("tenant_id"));

    // Subquery should also have tenant filter
    const whereStr = JSON.stringify(result.where);
    // Should appear twice (once in main, once in subquery)
    const matches = whereStr.match(/tenant_id/g);
    assert.strictEqual(matches?.length, 2);
  });
});

describe("getSelectAliases", () => {
  it("maps bare columns to themselves", () => {
    const clause = fromSql("SELECT id, name FROM users");
    const tree = getSelectAliases(clause);

    assert.strictEqual(tree.aliases.get("id"), "id");
    assert.strictEqual(tree.aliases.get("name"), "name");
  });

  it("maps qualified columns to column name, resolving table alias", () => {
    const clause = fromSql("SELECT u.id, u.name FROM users u");
    const tree = getSelectAliases(clause);

    // u.id → users.id, alias is "id"
    assert.strictEqual(tree.aliases.get("users.id"), "id");
    assert.strictEqual(tree.aliases.get("users.name"), "name");
  });

  it("maps aliased columns to alias", () => {
    const clause = fromSql("SELECT id AS user_id, name AS full_name FROM users");
    const tree = getSelectAliases(clause);

    assert.strictEqual(tree.aliases.get("id"), "user_id");
    assert.strictEqual(tree.aliases.get("name"), "full_name");
  });

  it("maps qualified aliased columns, resolving table alias", () => {
    const clause = fromSql("SELECT u.id AS user_id FROM users u");
    const tree = getSelectAliases(clause);

    // u.id → users.id
    assert.strictEqual(tree.aliases.get("users.id"), "user_id");
  });

  it("maps aggregate functions", () => {
    const clause = fromSql("SELECT COUNT(*) AS total FROM users");
    const tree = getSelectAliases(clause);

    assert.strictEqual(tree.aliases.get("COUNT(*)"), "total");
  });

  it("handles subqueries in SELECT", () => {
    const clause = fromSql(
      "SELECT id, (SELECT COUNT(*) FROM orders WHERE user_id = u.id) AS order_count FROM users u"
    );
    const tree = getSelectAliases(clause);

    assert.strictEqual(tree.aliases.get("id"), "id");
    assert.strictEqual(tree.aliases.get("(subquery)"), "order_count");
    assert.strictEqual(tree.children.length, 1);
    assert.strictEqual(tree.children[0]!.location, "select");
  });

  it("handles CTEs", () => {
    const clause = fromSql(
      "WITH active AS (SELECT id, email FROM users WHERE active = true) SELECT * FROM active"
    );
    const tree = getSelectAliases(clause);

    assert.strictEqual(tree.children.length, 1);
    assert.strictEqual(tree.children[0]!.location, "with:active");
    assert.strictEqual(tree.children[0]!.aliases.get("id"), "id");
    assert.strictEqual(tree.children[0]!.aliases.get("email"), "email");
  });

  it("handles UNION branches (from clause)", () => {
    // fromSql returns raw for UNION, so test with clause directly
    const clause: SqlClause = {
      union: [
        { select: [["id", "user_id"]], from: "users" },
        { select: [["id", "user_id"]], from: "admins" },
      ],
    };
    const tree = getSelectAliases(clause);

    assert.strictEqual(tree.children.length, 2);
    assert.strictEqual(tree.children[0]!.aliases.get("id"), "user_id");
    assert.strictEqual(tree.children[1]!.aliases.get("id"), "user_id");
  });

  it("ignores star selects", () => {
    const clause = fromSql("SELECT * FROM users");
    const tree = getSelectAliases(clause);

    assert.strictEqual(tree.aliases.size, 0);
  });

  it("ignores qualified star selects", () => {
    const clause = fromSql("SELECT u.* FROM users u");
    const tree = getSelectAliases(clause);

    assert.strictEqual(tree.aliases.size, 0);
  });
});
