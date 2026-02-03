import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createQueryBuilder, type DatabaseSchema } from "./builder.js";
import { format as toSql } from "./sql.js";
import type { SqlClause } from "./types.js";

const testSchema: DatabaseSchema = {
  tables: [
    {
      name: "users",
      schema: "public",
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimaryKey: true },
        { name: "email", type: "text", nullable: false },
        { name: "name", type: "text", nullable: true },
        { name: "metadata", type: "jsonb", nullable: true },
        { name: "created_at", type: "timestamp", nullable: false },
      ],
    },
    {
      name: "orders",
      schema: "public",
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimaryKey: true },
        {
          name: "user_id",
          type: "integer",
          nullable: false,
          isForeignKey: true,
          references: { table: "users", column: "id" },
        },
        { name: "total", type: "numeric", nullable: false },
        { name: "status", type: "text", nullable: false },
        { name: "items", type: "jsonb", nullable: true },
      ],
    },
    {
      name: "products",
      schema: "public",
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimaryKey: true },
        { name: "name", type: "text", nullable: false },
        { name: "price", type: "numeric", nullable: false },
        { name: "tags", type: "text[]", nullable: true },
      ],
    },
  ],
};

describe("QueryBuilder", () => {
  const builder = createQueryBuilder(testSchema);

  describe("getTablesForFrom", () => {
    it("returns all tables", () => {
      const tables = builder.getTablesForFrom();
      assert.equal(tables.length, 3);
      assert.deepEqual(
        tables.map((t) => t.name),
        ["users", "orders", "products"]
      );
    });
  });

  describe("getColumnsForSelect", () => {
    it("returns columns from tables in FROM clause", () => {
      const clause = { from: "users" };
      const columns = builder.getColumnsForSelect(clause);

      assert.equal(columns.length, 5);
      assert.deepEqual(
        columns.map((c) => c.qualified),
        [
          "users.id",
          "users.email",
          "users.name",
          "users.metadata",
          "users.created_at",
        ]
      );
    });

    it("returns columns with alias prefix", () => {
      const clause = { from: [["users", "u"]] };
      const columns = builder.getColumnsForSelect(clause);

      assert.equal(columns.length, 5);
      assert.deepEqual(
        columns.map((c) => c.qualified),
        ["u.id", "u.email", "u.name", "u.metadata", "u.created_at"]
      );
    });

    it("returns columns from multiple tables", () => {
      const clause: SqlClause = {
        from: [["users", "u"]],
        join: [[["orders", "o"], ["=", "o.user_id", "u.id"]]],
      };
      const columns = builder.getColumnsForSelect(clause);

      assert.equal(columns.length, 10);
      assert.ok(columns.some((c) => c.qualified === "u.email"));
      assert.ok(columns.some((c) => c.qualified === "o.total"));
    });
  });

  describe("getJoinableTables", () => {
    it("suggests joins based on foreign keys", () => {
      const clause = { from: "users" };
      const joinable = builder.getJoinableTables(clause);

      assert.equal(joinable.length, 1);
      assert.equal(joinable[0]?.table.name, "orders");
      assert.deepEqual(joinable[0]?.suggestedOn, [
        "=",
        "orders.user_id",
        "users.id",
      ]);
    });

    it("excludes tables already in query", () => {
      const clause: SqlClause = {
        from: "users",
        join: [["orders", ["=", "orders.user_id", "users.id"]]],
      };
      const joinable = builder.getJoinableTables(clause);

      assert.equal(joinable.length, 0);
    });
  });

  describe("getOperatorsForType", () => {
    it("returns text operators for text type", () => {
      const ops = builder.getOperatorsForType("text");

      assert.ok(ops.some((o) => o.op === "="));
      assert.ok(ops.some((o) => o.op === "like"));
      assert.ok(ops.some((o) => o.op === "ilike"));
      assert.ok(ops.some((o) => o.op === "~"));
    });

    it("returns numeric operators for integer type", () => {
      const ops = builder.getOperatorsForType("integer");

      assert.ok(ops.some((o) => o.op === "="));
      assert.ok(ops.some((o) => o.op === "<"));
      assert.ok(ops.some((o) => o.op === "between"));
      assert.ok(!ops.some((o) => o.op === "like"));
    });

    it("returns JSON operators for jsonb type", () => {
      const ops = builder.getOperatorsForType("jsonb");

      assert.ok(ops.some((o) => o.op === "->"));
      assert.ok(ops.some((o) => o.op === "->>"));
      assert.ok(ops.some((o) => o.op === "@>"));
      assert.ok(ops.some((o) => o.op === "?"));
    });

    it("returns array operators for array type", () => {
      const ops = builder.getOperatorsForType("text[]");

      assert.ok(ops.some((o) => o.op === "@>"));
      assert.ok(ops.some((o) => o.op === "<@"));
      assert.ok(ops.some((o) => o.op === "&&"));
    });
  });

  describe("getFunctionsForType", () => {
    it("returns text functions for text type", () => {
      const fns = builder.getFunctionsForType("text");

      assert.ok(fns.some((f) => f.name === "%lower"));
      assert.ok(fns.some((f) => f.name === "%upper"));
      assert.ok(fns.some((f) => f.name === "%trim"));
    });

    it("returns numeric functions for numeric type", () => {
      const fns = builder.getFunctionsForType("numeric");

      assert.ok(fns.some((f) => f.name === "%round"));
      assert.ok(fns.some((f) => f.name === "%abs"));
    });

    it("returns datetime functions for timestamp type", () => {
      const fns = builder.getFunctionsForType("timestamp");

      assert.ok(fns.some((f) => f.name === "%date_trunc"));
      assert.ok(fns.some((f) => f.name === "%extract"));
    });
  });

  describe("getAggregateFunctions", () => {
    it("returns aggregate functions", () => {
      const fns = builder.getAggregateFunctions();

      assert.ok(fns.some((f) => f.name === "%count"));
      assert.ok(fns.some((f) => f.name === "%sum"));
      assert.ok(fns.some((f) => f.name === "%avg"));
      assert.ok(fns.some((f) => f.name === "%min"));
      assert.ok(fns.some((f) => f.name === "%max"));
    });
  });

  describe("clause manipulation", () => {
    it("addFrom adds table to clause", () => {
      let clause: SqlClause = {};
      clause = builder.addFrom(clause, "users", "u");

      assert.deepEqual(clause, { from: ["users", "u"] });
    });

    it("addSelect adds column to clause", () => {
      let clause: SqlClause = { from: "users" };
      clause = builder.addSelect(clause, "users.email");
      clause = builder.addSelect(clause, "users.name", "user_name");

      assert.deepEqual(clause, {
        from: "users",
        select: ["users.email", ["users.name", "user_name"]],
      });
    });

    it("removeSelect removes column by alias", () => {
      let clause: SqlClause = {
        from: "users",
        select: ["users.email", ["users.name", "user_name"]],
      };
      clause = builder.removeSelect(clause, "user_name");

      assert.deepEqual(clause, {
        from: "users",
        select: ["users.email"],
      });
    });

    it("addJoin adds join to clause", () => {
      let clause: SqlClause = { from: "users" };
      clause = builder.addJoin(
        clause,
        "orders",
        ["=", "orders.user_id", "users.id"],
        "left",
        "o"
      );

      assert.deepEqual(clause, {
        from: "users",
        "left-join": [
          [["orders", "o"], ["=", "orders.user_id", "users.id"]],
        ],
      });
    });

    it("addWhere adds condition to clause", () => {
      let clause: SqlClause = { from: "users" };
      clause = builder.addWhere(clause, ["=", "users.status", { $: "active" }]);

      assert.deepEqual(clause, {
        from: "users",
        where: ["=", "users.status", { $: "active" }],
      });
    });

    it("addWhere ANDs with existing condition", () => {
      let clause: SqlClause = {
        from: "users",
        where: ["=", "users.status", { $: "active" }],
      };
      clause = builder.addWhere(clause, [">", "users.id", { $: 100 }]);

      assert.deepEqual(clause, {
        from: "users",
        where: [
          "and",
          ["=", "users.status", { $: "active" }],
          [">", "users.id", { $: 100 }],
        ],
      });
    });

    it("removeWhere removes condition by index", () => {
      let clause: SqlClause = {
        from: "users",
        where: [
          "and",
          ["=", "users.status", { $: "active" }],
          [">", "users.id", { $: 100 }],
        ],
      };
      clause = builder.removeWhere(clause, 0);

      assert.deepEqual(clause, {
        from: "users",
        where: [">", "users.id", { $: 100 }],
      });
    });

    it("setOrderBy sets order by", () => {
      let clause: SqlClause = { from: "users" };
      clause = builder.setOrderBy(clause, [
        ["users.created_at", "desc"],
        ["users.id", "asc"],
      ]);

      assert.deepEqual(clause, {
        from: "users",
        "order-by": [
          ["users.created_at", "desc"],
          ["users.id", "asc"],
        ],
      });
    });

    it("addOrderBy adds to order by", () => {
      let clause: SqlClause = { from: "users", "order-by": [["users.created_at", "desc"]] };
      clause = builder.addOrderBy(clause, "users.id", "asc");

      assert.deepEqual(clause, {
        from: "users",
        "order-by": [
          ["users.created_at", "desc"],
          ["users.id", "asc"],
        ],
      });
    });

    it("setGroupBy sets group by", () => {
      let clause: SqlClause = { from: "users" };
      clause = builder.setGroupBy(clause, ["users.status"]);

      assert.deepEqual(clause, {
        from: "users",
        "group-by": ["users.status"],
      });
    });

    it("setLimit and setOffset set pagination", () => {
      let clause: SqlClause = { from: "users" };
      clause = builder.setLimit(clause, 100);
      clause = builder.setOffset(clause, 50);

      assert.deepEqual(clause, {
        from: "users",
        limit: { $: 100 },
        offset: { $: 50 },
      });
    });

    it("clear removes a clause key", () => {
      let clause: SqlClause = {
        from: "users",
        where: ["=", "status", { $: "active" }],
        "order-by": [["id", "asc"]],
      };
      clause = builder.clear(clause, "order-by");

      assert.deepEqual(clause, {
        from: "users",
        where: ["=", "status", { $: "active" }],
      });
    });
  });

  describe("validate", () => {
    it("validates valid query", () => {
      const clause = {
        select: ["users.email", "users.name"],
        from: "users",
      };
      const result = builder.validate(clause);

      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it("detects unknown column", () => {
      const clause = {
        select: ["users.unknown_column"],
        from: "users",
      };
      const result = builder.validate(clause);

      assert.equal(result.valid, false);
      assert.equal(result.errors[0]?.code, "unknown_column");
    });

    it("detects unknown table alias", () => {
      const clause = {
        select: ["x.email"],
        from: "users",
      };
      const result = builder.validate(clause);

      assert.equal(result.valid, false);
      assert.equal(result.errors[0]?.code, "unknown_table");
    });

    it("warns on SELECT without FROM", () => {
      const clause = {
        select: [{ $: 1 }],
      };
      const result = builder.validate(clause);

      assert.equal(result.valid, true);
      assert.ok(result.warnings.some((w) => w.code === "missing_from"));
    });
  });

  describe("end-to-end", () => {
    it("builds a complete query", () => {
      let clause: SqlClause = {};

      clause = builder.addFrom(clause, "users", "u");
      clause = builder.addSelect(clause, "u.email");
      clause = builder.addSelect(clause, ["%lower", "u.name"], "name_lower");
      clause = builder.addJoin(
        clause,
        "orders",
        ["=", "o.user_id", "u.id"],
        "left",
        "o"
      );
      clause = builder.addSelect(clause, ["%count", "o.id"], "order_count");
      clause = builder.addWhere(clause, ["=", "u.status", { $: "active" }]);
      clause = builder.setGroupBy(clause, ["u.id", "u.email", "u.name"]);
      clause = builder.setOrderBy(clause, [["order_count", "desc"]]);
      clause = builder.setLimit(clause, 10);

      const [sql, ...params] = toSql(clause);

      // SQL has quoted identifiers
      assert.match(sql, /SELECT/i);
      assert.match(sql, /"u"\."email"/);
      assert.match(sql, /LOWER\("u"\."name"\) AS "name_lower"/i);
      assert.match(sql, /FROM "users"/i);
      assert.match(sql, /LEFT JOIN "orders" AS "o"/i);
      assert.match(sql, /WHERE "u"\."status" = \$1/i);
      assert.match(sql, /GROUP BY "u"\."id", "u"\."email", "u"\."name"/i);
      assert.match(sql, /ORDER BY "order_count" DESC/i);
      assert.match(sql, /LIMIT \$2/i);
      assert.deepEqual(params, ["active", 10]);
    });
  });
});
