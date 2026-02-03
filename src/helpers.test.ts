/**
 * Tests for helper functions.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { overrideSelects, merge, where, injectWhere } from "./index.js";
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

  it("handles qualified column names", () => {
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

describe("merge", () => {
  it("merges select clauses", () => {
    const a = { select: ["id"] };
    const b = { select: ["name"] };
    const result = merge(a, b);
    assert.deepStrictEqual(result.select, ["id", "name"]);
  });

  it("ANDs where clauses", () => {
    const a = { where: ["=", "a", { $: 1 }] };
    const b = { where: ["=", "b", { $: 2 }] };
    const result = merge(a, b);
    assert.deepStrictEqual(result.where, [
      "and",
      ["=", "a", { $: 1 }],
      ["=", "b", { $: 2 }],
    ]);
  });

  it("replaces scalar values", () => {
    const a = { limit: { $: 10 } };
    const b = { limit: { $: 20 } };
    const result = merge(a, b);
    assert.deepStrictEqual(result.limit, { $: 20 });
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
