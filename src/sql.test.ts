/**
 * Basic tests for honey-ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  format,
  select,
  from,
  where,
  merge,
  insertInto,
  values,
  update,
  set,
  deleteFrom,
  join,
  leftJoin,
  orderBy,
  limit,
  offset,
  raw,
  param,
  lift,
  groupBy,
  having,
  onConflict,
  doUpdateSet,
  doNothing,
  returning,
  with_,
  union,
} from "./index.js";

describe("format", () => {
  describe("SELECT queries", () => {
    it("formats basic SELECT", () => {
      const [sql, ...params] = format({
        select: [":id", ":name"],
        from: ":users",
      });
      assert.strictEqual(sql, 'SELECT "id", "name" FROM "users"');
      assert.deepStrictEqual(params, []);
    });

    it("formats SELECT with WHERE", () => {
      const [sql, ...params] = format({
        select: ["*"],
        from: ":users",
        where: ["=", ":id", 1],
      });
      assert.strictEqual(sql, 'SELECT * FROM "users" WHERE "id" = $1');
      assert.deepStrictEqual(params, [1]);
    });

    it("formats SELECT with complex WHERE", () => {
      const [sql, ...params] = format({
        select: ["*"],
        from: ":users",
        where: ["and", ["=", ":status", "active"], [">", ":age", 18]],
      });
      assert.strictEqual(
        sql,
        'SELECT * FROM "users" WHERE ("status" = $1) AND ("age" > $2)'
      );
      assert.deepStrictEqual(params, ["active", 18]);
    });

    it("formats SELECT with JOIN", () => {
      const [sql, ...params] = format({
        select: ["u.id", "o.total"],
        from: [[":users", ":u"]],
        join: [[[":orders", ":o"], ["=", "u.id", "o.user_id"]]],
      });
      assert.match(sql, /INNER JOIN "orders" AS "o" ON "u"."id" = "o"."user_id"/);
    });

    it("formats SELECT with ORDER BY, LIMIT, OFFSET", () => {
      const [sql, ...params] = format({
        select: ["*"],
        from: ":users",
        "order-by": [[":created_at", "desc"]],
        limit: 10,
        offset: 20,
      });
      assert.match(sql, /ORDER BY "created_at" DESC/);
      assert.match(sql, /LIMIT \$1/);
      assert.match(sql, /OFFSET \$2/);
      assert.deepStrictEqual(params, [10, 20]);
    });
  });

  describe("INSERT queries", () => {
    it("formats basic INSERT", () => {
      const [sql, ...params] = format({
        "insert-into": ":users",
        values: [{ name: "Alice", email: "alice@example.com" }],
      });
      assert.match(sql, /INSERT INTO "users"/);
      assert.match(sql, /VALUES/);
      assert.deepStrictEqual(params, ["Alice", "alice@example.com"]);
    });

    it("formats INSERT with ON CONFLICT DO NOTHING", () => {
      const [sql, ...params] = format({
        "insert-into": ":users",
        values: [{ id: 1, name: "Alice" }],
        "on-conflict": [":id"],
        "do-nothing": true,
      });
      assert.match(sql, /ON CONFLICT \("id"\) DO NOTHING/);
    });

    it("formats INSERT with ON CONFLICT DO UPDATE", () => {
      const [sql, ...params] = format({
        "insert-into": ":users",
        values: [{ id: 1, name: "Alice" }],
        "on-conflict": [":id"],
        "do-update-set": { fields: [":name"] },
      });
      assert.match(sql, /DO UPDATE SET "name" = EXCLUDED."name"/);
    });

    it("formats INSERT with RETURNING", () => {
      const [sql, ...params] = format({
        "insert-into": ":users",
        values: [{ name: "Alice" }],
        returning: [":id", ":created_at"],
      });
      assert.match(sql, /RETURNING "id", "created_at"/);
    });
  });

  describe("UPDATE queries", () => {
    it("formats basic UPDATE", () => {
      const [sql, ...params] = format(
        {
          update: ":users",
          set: { name: "Bob", updated_at: ["now"] },
          where: ["=", ":id", 1],
        },
        { checking: "none" }
      );
      assert.match(sql, /UPDATE "users" SET/);
      assert.match(sql, /"name" = \$1/);
      assert.match(sql, /WHERE "id" = \$\d/);
    });
  });

  describe("DELETE queries", () => {
    it("formats basic DELETE", () => {
      const [sql, ...params] = format(
        {
          "delete-from": ":users",
          where: ["=", ":id", 1],
        },
        { checking: "none" }
      );
      assert.strictEqual(sql, 'DELETE FROM "users" WHERE "id" = $1');
      assert.deepStrictEqual(params, [1]);
    });
  });

  describe("Helper functions", () => {
    it("builds query with helpers", () => {
      const query = merge(
        select(":id", ":name"),
        from(":users"),
        where(["=", ":active", true])
      );
      const [sql, ...params] = format(query);
      assert.match(sql, /SELECT "id", "name" FROM "users" WHERE "active" = \$1/);
      assert.deepStrictEqual(params, [true]);
    });

    it("combines multiple where clauses with AND", () => {
      const query = merge(
        select("*"),
        from(":users"),
        where(["=", ":status", "active"]),
        where([">", ":age", 18])
      );
      const [sql, ...params] = format(query);
      assert.match(sql, /WHERE.*AND/);
    });
  });

  describe("Special syntax", () => {
    it("formats CASE expression", () => {
      const [sql] = format({
        select: [["case", ["=", ":status", 1], "active", "else", "inactive"]],
        from: ":users",
      });
      assert.match(sql, /CASE WHEN.*THEN.*ELSE.*END/);
    });

    it("formats CAST expression", () => {
      const [sql] = format({
        select: [["cast", ":created_at", ":date"]],
        from: ":events",
      });
      assert.match(sql, /CAST\("created_at" AS DATE\)/);
    });

    it("formats BETWEEN expression", () => {
      const [sql, ...params] = format({
        select: ["*"],
        from: ":orders",
        where: ["between", ":total", 100, 500],
      });
      assert.match(sql, /WHERE "total" BETWEEN \$1 AND \$2/);
      assert.deepStrictEqual(params, [100, 500]);
    });

    it("formats IN expression", () => {
      const [sql, ...params] = format({
        select: ["*"],
        from: ":users",
        where: ["in", ":id", [1, 2, 3]],
      });
      assert.match(sql, /WHERE "id" IN \(\$1, \$2, \$3\)/);
      assert.deepStrictEqual(params, [1, 2, 3]);
    });

    it("formats raw SQL", () => {
      const [sql] = format({
        select: [raw("COUNT(*) as total")],
        from: ":users",
      });
      assert.match(sql, /SELECT COUNT\(\*\) as total/);
    });

    it("formats named parameters", () => {
      const [sql, ...params] = format(
        {
          select: ["*"],
          from: ":users",
          where: ["=", ":id", param("userId")],
        },
        { params: { userId: 42 } }
      );
      assert.match(sql, /WHERE "id" = \$1/);
      assert.deepStrictEqual(params, [42]);
    });
  });

  describe("WITH (CTE)", () => {
    it("formats WITH clause", () => {
      const [sql, ...params] = format({
        with: [
          [":active_users", { select: ["*"], from: ":users", where: ["=", ":active", true] }],
        ],
        select: ["*"],
        from: ":active_users",
      });
      assert.match(sql, /WITH "active_users" AS \(/);
    });
  });

  describe("UNION", () => {
    it("formats UNION", () => {
      const [sql] = format({
        union: [
          { select: [":id"], from: ":users" },
          { select: [":id"], from: ":admins" },
        ],
      });
      assert.match(sql, /SELECT "id" FROM "users" UNION SELECT "id" FROM "admins"/);
    });
  });

  describe("Options", () => {
    it("respects inline option", () => {
      const [sql, ...params] = format(
        {
          select: ["*"],
          from: ":users",
          where: ["=", ":id", 42],
        },
        { inline: true }
      );
      assert.match(sql, /WHERE "id" = 42/);
      assert.deepStrictEqual(params, []);
    });

    it("respects numbered=false for ? params", () => {
      const [sql, ...params] = format(
        {
          select: ["*"],
          from: ":users",
          where: ["=", ":id", 1],
        },
        { numbered: false }
      );
      assert.match(sql, /WHERE "id" = \?/);
      assert.deepStrictEqual(params, [1]);
    });

    it("transforms null equals to IS NULL", () => {
      const [sql] = format({
        select: ["*"],
        from: ":users",
        where: ["=", ":deleted_at", null],
      });
      assert.match(sql, /WHERE "deleted_at" IS NULL/);
    });
  });
});

describe("PostgreSQL operators", async () => {
  // Import pg-ops to register operators
  await import("./pg-ops.js");

  it("formats JSON operators", () => {
    const [sql, ...params] = format({
      select: [["->", ":data", "name"]],
      from: ":users",
    });
    assert.match(sql, /"data" -> \$1/);
    assert.deepStrictEqual(params, ["name"]);
  });
});
