/**
 * DuckDB dialect tests.
 *
 * Every emitted-SQL assertion is checked twice: once against an expected string
 * (so we notice when output changes) and once against a real DuckDB parser via
 * the oracle (so we notice when output changes into something DuckDB rejects).
 * A test that only asserts the string would happily lock in invalid SQL.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { format } from "./sql.js";
import { fromSql } from "./parser.js";
import { checkSyntax, duckdbVersion } from "./duckdb-oracle.js";
import {
  DUCKDB_FUNCTIONS,
  DUCKDB_FUNCTIONS_BY_NAME,
  DUCKDB_AGGREGATES,
  DUCKDB_RESERVED_KEYWORDS,
  DUCKDB_VERSION,
} from "./duckdb-ops.generated.js";
import "./pg-ops.js";
import type { SqlClause, SqlExpr } from "./types.js";

const duck = (clause: SqlClause) =>
  format(clause, { dialect: "duckdb", inline: true })[0];
const pg = (clause: SqlClause) =>
  format(clause, { dialect: "postgres", inline: true })[0];

/** Assert emitted SQL both matches `expected` and parses in real DuckDB. */
async function emits(clause: SqlClause, expected: string) {
  const sql = duck(clause);
  assert.equal(sql, expected);
  const check = await checkSyntax(sql);
  assert.ok(check.valid, `DuckDB rejected emitted SQL: ${sql}\n  ${check.error}`);
}

const sel = (expr: SqlExpr): SqlClause => ({ select: [expr], from: ["t"] });

// ===========================================================================
describe("DuckDB dialect: operator lowerings", () => {
  // Each of these PostgreSQL operators has no DuckDB equivalent but does have a
  // DuckDB function that means the same thing.

  test("~* lowers to regexp_matches with an 'i' flag", async () => {
    await emits(
      sel(["~*", "email", { v: "^a" }]),
      `SELECT REGEXP_MATCHES("email", '^a', 'i') FROM "t"`
    );
  });

  test("!~* lowers to a negated regexp_matches", async () => {
    await emits(
      sel(["!~*", "email", { v: "^a" }]),
      `SELECT NOT REGEXP_MATCHES("email", '^a', 'i') FROM "t"`
    );
  });

  test("#> lowers to json_extract", async () => {
    await emits(
      sel(["#>", "data", { v: "$.a.b" }]),
      `SELECT JSON_EXTRACT("data", '$.a.b') FROM "t"`
    );
  });

  test("#>> lowers to json_extract_string", async () => {
    await emits(
      sel(["#>>", "data", { v: "$.a.b" }]),
      `SELECT JSON_EXTRACT_STRING("data", '$.a.b') FROM "t"`
    );
  });

  test("? lowers to json_exists", async () => {
    await emits(
      sel(["?", "data", { v: "$.a" }]),
      `SELECT JSON_EXISTS("data", '$.a') FROM "t"`
    );
  });

  test("@? lowers to json_exists", async () => {
    await emits(
      sel(["@?", "data", { v: "$.a" }]),
      `SELECT JSON_EXISTS("data", '$.a') FROM "t"`
    );
  });

  test("@> lowers to json_contains", async () => {
    await emits(
      sel(["@>", "data", { v: '{"a":1}' }]),
      `SELECT JSON_CONTAINS("data", '{"a":1}') FROM "t"`
    );
  });

  test("<@ lowers to json_contains with arguments swapped", async () => {
    // a <@ b means "a is contained in b", i.e. json_contains(b, a).
    await emits(
      sel(["<@", "data", { v: '{"a":1}' }]),
      `SELECT JSON_CONTAINS('{"a":1}', "data") FROM "t"`
    );
  });

  test("lowerings do not leak into the postgres dialect", () => {
    assert.equal(
      pg(sel(["~*", "email", { v: "^a" }])),
      `SELECT "email" ~* '^a' FROM "t"`
    );
    assert.equal(
      pg(sel(["@>", "data", { v: '{"a":1}' }])),
      `SELECT "data" @> '{"a":1}' FROM "t"`
    );
  });

  test("operators DuckDB shares with postgres are left alone", async () => {
    await emits(sel(["~", "email", { v: "^a" }]), `SELECT "email" ~ '^a' FROM "t"`);
    await emits(sel(["||", "a", "b"]), `SELECT "a" || "b" FROM "t"`);
    await emits(sel(["ilike", "a", { v: "x%" }]), `SELECT "a" ILIKE 'x%' FROM "t"`);
  });
});

// ===========================================================================
describe("DuckDB dialect: unsupported operators", () => {
  // These have no DuckDB spelling at all. Emitting anything would produce SQL
  // that fails at query time, so formatting must refuse.
  const unsupported = [
    ["@@", "full-text search"],
    ["<->", "geometric distance"],
    ["?|", "any-key-exists"],
    ["?&", "all-keys-exist"],
    ["#-", "delete-at-path"],
  ] as const;

  for (const [op, why] of unsupported) {
    test(`${op} (${why}) throws rather than emitting`, () => {
      assert.throws(
        () => duck(sel([op, "a", "b"])),
        /is not supported by dialect 'duckdb'/,
        `${op} should refuse to emit on duckdb`
      );
    });

    test(`${op} still works on postgres`, () => {
      assert.ok(pg(sel([op, "a", "b"])).includes(op));
    });
  }

  test("the error names both the operator and the dialect", () => {
    assert.throws(() => duck(sel(["@@", "a", "b"])), (e: Error) => {
      assert.match(e.message, /'@@'/);
      assert.match(e.message, /'duckdb'/);
      return true;
    });
  });
});

// ===========================================================================
describe("DuckDB dialect: type mapping", () => {
  test("jsonb maps to JSON in casts", async () => {
    await emits({ select: [["cast", "a", "jsonb"]] }, `SELECT CAST("a" AS JSON)`);
  });

  test("jsonb maps to JSON in typed values", () => {
    assert.equal(
      format({ select: [{ jsonb: { a: 1 } }] }, { dialect: "duckdb" })[0],
      "SELECT ?::JSON"
    );
  });

  test("postgres keeps jsonb", () => {
    assert.equal(pg({ select: [["cast", "a", "jsonb"]] }), `SELECT CAST("a" AS JSONB)`);
  });

  test("cast precision and scale survive the type mapping", async () => {
    // Regression guard for the numeric(7,4) round-trip work: introducing a type
    // alias table must not start rewriting parameterised types.
    await emits(
      { select: [["cast", "a", "numeric(7,4)"]] },
      `SELECT CAST("a" AS NUMERIC(7,4))`
    );
    await emits(
      { select: [["cast", "a", "decimal(18,2)"]] },
      `SELECT CAST("a" AS DECIMAL(18,2))`
    );
  });

  test("unmapped types pass through untouched", async () => {
    await emits({ select: [["cast", "a", "varchar"]] }, `SELECT CAST("a" AS VARCHAR)`);
    await emits({ select: [["cast", "a", "timestamptz"]] }, `SELECT CAST("a" AS TIMESTAMPTZ)`);
  });
});

// ===========================================================================
describe("DuckDB dialect: QUALIFY", () => {
  test("QUALIFY is emitted after HAVING and before ORDER BY", async () => {
    await emits(
      {
        select: ["a"],
        from: ["t"],
        qualify: ["=", ["%row_number"], { v: 1 }],
        "order-by": ["a"],
      },
      `SELECT "a" FROM "t" QUALIFY ROW_NUMBER() = 1 ORDER BY "a"`
    );
  });

  test("QUALIFY sits after GROUP BY / HAVING", async () => {
    const sql = duck({
      select: ["a"],
      from: ["t"],
      "group-by": ["a"],
      having: [">", ["%count", "*"], { v: 1 }],
      qualify: ["=", ["%row_number"], { v: 1 }],
    });
    assert.ok(sql.indexOf("HAVING") < sql.indexOf("QUALIFY"), sql);
    assert.ok((await checkSyntax(sql)).valid, sql);
  });
});

// ===========================================================================
describe("DuckDB dialect: star modifiers", () => {
  test("EXCLUDE", async () => {
    await emits(
      { select: [["star", { exclude: ["id"] }]], from: ["t"] },
      `SELECT * EXCLUDE ("id") FROM "t"`
    );
  });

  test("EXCLUDE with several columns", async () => {
    await emits(
      { select: [["star", { exclude: ["id", "secret"] }]], from: ["t"] },
      `SELECT * EXCLUDE ("id", "secret") FROM "t"`
    );
  });

  test("table-qualified star", async () => {
    await emits(
      { select: [["star", { table: "t", exclude: ["id"] }]], from: ["t"] },
      `SELECT "t".* EXCLUDE ("id") FROM "t"`
    );
  });

  test("REPLACE", async () => {
    await emits(
      { select: [["star", { replace: [[["%lower", "name"], "name"]] }]], from: ["t"] },
      `SELECT * REPLACE (LOWER("name") AS "name") FROM "t"`
    );
  });

  test("EXCLUDE and REPLACE together", async () => {
    await emits(
      {
        select: [["star", { exclude: ["id"], replace: [[["%lower", "name"], "name"]] }]],
        from: ["t"],
      },
      `SELECT * EXCLUDE ("id") REPLACE (LOWER("name") AS "name") FROM "t"`
    );
  });

  test("bare star spec is just *", async () => {
    await emits({ select: [["star", {}]], from: ["t"] }, `SELECT * FROM "t"`);
  });

  test("refuses to emit on postgres", () => {
    assert.throws(
      () => pg({ select: [["star", { exclude: ["id"] }]], from: ["t"] }),
      /require dialect 'duckdb'/
    );
  });
});

// ===========================================================================
describe("DuckDB dialect: list, struct and lambda literals", () => {
  test("list literal", async () => {
    await emits({ select: [["list", { v: 1 }, { v: 2 }, { v: 3 }]] }, `SELECT [1, 2, 3]`);
  });

  test("empty list literal", async () => {
    await emits({ select: [["list"]] }, `SELECT []`);
  });

  test("nested list literal", async () => {
    await emits(
      { select: [["list", ["list", { v: 1 }], ["list", { v: 2 }]]] },
      `SELECT [[1], [2]]`
    );
  });

  test("struct literal", async () => {
    await emits(
      { select: [["struct", ["a", { v: 1 }], ["b", { v: "x" }]]] },
      `SELECT {'a': 1, 'b': 'x'}`
    );
  });

  test("struct rejects non-pair arguments", () => {
    assert.throws(
      () => duck({ select: [["struct", "a"]] }),
      /struct expects \[key, value\] pairs/
    );
  });

  test("single-parameter lambda", async () => {
    await emits(
      {
        select: [["%list_transform", ["list", { v: 1 }, { v: 2 }], ["lambda", "x", ["+", "x", { v: 1 }]]]],
      },
      `SELECT LIST_TRANSFORM([1, 2], "x" -> "x" + 1)`
    );
  });

  test("multi-parameter lambda", async () => {
    await emits(
      {
        select: [["%list_zip", ["list", { v: 1 }], ["lambda", ["x", "y"], ["+", "x", "y"]]]],
      },
      `SELECT LIST_ZIP([1], ("x", "y") -> "x" + "y")`
    );
  });

  test("list/struct/lambda all refuse to emit on postgres", () => {
    for (const expr of [
      ["list", { v: 1 }],
      ["struct", ["a", { v: 1 }]],
      ["lambda", "x", "x"],
    ] as SqlExpr[]) {
      assert.throws(() => pg({ select: [expr] }), /require dialect 'duckdb'/);
    }
  });
});

// ===========================================================================
describe("data-modifying CTEs", () => {
  // Regression tests for a bug the DuckDB corpus surfaced: withToClause used to
  // force every CTE body through selectToClause, so any WITH containing an
  // INSERT/UPDATE/DELETE crashed with "stmt.from.filter is not a function".

  // A DML statement as the CTE *body* is a PostgreSQL feature. DuckDB rejects
  // it outright ("A CTE needs a SELECT"), so these are postgres-only.
  const dmlBodies = [
    "WITH d AS (DELETE FROM t WHERE i = 1 RETURNING i) SELECT * FROM d",
    "WITH m AS (INSERT INTO t VALUES (20) RETURNING k) SELECT * FROM m",
    "WITH u AS (UPDATE t SET j = 0 RETURNING i) SELECT * FROM u",
  ];

  for (const sql of dmlBodies) {
    test(`parses and emits: ${sql.slice(0, 46)}`, () => {
      const clause = fromSql(sql);
      // The CTE body must survive as a clause map, not crash or degrade to raw.
      const [, body] = (clause.with as Array<[string, SqlClause]>)[0]!;
      assert.equal(typeof body, "object");
      assert.ok(pg(clause).startsWith("WITH "));
    });
  }

  test("DuckDB rejects DML in a CTE body (documented divergence)", async () => {
    for (const sql of dmlBodies) {
      const check = await checkSyntax(duck(fromSql(sql)));
      assert.equal(check.valid, false, `DuckDB unexpectedly accepted: ${sql}`);
      assert.match(check.error ?? "", /A CTE needs a SELECT/);
    }
  });

  // A DML statement *around* a plain CTE is supported by both.
  const dmlOuter = [
    "WITH x AS (SELECT 10 AS a) DELETE FROM t WHERE a IN (SELECT a FROM x)",
    "WITH x AS (SELECT 1 AS a) INSERT INTO t SELECT a FROM x",
  ];

  for (const sql of dmlOuter) {
    test(`DuckDB accepts: ${sql.slice(0, 46)}`, async () => {
      const emitted = duck(fromSql(sql));
      const check = await checkSyntax(emitted);
      assert.ok(check.valid, `${emitted}\n  ${check.error}`);
    });
  }
});

// ===========================================================================
describe("DuckDB dialect: INSERT ... SELECT", () => {
  // The `values` clause holds a query rather than a row list here.
  test("round-trips through the values clause", async () => {
    const clause = fromSql("INSERT INTO t SELECT a FROM u WHERE a > 1");
    const emitted = duck(clause);
    assert.ok(!emitted.includes("VALUES"), emitted);
    assert.ok((await checkSyntax(emitted)).valid, emitted);
  });

  test("literal VALUES still emits VALUES", async () => {
    const emitted = duck(fromSql("INSERT INTO t VALUES (1, 2)"));
    assert.ok(emitted.includes("VALUES"), emitted);
    assert.ok((await checkSyntax(emitted)).valid, emitted);
  });
});

// ===========================================================================
describe("DuckDB dialect: nested array literals", () => {
  // Regression: the ["array", [elements], type] legacy form used to swallow
  // ["array", ["array", ...], ["array", ...]] and pass an array to sqlKw.
  test("nested ARRAY literal", async () => {
    const emitted = duck(fromSql("SELECT ARRAY[[1, 2], [3, 4]]"));
    assert.equal(emitted, "SELECT ARRAY[ARRAY[1, 2], ARRAY[3, 4]]");
    assert.ok((await checkSyntax(emitted)).valid, emitted);
  });

  test("legacy [elements, type] form still works", async () => {
    await emits(
      { select: [["array", [{ v: 1 }, { v: 2 }], "int"]] },
      `SELECT ARRAY[1, 2]::INT[]`
    );
  });

  test("flat ARRAY literal is unchanged", async () => {
    const emitted = duck(fromSql("SELECT ARRAY[1, 2]"));
    assert.equal(emitted, "SELECT ARRAY[1, 2]");
    assert.ok((await checkSyntax(emitted)).valid, emitted);
  });
});

// ===========================================================================
describe("DuckDB catalog (generated)", () => {
  test("catalog was generated from the DuckDB we test against", async () => {
    assert.equal(DUCKDB_VERSION, await duckdbVersion());
  });

  test("catalog is populated", () => {
    assert.ok(DUCKDB_FUNCTIONS.length > 700, `${DUCKDB_FUNCTIONS.length} functions`);
    assert.ok(DUCKDB_AGGREGATES.length > 50, `${DUCKDB_AGGREGATES.length} aggregates`);
    assert.ok(DUCKDB_RESERVED_KEYWORDS.size > 50);
  });

  test("well-known functions are present with usable metadata", () => {
    for (const name of ["lower", "count", "list_transform", "date_trunc", "regexp_matches"]) {
      const fn = DUCKDB_FUNCTIONS_BY_NAME.get(name);
      assert.ok(fn, `missing ${name}`);
      assert.equal(fn.name, `%${name}`);
      assert.equal(fn.label, name.toUpperCase());
      assert.ok(fn.overloads.length > 0, `${name} has no overloads`);
      assert.ok(fn.returnType, `${name} has no return type`);
    }
  });

  test("the functions the lowering table depends on all exist", () => {
    for (const name of [
      "regexp_matches", "json_extract", "json_extract_string",
      "json_exists", "json_contains",
    ]) {
      assert.ok(DUCKDB_FUNCTIONS_BY_NAME.has(name), `lowering target ${name} missing`);
    }
  });

  test("aggregates are tagged as aggregates", () => {
    for (const name of ["count", "sum", "min", "max"]) {
      assert.equal(DUCKDB_FUNCTIONS_BY_NAME.get(name)?.functionType, "aggregate");
    }
  });

  test("no engine-internal functions leaked in", () => {
    const internal = DUCKDB_FUNCTIONS.filter((f) => f.name.startsWith("%__"));
    assert.equal(internal.length, 0, `leaked: ${internal.slice(0, 3).map((f) => f.name)}`);
  });

  test("every argument has a name and a type", () => {
    for (const fn of DUCKDB_FUNCTIONS) {
      for (const overload of fn.overloads) {
        for (const arg of overload.args) {
          assert.ok(arg.name, `${fn.name} has an unnamed argument`);
          assert.ok(arg.type, `${fn.name} argument ${arg.name} has no type`);
        }
      }
    }
  });

  test("reserved keywords include the obvious ones", () => {
    for (const kw of ["select", "from", "where"]) {
      assert.ok(
        DUCKDB_RESERVED_KEYWORDS.has(kw) || DUCKDB_RESERVED_KEYWORDS.has(kw.toUpperCase()),
        `${kw} not reserved`
      );
    }
  });
});

// ===========================================================================
describe("DuckDB catalog: canonical examples parse", () => {
  // duckdb_functions() ships 518 usage examples. They are DuckDB's own
  // documentation of its syntax, so they are a free conformance corpus.
  /**
   * Three examples are malformed in DuckDB's own catalog (unbalanced parens);
   * they are stored that way in duckdb_functions(), so this is upstream data
   * rather than an extraction bug. Listed explicitly so that a fourth one
   * appearing after a version bump fails the test instead of hiding.
   */
  const KNOWN_MALFORMED = new Set([
    "switch(x, map({1 : 1}, default)",
    "variant_normalize({'b': [1,2,3], 'a': 42})::VARIANT)",
    "variant_typeof({'a': 42, 'b': [1,2,3]})::VARIANT)",
  ]);

  test("every catalog example is accepted by DuckDB", async () => {
    const examples = [...new Set(DUCKDB_FUNCTIONS.flatMap((f) => f.examples))];
    assert.ok(examples.length > 400, `only ${examples.length} examples`);

    const failures: string[] = [];
    for (const ex of examples) {
      if (KNOWN_MALFORMED.has(ex)) continue;
      if (!(await checkSyntax(`SELECT ${ex}`)).valid) failures.push(ex);
    }
    assert.deepEqual(failures, [], `examples DuckDB rejected: ${failures.slice(0, 5)}`);
  });

  test("the known-malformed list is still accurate", async () => {
    // If DuckDB fixes one of these upstream, drop it from the set above.
    for (const ex of KNOWN_MALFORMED) {
      assert.equal(
        (await checkSyntax(`SELECT ${ex}`)).valid,
        false,
        `${ex} now parses — remove it from KNOWN_MALFORMED`
      );
    }
  });
});
