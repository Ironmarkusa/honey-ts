/**
 * Tests for the DuckDB construct types: constructors produce shapes the
 * emitter accepts, and guards recognise exactly those shapes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { format } from "./sql.js";
import * as d from "./duckdb-types.js";
import { checkSyntax } from "./duckdb-oracle.js";
import type { SqlClause } from "./types.js";

const duck = (clause: SqlClause) =>
  format(clause, { dialect: "duckdb", inline: true })[0];

describe("DuckDB typed constructors emit valid SQL", () => {
  const cases: Array<[string, SqlClause, string]> = [
    [
      "list",
      { select: [d.list({ v: 1 }, { v: 2 })] },
      "SELECT [1, 2]",
    ],
    [
      "struct",
      { select: [d.struct({ a: { v: 1 }, b: { v: "x" } })] },
      "SELECT {'a': 1, 'b': 'x'}",
    ],
    [
      "lambda in list_transform",
      { select: [["%list_transform", d.list({ v: 1 }), d.lambda("x", ["+", "x", { v: 1 }])]] },
      `SELECT LIST_TRANSFORM([1], x -> x + 1)`,
    ],
    [
      "star",
      { select: [d.star({ exclude: ["id"] })], from: ["t"] },
      `SELECT * EXCLUDE (id) FROM t`,
    ],
    [
      "slice",
      { select: [d.slice("a", { v: 1 }, { v: 2 })], from: ["t"] },
      `SELECT a[1:2] FROM t`,
    ],
    [
      "open slice",
      { select: [d.slice("a", { v: 2 })], from: ["t"] },
      `SELECT a[2:] FROM t`,
    ],
    [
      "named arg",
      { select: [["%histogram", "i", d.namedArg("bin_count", { v: 10 })]], from: ["t"] },
      `SELECT HISTOGRAM(i, bin_count := 10) FROM t`,
    ],
    [
      "try-cast",
      { select: [d.tryCast("a", "INT")], from: ["t"] },
      `SELECT TRY_CAST(a AS INT) FROM t`,
    ],
    [
      "agg order by",
      { select: [d.aggOrderBy(["%list", "v"], [["v", "desc"]])], from: ["t"] },
      `SELECT LIST(v ORDER BY v DESC) FROM t`,
    ],
  ];

  for (const [name, clause, expected] of cases) {
    test(name, async () => {
      const sql = duck(clause);
      assert.equal(sql, expected);
      const check = await checkSyntax(sql);
      assert.ok(check.valid, `DuckDB rejected: ${sql}\n  ${check.error}`);
    });
  }
});

describe("DuckDB guards", () => {
  test("each guard accepts its constructor's output", () => {
    assert.ok(d.isDuckDBList(d.list({ v: 1 })));
    assert.ok(d.isDuckDBStruct(d.struct({ a: { v: 1 } })));
    assert.ok(d.isDuckDBLambda(d.lambda("x", "x")));
    assert.ok(d.isDuckDBLambda(d.lambda(["x", "y"], "x")));
    assert.ok(d.isDuckDBStar(d.star()));
    assert.ok(d.isDuckDBSlice(d.slice("a", { v: 1 }, { v: 2 })));
    assert.ok(d.isDuckDBNamedArg(d.namedArg("k", { v: 1 })));
    assert.ok(d.isDuckDBTryCast(d.tryCast("a", "INT")));
    assert.ok(d.isDuckDBAggOrderBy(d.aggOrderBy(["%list", "v"], ["v"])));
  });

  test("guards reject lookalikes", () => {
    // ["list", "a"] with a select-alias reading is still a list construct, but
    // ["lists", ...], plain arrays, and idents are not.
    assert.equal(d.isDuckDBList(["lists", 1]), false);
    assert.equal(d.isDuckDBList("list"), false);
    assert.equal(d.isDuckDBLambda(["lambda", 42, "x"]), false);
    assert.equal(d.isDuckDBLambda(["lambda", "x"]), false); // missing body
    assert.equal(d.isDuckDBStar(["star"]), false); // missing spec
    assert.equal(d.isDuckDBStar(["star", "t"]), false); // spec must be object
    assert.equal(d.isDuckDBStruct(["struct", "a"]), false); // not a pair
    assert.equal(d.isDuckDBNamedArg(["named-arg", 1, 2]), false);
    assert.equal(d.isDuckDBExpr(["=", "a", { v: 1 }]), false);
    assert.equal(d.isDuckDBExpr(null), false);
  });

  test("isDuckDBExpr covers every constructor", () => {
    for (const e of [
      d.list(),
      d.struct({}),
      d.lambda("x", "x"),
      d.star(),
      d.slice("a"),
      d.namedArg("k", { v: 1 }),
      d.tryCast("a", "INT"),
      d.aggOrderBy(["%list", "v"], ["v"]),
    ]) {
      assert.ok(d.isDuckDBExpr(e), JSON.stringify(e));
    }
  });
});
