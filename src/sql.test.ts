/**
 * Basic tests for honey-ts
 *
 * New syntax:
 * - Plain strings are identifiers: "id", "users", "users.id"
 * - Values use {$: value} or {type: value}: {$: "active"}, {int: 42}
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  format,
  raw,
  param,
} from "./index.js";

describe("format", () => {
  describe("SELECT queries", () => {
    it("formats basic SELECT", () => {
      const [sql, ...params] = format({
        select: ["id", "name"],
        from: "users",
      });
      assert.strictEqual(sql, 'SELECT "id", "name" FROM "users"');
      assert.deepStrictEqual(params, []);
    });

    it("formats SELECT with WHERE", () => {
      const [sql, ...params] = format({
        select: ["*"],
        from: "users",
        where: ["=", "id", {$: 1}],
      });
      assert.strictEqual(sql, 'SELECT * FROM "users" WHERE "id" = $1');
      assert.deepStrictEqual(params, [1]);
    });

    it("formats SELECT with complex WHERE", () => {
      const [sql, ...params] = format({
        select: ["*"],
        from: "users",
        where: ["and", ["=", "status", {$: "active"}], [">", "age", {$: 18}]],
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
        from: [["users", "u"]],
        join: [[["orders", "o"], ["=", "u.id", "o.user_id"]]],
      });
      assert.match(sql, /INNER JOIN "orders" AS "o" ON "u"."id" = "o"."user_id"/);
    });

    it("formats SELECT with ORDER BY, LIMIT, OFFSET", () => {
      const [sql, ...params] = format({
        select: ["*"],
        from: "users",
        "order-by": [["created_at", "desc"]],
        limit: {$: 10},
        offset: {$: 20},
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
        "insert-into": "users",
        values: [{ name: {$: "Alice"}, email: {$: "alice@example.com"} }],
      });
      assert.match(sql, /INSERT INTO "users"/);
      assert.match(sql, /VALUES/);
      assert.deepStrictEqual(params, ["Alice", "alice@example.com"]);
    });

    it("formats INSERT with ON CONFLICT DO NOTHING", () => {
      const [sql, ...params] = format({
        "insert-into": "users",
        values: [{ id: {$: 1}, name: {$: "Alice"} }],
        "on-conflict": ["id"],
        "do-nothing": true,
      });
      assert.match(sql, /ON CONFLICT \("id"\) DO NOTHING/);
    });

    it("formats INSERT with ON CONFLICT DO UPDATE", () => {
      const [sql, ...params] = format({
        "insert-into": "users",
        values: [{ id: {$: 1}, name: {$: "Alice"} }],
        "on-conflict": ["id"],
        "do-update-set": { fields: ["name"] },
      });
      assert.match(sql, /DO UPDATE SET "name" = EXCLUDED."name"/);
    });

    it("formats INSERT with RETURNING", () => {
      const [sql, ...params] = format({
        "insert-into": "users",
        values: [{ name: {$: "Alice"} }],
        returning: ["id", "created_at"],
      });
      assert.match(sql, /RETURNING "id", "created_at"/);
    });

    it("formats INSERT with column list", () => {
      const [sql, ...params] = format({
        "insert-into": ["users", ["name", "email"]],
        values: [[{$: "Alice"}, {$: "alice@example.com"}]],
      });
      assert.match(sql, /INSERT INTO "users" \("name", "email"\)/);
      assert.match(sql, /VALUES \(\$1, \$2\)/);
    });

    it("formats INSERT...SELECT with correct clause order", () => {
      const [sql, ...params] = format({
        "insert-into": ["target_table", ["id", "name", "value"]],
        select: ["s.id", "s.name", ["%upper", "s.value"]],
        from: [["source_table", "s"]],
        where: ["=", "s.active", {$: true}],
      });
      // INSERT INTO must come before SELECT
      const insertPos = sql.indexOf("INSERT INTO");
      const selectPos = sql.indexOf("SELECT");
      assert.ok(insertPos < selectPos, "INSERT INTO should come before SELECT");
      assert.match(sql, /INSERT INTO "target_table" \("id", "name", "value"\) SELECT/);
    });

    it("formats INSERT...SELECT with JOIN", () => {
      const [sql] = format({
        "insert-into": ["audit_log", ["user_id", "action", "timestamp"]],
        select: ["u.id", {$: "login"}, ["%now"]],
        from: [["users", "u"]],
        join: [[["sessions", "s"], ["=", "s.user_id", "u.id"]]],
        where: ["=", "u.active", {$: true}],
      });
      assert.match(sql, /INSERT INTO "audit_log"/);
      assert.match(sql, /SELECT "u"."id"/);
      assert.match(sql, /FROM "users" AS "u"/);
      assert.match(sql, /JOIN "sessions" AS "s"/);
    });

    it("formats INSERT...SELECT without column list", () => {
      const [sql] = format({
        "insert-into": "target_table",
        select: ["*"],
        from: "source_table",
      });
      assert.match(sql, /INSERT INTO "target_table" SELECT \* FROM "source_table"/);
    });
  });

  describe("clause ordering", () => {
    it("orders WITH before INSERT", () => {
      const [sql] = format({
        with: [["temp", { select: ["*"], from: "users" }]],
        "insert-into": ["target", ["id"]],
        select: ["id"],
        from: "temp",
      });
      const withPos = sql.indexOf("WITH");
      const insertPos = sql.indexOf("INSERT INTO");
      assert.ok(withPos < insertPos, "WITH should come before INSERT INTO");
    });

    it("orders INSERT before SELECT before FROM", () => {
      const [sql] = format({
        from: "source",
        select: ["*"],
        "insert-into": "target",
      });
      const insertPos = sql.indexOf("INSERT INTO");
      const selectPos = sql.indexOf("SELECT");
      const fromPos = sql.indexOf("FROM");
      assert.ok(insertPos < selectPos, "INSERT INTO should come before SELECT");
      assert.ok(selectPos < fromPos, "SELECT should come before FROM");
    });

    it("orders UPDATE before SET before FROM before WHERE", () => {
      const [sql] = format({
        where: ["=", "u.id", "t.id"],
        from: [["temp", "t"]],
        set: { name: "t.name" },
        update: [["users", "u"]],
      }, { checking: "none" });
      const updatePos = sql.indexOf("UPDATE");
      const setPos = sql.indexOf("SET");
      const fromPos = sql.indexOf("FROM");
      const wherePos = sql.indexOf("WHERE");
      assert.ok(updatePos < setPos, "UPDATE should come before SET");
      assert.ok(setPos < fromPos, "SET should come before FROM");
      assert.ok(fromPos < wherePos, "FROM should come before WHERE");
    });

    it("orders DELETE before FROM before WHERE", () => {
      const [sql] = format({
        where: ["=", "id", {$: 1}],
        from: "users",
        delete: true,
      }, { checking: "none" });
      const deletePos = sql.indexOf("DELETE");
      const fromPos = sql.indexOf("FROM");
      const wherePos = sql.indexOf("WHERE");
      assert.ok(deletePos < fromPos, "DELETE should come before FROM");
      assert.ok(fromPos < wherePos, "FROM should come before WHERE");
    });
  });

  describe("UPDATE queries", () => {
    it("formats basic UPDATE", () => {
      const [sql, ...params] = format(
        {
          update: "users",
          set: { name: {$: "Bob"}, updated_at: ["%now"] },
          where: ["=", "id", {$: 1}],
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
          "delete-from": "users",
          where: ["=", "id", {$: 1}],
        },
        { checking: "none" }
      );
      assert.strictEqual(sql, 'DELETE FROM "users" WHERE "id" = $1');
      assert.deepStrictEqual(params, [1]);
    });
  });

  describe("Special syntax", () => {
    it("formats CASE expression", () => {
      const [sql] = format({
        select: [["case", ["=", "status", {$: 1}], {$: "active"}, "else", {$: "inactive"}]],
        from: "users",
      });
      assert.match(sql, /CASE WHEN.*THEN.*ELSE.*END/);
    });

    it("formats CAST expression", () => {
      const [sql] = format({
        select: [["cast", "created_at", "date"]],
        from: "events",
      });
      assert.match(sql, /CAST\("created_at" AS DATE\)/);
    });

    it("formats BETWEEN expression", () => {
      const [sql, ...params] = format({
        select: ["*"],
        from: "orders",
        where: ["between", "total", {$: 100}, {$: 500}],
      });
      assert.match(sql, /WHERE "total" BETWEEN \$1 AND \$2/);
      assert.deepStrictEqual(params, [100, 500]);
    });

    it("formats IN expression", () => {
      const [sql, ...params] = format({
        select: ["*"],
        from: "users",
        where: ["in", "id", [{$: 1}, {$: 2}, {$: 3}]],
      });
      assert.match(sql, /WHERE "id" IN \(\$1, \$2, \$3\)/);
      assert.deepStrictEqual(params, [1, 2, 3]);
    });

    it("formats raw SQL", () => {
      const [sql] = format({
        select: [raw("COUNT(*) as total")],
        from: "users",
      });
      assert.match(sql, /SELECT COUNT\(\*\) as total/);
    });

    it("formats named parameters", () => {
      const [sql, ...params] = format(
        {
          select: ["*"],
          from: "users",
          where: ["=", "id", param("userId")],
        },
        { params: { userId: 42 } }
      );
      assert.match(sql, /WHERE "id" = \$1/);
      assert.deepStrictEqual(params, [42]);
    });
  });

  describe("WITH (CTE)", () => {
    it("formats WITH clause", () => {
      const [sql] = format({
        with: [
          ["active_users", { select: ["*"], from: "users", where: ["=", "active", {$: true}] }],
        ],
        select: ["*"],
        from: "active_users",
      });
      assert.match(sql, /WITH "active_users" AS/);
      assert.match(sql, /SELECT \* FROM "active_users"/);
    });
  });

  describe("UNION", () => {
    it("formats UNION", () => {
      const [sql] = format({
        union: [
          { select: ["id"], from: "users" },
          { select: ["id"], from: "admins" },
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
          from: "users",
          where: ["=", "id", {$: 42}],
        },
        { inline: true }
      );
      assert.strictEqual(sql, 'SELECT * FROM "users" WHERE "id" = 42');
      assert.deepStrictEqual(params, []);
    });

    it("respects numbered=false for ? params", () => {
      const [sql, ...params] = format(
        {
          select: ["*"],
          from: "users",
          where: ["=", "id", {$: 1}],
        },
        { numbered: false }
      );
      assert.match(sql, /WHERE "id" = \?/);
    });

    it("transforms null equals to IS NULL", () => {
      const [sql] = format(
        {
          select: ["*"],
          from: "users",
          where: ["=", "deleted_at", null],
        },
        { transformNullEquals: true }
      );
      assert.match(sql, /WHERE "deleted_at" IS NULL/);
    });
  });
});

describe("PostgreSQL operators", () => {
  it("formats JSON operators", () => {
    // Import PG operators
    import("./pg-ops.js").then(() => {
      const [sql] = format({
        select: [["->", "data", {$: "name"}]],
        from: "users",
      });
      assert.match(sql, /SELECT "data" -> \$1 FROM "users"/);
    });
  });
});

describe("Typed values", () => {
  it("formats {$: value} as parameter", () => {
    const [sql, ...params] = format({
      select: ["*"],
      from: "users",
      where: ["=", "name", {$: "Alice"}],
    });
    assert.strictEqual(sql, 'SELECT * FROM "users" WHERE "name" = $1');
    assert.deepStrictEqual(params, ["Alice"]);
  });

  it("formats {type: value} with cast", () => {
    const [sql, ...params] = format({
      select: ["*"],
      from: "users",
      where: ["@>", "data", {jsonb: {role: "admin"}}],
    });
    assert.match(sql, /@> \$1::jsonb/);
    assert.deepStrictEqual(params, ['{"role":"admin"}']);
  });

  it("formats inline typed values", () => {
    const [sql] = format(
      {
        select: ["*"],
        from: "users",
        where: ["=", "id", {$: 42}],
      },
      { inline: true }
    );
    assert.strictEqual(sql, 'SELECT * FROM "users" WHERE "id" = 42');
  });

  it("formats inline typed values with cast", () => {
    const [sql] = format(
      {
        select: ["*"],
        from: "events",
        where: ["=", "created_at", {date: "2024-01-01"}],
      },
      { inline: true }
    );
    assert.match(sql, /'2024-01-01'::date/);
  });
});

describe("PostgreSQL infix operators", () => {
  // Import pg-ops to register operators
  import("./pg-ops.js");

  it("formats ~* as infix operator", () => {
    const [sql] = format({
      select: ["*"],
      from: "users",
      where: ["~*", "name", { $: "^john" }],
    });
    assert.match(sql, /"name" ~\* \$1/);
  });

  it("formats ~ as infix operator", () => {
    const [sql] = format({
      select: ["*"],
      from: "users",
      where: ["~", "email", { $: "^[a-z]+@" }],
    });
    assert.match(sql, /"email" ~ \$1/);
  });

  it("formats JSON operators as infix", () => {
    const [sql] = format({
      select: [["->", "data", { $: "name" }]],
      from: "users",
    });
    assert.match(sql, /"data" -> \$1/);
  });

  it("formats ->> as infix operator", () => {
    const [sql] = format({
      select: [["->>", "data", { $: "email" }]],
      from: "users",
    });
    assert.match(sql, /"data" ->> \$1/);
  });

  it("formats @> as infix operator", () => {
    const [sql] = format({
      select: ["*"],
      from: "users",
      where: ["@>", "tags", { $: ["admin"] }],
    });
    assert.match(sql, /"tags" @> \$1/);
  });

  it("formats && (array overlap) as infix operator", () => {
    const [sql] = format({
      select: ["*"],
      from: "posts",
      where: ["&&", "tags", ["array", { $: "sql" }, { $: "typescript" }]],
    });
    assert.match(sql, /"tags" && ARRAY\[\$1, \$2\]/);
  });

  it("formats @@ (text search) as infix operator", () => {
    const [sql] = format({
      select: ["*"],
      from: "articles",
      where: ["@@", "search_vector", ["%to_tsquery", { $: "hello & world" }]],
    });
    assert.match(sql, /"search_vector" @@ TO_TSQUERY\(\$1\)/);
  });

  it("handles CASE with regex operators", () => {
    const [sql] = format({
      select: [
        [
          ["case",
            ["~*", "source", { $: "facebook|fb" }], { $: "facebook" },
            ["~*", "source", { $: "google" }], { $: "google" },
            "else", { $: "other" }
          ],
          "platform"
        ]
      ],
      from: "leads",
    }, { inline: true });
    assert.match(sql, /CASE WHEN "source" ~\* 'facebook\|fb' THEN 'facebook'/);
    assert.match(sql, /WHEN "source" ~\* 'google' THEN 'google'/);
    assert.match(sql, /ELSE 'other' END AS "platform"/);
  });
});

describe("Literal values", () => {
  it("inlines string literals in numbered param mode", () => {
    const [sql, ...params] = format({
      select: [["->", "data", { __literal: "name" }]],
      from: "users",
    });
    assert.strictEqual(sql, `SELECT "data" -> 'name' FROM "users"`);
    assert.deepStrictEqual(params, []);
  });

  it("inlines numeric literals in numbered param mode", () => {
    const [sql, ...params] = format({
      select: ["*"],
      from: "users",
      limit: { __literal: 10 },
    });
    assert.match(sql, /LIMIT 10/);
    assert.deepStrictEqual(params, []);
  });

  it("inlines boolean literals", () => {
    const [sql, ...params] = format({
      select: ["*"],
      from: "users",
      where: ["=", "active", { __literal: true }],
    });
    assert.match(sql, /WHERE "active" = TRUE/);
    assert.deepStrictEqual(params, []);
  });

  it("inlines null literals", () => {
    const [sql, ...params] = format({
      select: ["*"],
      from: "users",
      where: ["is", "deleted_at", { __literal: null }],
    });
    assert.match(sql, /WHERE "deleted_at" IS NULL/);
    assert.deepStrictEqual(params, []);
  });

  it("inlines literals in positional param mode", () => {
    const [sql, ...params] = format({
      select: ["*"],
      from: "users",
      where: ["=", "name", { __literal: "Alice" }],
    }, { numbered: false });
    assert.strictEqual(sql, `SELECT * FROM "users" WHERE "name" = 'Alice'`);
    assert.deepStrictEqual(params, []);
  });

  it("inlines literals in inline mode", () => {
    const [sql, ...params] = format({
      select: ["*"],
      from: "users",
      where: ["=", "id", { __literal: 42 }],
    }, { inline: true });
    assert.strictEqual(sql, 'SELECT * FROM "users" WHERE "id" = 42');
    assert.deepStrictEqual(params, []);
  });

  it("mixes literals and parameterized values", () => {
    const [sql, ...params] = format({
      select: [["%jsonb_build_object", { __literal: "key" }, "col"]],
      from: "users",
      where: ["=", "name", { $: "Alice" }],
    });
    assert.strictEqual(sql, `SELECT JSONB_BUILD_OBJECT('key', "col") FROM "users" WHERE "name" = $1`);
    assert.deepStrictEqual(params, ["Alice"]);
  });
});
