/**
 * Tests for the full DuckDB syntax surface added on top of the original
 * preprocessor: every construct parses under {dialect:"duckdb"}, emits under
 * {dialect:"duckdb"}, is verified against a live DuckDB parser, and — where
 * PostgreSQL disagrees — is asserted to stay out of the postgres dialect.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fromSql } from "./parser.js";
import { format } from "./sql.js";
import { checkSyntax } from "./duckdb-oracle.js";
import { LAMBDA_FUNCTIONS } from "./duckdb-preprocess.js";
import { DUCKDB_FUNCTIONS } from "./duckdb-ops.generated.js";
import type { SqlClause } from "./types.js";

const duck = (clause: SqlClause) =>
  format(clause, { dialect: "duckdb", inline: true })[0];

/** Parse as DuckDB, emit as DuckDB, assert the oracle accepts the result. */
async function roundTrips(input: string, expected?: string): Promise<string> {
  const clause = fromSql(input, { dialect: "duckdb" });
  const out = duck(clause);
  if (expected !== undefined) assert.equal(out, expected);
  const check = await checkSyntax(out);
  assert.ok(check.valid, `DuckDB rejected round-trip of:\n  ${input}\n  => ${out}\n  ${check.error}`);
  return out;
}

// ===========================================================================
describe("lambdas", () => {
  test("keyword form, single param", async () => {
    const out = await roundTrips("SELECT list_transform([1,2], lambda x : x + 1)");
    assert.match(out, /"x" -> "x" \+ 1/);
  });

  test("keyword form, multiple params", async () => {
    const out = await roundTrips("SELECT list_reduce([1,2], lambda a, b : a + b)");
    assert.match(out, /\("a", "b"\) -> "a" \+ "b"/);
  });

  test("arrow form inside a catalog lambda function", async () => {
    await roundTrips(
      "SELECT list_filter([1,2,3], x -> x > 1)",
      `SELECT LIST_FILTER([1, 2, 3], "x" -> "x" > 1)`
    );
  });

  test("arrow form with parenthesized params", async () => {
    const out = await roundTrips("SELECT list_reduce([1,2], (a, b) -> a + b)");
    assert.match(out, /\("a", "b"\) -> "a" \+ "b"/);
  });

  test("JSON -> operator is NOT read as a lambda", async () => {
    const clause = fromSql(`SELECT data -> 'k' FROM t`, { dialect: "duckdb" });
    assert.deepEqual(clause.select, [["->", "data", { v: "k" }]]);
  });

  test("JSON -> inside a non-lambda call is untouched", async () => {
    const clause = fromSql(`SELECT lower(data -> 'k') FROM t`, { dialect: "duckdb" });
    assert.match(JSON.stringify(clause), /"->"/);
    assert.doesNotMatch(JSON.stringify(clause), /lambda/);
  });

  test("LAMBDA_FUNCTIONS stays in sync with the DuckDB catalog", () => {
    // Every catalog function with a LAMBDA-typed parameter must be listed —
    // if DuckDB adds one, this fails instead of silently mis-parsing arrows.
    const fromCatalog = new Set(
      DUCKDB_FUNCTIONS.filter((f) =>
        f.overloads.some((o) => o.args.some((a) => a.type === "LAMBDA"))
      ).map((f) => f.name.slice(1))
    );
    for (const name of fromCatalog) {
      assert.ok(LAMBDA_FUNCTIONS.has(name), `catalog lambda fn missing: ${name}`);
    }
  });
});

// ===========================================================================
describe("EXPORT_STATE", () => {
  test("basic suffix", async () => {
    await roundTrips(
      "SELECT bool_and(v) EXPORT_STATE FROM t",
      `SELECT BOOL_AND("v") EXPORT_STATE FROM "t"`
    );
  });

  test("wrapped in finalize", async () => {
    await roundTrips("SELECT finalize(bool_and(v) EXPORT_STATE) FROM t");
  });

  test("cast to a struct state type", async () => {
    await roundTrips(
      `SELECT (arg_min(a, b) EXPORT_STATE)::STRUCT(arg INTEGER, "by" INTEGER) FROM t`
    );
  });

  test("throws on postgres", () => {
    assert.throws(
      () => format({ select: [["export-state", ["%sum", "a"]]] }, { dialect: "postgres" }),
      /not supported by dialect|require dialect/
    );
  });
});

// ===========================================================================
describe("composite type casts", () => {
  const cases = [
    ["SELECT {'a':1}::STRUCT(a INT)", /AS STRUCT\(a INT\)/],
    ["SELECT NULL::STRUCT(v STRUCT(x INT), n INT[])", /STRUCT\(v STRUCT\(x INT\), n INT\[\]\)/],
    ["SELECT MAP{'a':1}::MAP(VARCHAR, BIGINT)", /AS MAP\(VARCHAR, BIGINT\)/],
    ["SELECT 1::UNION(a INT, b VARCHAR)", /AS UNION\(a INT, b VARCHAR\)/],
    ["SELECT [1,2,3]::INT[3]", /AS INT\[3\]/],
    ["SELECT a::VARCHAR[][] FROM t", /AS VARCHAR\[\]\[\]/],
    ["SELECT NULL::int[] FROM t", /AS int\[\]/],
  ] as const;

  for (const [sql, expect] of cases) {
    test(sql.slice(7, 55), async () => {
      const out = await roundTrips(sql);
      assert.match(out, expect);
    });
  }

  test("quoted field names inside a struct type survive", async () => {
    const out = await roundTrips(`SELECT x::STRUCT(arg INTEGER, "by" INTEGER) FROM t`);
    assert.match(out, /"by" INTEGER/);
    assert.doesNotMatch(out, /""by""/);
  });

  test("numeric precision types still go through keyword casing", async () => {
    await roundTrips(
      "SELECT a::numeric(7,4) FROM t",
      `SELECT CAST("a" AS NUMERIC(7,4)) FROM "t"`
    );
  });
});

// ===========================================================================
describe("field access", () => {
  test("on a struct literal", async () => {
    await roundTrips("SELECT ({'a':1}).a", `SELECT ({'a': 1})."a"`);
  });

  test("chained", async () => {
    await roundTrips("SELECT (({'a':{'b':1}}).a).b");
  });

  test("on a function result", async () => {
    await roundTrips("SELECT (struct_pack(a := 1)).a");
  });

  test("emits on postgres too (composite syntax is shared)", () => {
    const out = format(
      { select: [["field", "rowval", "part"]] },
      { dialect: "postgres", inline: true }
    )[0];
    assert.equal(out, `SELECT ("rowval")."part"`);
  });
});

// ===========================================================================
describe("MAP literals", () => {
  test("basic", async () => {
    await roundTrips("SELECT MAP {'a': 1, 'b': 2}", "SELECT MAP {'a': 1, 'b': 2}");
  });

  test("non-string keys", async () => {
    await roundTrips("SELECT MAP {1: 'x', 2: 'y'}");
  });

  test("throws on postgres", () => {
    assert.throws(
      () => format({ select: [["map", [{ v: "a" }, { v: 1 }]]] }, { dialect: "postgres" }),
      /require dialect 'duckdb'/
    );
  });
});

// ===========================================================================
describe("dollar-quoted strings", () => {
  test("plain", async () => {
    await roundTrips("SELECT $$hello$$", "SELECT 'hello'");
  });

  test("with embedded quotes", async () => {
    await roundTrips("SELECT $$it's$$", "SELECT 'it''s'");
  });

  test("tagged", async () => {
    await roundTrips("SELECT $tag$a$b$tag$", "SELECT 'a$b'");
  });

  test("brackets inside are not list literals", async () => {
    await roundTrips("SELECT CAST($$['x','y']$$ AS VARCHAR[])");
  });
});

// ===========================================================================
describe("scientific notation", () => {
  // Literals emit VERBATIM: rewriting 1.5e-3 to 0.0015 would silently retype
  // the value from DOUBLE to DECIMAL (caught by executing both forms).
  test("negative exponent", async () => {
    await roundTrips("SELECT 1.5e-3", "SELECT 1.5e-3");
  });

  test("explicit positive exponent", async () => {
    await roundTrips("SELECT 1E+10", "SELECT 1E+10");
  });

  test("tiny exponent keeps exponent spelling", async () => {
    await roundTrips("SELECT 1e-7", "SELECT 1e-7");
  });

  test("identifiers containing digits-e are untouched", async () => {
    const clause = fromSql("SELECT a1e5 FROM t", { dialect: "duckdb" });
    assert.deepEqual(clause.select, ["a1e5"]);
  });
});

// ===========================================================================
describe("integer division //", () => {
  test("round-trips", async () => {
    await roundTrips("SELECT 5 // 2", "SELECT 5 // 2");
  });

  test("chains left-associatively", async () => {
    await roundTrips("SELECT 100 // 5 // 2", "SELECT 100 // 5 // 2");
  });

  test("throws on postgres — floor semantics are not divisions", () => {
    assert.throws(
      () => format({ select: [["//", { v: 5 }, { v: 2 }]] }, { dialect: "postgres" }),
      /require dialect 'duckdb'/
    );
  });
});

// ===========================================================================
describe("COLLATE", () => {
  test("round-trips", async () => {
    await roundTrips("SELECT x COLLATE NOCASE FROM t", `SELECT "x" COLLATE NOCASE FROM "t"`);
  });

  test("in a WHERE comparison", async () => {
    await roundTrips("SELECT * FROM t WHERE a COLLATE NOCASE = 'x'");
  });
});

// ===========================================================================
describe("INTERVAL forms", () => {
  test("INTERVAL n UNIT becomes a cast, not a function call", async () => {
    // INTERVAL (5) SECOND *parses* upstream but as INTERVAL(5) AS "second" —
    // the meaning-destroying trap this rewrite exists to avoid.
    await roundTrips("SELECT INTERVAL 5 SECOND", "SELECT CAST('5 SECOND' AS INTERVAL)");
  });

  test("INTERVAL (expr) UNIT becomes multiplication", async () => {
    await roundTrips(
      "SELECT INTERVAL (r) SECOND FROM t",
      `SELECT "r" * CAST('1 SECOND' AS INTERVAL) FROM "t"`
    );
  });
});

// ===========================================================================
describe("unaliased derived tables", () => {
  test("FROM (SELECT ...) parses and the injected alias is stripped", async () => {
    const clause = fromSql("SELECT skewness(d) FROM (SELECT NULL::integer d)", {
      dialect: "duckdb",
    });
    assert.doesNotMatch(JSON.stringify(clause), /__hsq/);
    await roundTrips("SELECT skewness(d) FROM (SELECT NULL::integer d)");
  });

  test("multiple unaliased subqueries", async () => {
    await roundTrips("SELECT * FROM (SELECT 1 a), (SELECT 2 b)");
  });

  test("user aliases are never stripped", async () => {
    const clause = fromSql("SELECT * FROM (SELECT 1 a) t", { dialect: "duckdb" });
    assert.match(JSON.stringify(clause), /"t"/);
  });
});

// ===========================================================================
describe("GROUPING SETS", () => {
  test("round-trips", async () => {
    await roundTrips(
      "SELECT a, count(*) FROM t GROUP BY GROUPING SETS ((a), ())",
      `SELECT "a", COUNT(*) FROM "t" GROUP BY GROUPING SETS (("a"), ())`
    );
  });

  test("mixed bare and grouped items", async () => {
    await roundTrips("SELECT a, b FROM t GROUP BY GROUPING SETS (a, (a, b))");
  });

  test("emits on postgres (standard SQL)", () => {
    const out = format(
      { select: ["a"], from: ["t"], "group-by": [["grouping-sets", ["a"], []]] },
      { dialect: "postgres", inline: true }
    )[0];
    assert.match(out, /GROUPING SETS \(\("a"\), \(\)\)/);
  });
});

// ===========================================================================
describe("window features", () => {
  test("frames round-trip verbatim", async () => {
    await roundTrips(
      "SELECT sum(a) OVER (ORDER BY b ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) FROM t",
      `SELECT SUM("a") OVER (ORDER BY "b" ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) FROM "t"`
    );
  });

  test("frame EXCLUDE", async () => {
    const out = await roundTrips(
      "SELECT count(*) OVER (ORDER BY a ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE TIES) FROM t"
    );
    assert.match(out, /EXCLUDE TIES/);
  });

  test("frame with PARTITION BY keeps both", async () => {
    const out = await roundTrips(
      "SELECT sum(a) OVER (PARTITION BY g ORDER BY b ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t"
    );
    assert.match(out, /PARTITION BY "g"/);
    assert.match(out, /ROWS BETWEEN 1 PRECEDING/);
  });

  test("named WINDOW clauses expand inline", async () => {
    await roundTrips(
      "SELECT row_number() OVER w FROM t WINDOW w AS (ORDER BY a)",
      `SELECT ROW_NUMBER() OVER (ORDER BY "a") FROM "t"`
    );
  });

  test("window referencing another window", async () => {
    const out = await roundTrips(
      "SELECT row_number() OVER w2 FROM t WINDOW w1 AS (PARTITION BY g), w2 AS (w1 ORDER BY a)"
    );
    assert.match(out, /PARTITION BY "g"/);
    assert.match(out, /ORDER BY "a"/);
  });

  test("programmatic frame from structured fields", async () => {
    const out = duck({
      select: [["over", ["%sum", "a"], {
        "order-by": [["b", "asc"]],
        frame: { units: "rows", start: "1 PRECEDING", end: "CURRENT ROW", exclude: "ties" },
      }]],
      from: ["t"],
    });
    assert.match(out, /ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES/);
    assert.ok((await checkSyntax(out)).valid, out);
  });
});

// ===========================================================================
describe("join variants", () => {
  test("ASOF JOIN", async () => {
    await roundTrips(
      "SELECT t.x FROM t ASOF JOIN p ON t.ts >= p.ts",
      `SELECT "t"."x" FROM "t" ASOF JOIN "p" ON "t"."ts" >= "p"."ts"`
    );
  });

  test("ASOF LEFT JOIN", async () => {
    const out = await roundTrips("SELECT * FROM a ASOF LEFT JOIN b ON a.t >= b.t");
    assert.match(out, /ASOF LEFT JOIN/);
  });

  test("ASOF JOIN with compound condition", async () => {
    await roundTrips(
      "SELECT * FROM trades t ASOF JOIN prices p ON t.symbol = p.symbol AND t.w >= p.w"
    );
  });

  test("SEMI JOIN", async () => {
    const out = await roundTrips("SELECT * FROM a SEMI JOIN b ON a.i = b.i");
    assert.match(out, /SEMI JOIN/);
  });

  test("ANTI JOIN", async () => {
    const out = await roundTrips("SELECT * FROM a ANTI JOIN b ON a.i = b.i");
    assert.match(out, /ANTI JOIN/);
  });

  test("POSITIONAL JOIN has no ON", async () => {
    const out = await roundTrips(
      "SELECT * FROM a POSITIONAL JOIN b",
      `SELECT * FROM "a" POSITIONAL JOIN "b"`
    );
    assert.doesNotMatch(out, /\bON\b/);
  });

  test("POSITIONAL is no longer silently read as a table alias", () => {
    const clause = fromSql("SELECT * FROM a POSITIONAL JOIN b", { dialect: "duckdb" });
    assert.ok(clause["positional-join"], JSON.stringify(clause));
  });

  test("SEMI JOIN a subquery", async () => {
    await roundTrips("SELECT count(*) FROM t1 SEMI JOIN (SELECT i FROM t2) s ON t1.i = s.i");
  });

  test("ASOF JOIN ... USING", async () => {
    const out = await roundTrips("SELECT * FROM a ASOF JOIN b USING (sym, ts)");
    assert.match(out, /ASOF JOIN "b" USING \("sym", "ts"\)/);
  });

  test("variant joins throw on postgres", () => {
    for (const key of ["asof-join", "semi-join", "anti-join", "positional-join"]) {
      assert.throws(
        () => format({ select: ["*"], from: ["a"], [key]: [["b", null]] }, { dialect: "postgres" }),
        /require dialect 'duckdb'/,
        key
      );
    }
  });
});

// ===========================================================================
describe("USING SAMPLE", () => {
  test("percent", async () => {
    await roundTrips(
      "SELECT * FROM t USING SAMPLE 10%",
      `SELECT * FROM "t" USING SAMPLE 10%`
    );
  });

  test("rows", async () => {
    await roundTrips("SELECT * FROM t USING SAMPLE 5 ROWS");
  });

  test("reservoir with seed", async () => {
    await roundTrips("SELECT * FROM t USING SAMPLE reservoir(10) REPEATABLE (42)");
  });

  test("after WHERE", async () => {
    const out = await roundTrips("SELECT * FROM t WHERE a = 1 USING SAMPLE 10%");
    assert.match(out, /WHERE "a" = 1 USING SAMPLE 10%/);
  });

  test("parses into a structured spec", () => {
    const clause = fromSql("SELECT * FROM t USING SAMPLE reservoir(10) REPEATABLE (42)", {
      dialect: "duckdb",
    });
    const sample = clause.sample as Record<string, unknown>;
    assert.equal(sample.method, "reservoir");
    assert.equal(sample.seed, 42);
  });

  test("throws on postgres", () => {
    assert.throws(
      () => format({ select: ["*"], from: ["t"], sample: { raw: "10%" } }, { dialect: "postgres" }),
      /require dialect 'duckdb'/
    );
  });
});

// ===========================================================================
describe("QUALIFY parsing", () => {
  test("bare QUALIFY (no WHERE, no GROUP BY)", async () => {
    await roundTrips(
      "SELECT * FROM t QUALIFY row_number() OVER (PARTITION BY b) = 1",
      `SELECT * FROM "t" QUALIFY ROW_NUMBER() OVER (PARTITION BY "b") = 1`
    );
  });

  test("QUALIFY after WHERE", async () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE a > 0 QUALIFY row_number() OVER () = 1",
      { dialect: "duckdb" }
    );
    assert.ok(clause.qualify, "qualify key missing");
    assert.deepEqual(clause.where, [">", "a", { v: 0 }]);
  });

  test("QUALIFY after HAVING merges and splits back", async () => {
    const clause = fromSql(
      "SELECT a, count(*) FROM t GROUP BY a HAVING count(*) > 1 QUALIFY row_number() OVER () = 1",
      { dialect: "duckdb" }
    );
    assert.ok(clause.qualify);
    assert.ok(clause.having);
    await roundTrips(
      "SELECT a, count(*) FROM t GROUP BY a HAVING count(*) > 1 QUALIFY row_number() OVER () = 1"
    );
  });
});

// ===========================================================================
describe("INSERT modifiers", () => {
  test("INSERT OR REPLACE", async () => {
    await roundTrips(
      "INSERT OR REPLACE INTO t VALUES (1, 2)",
      `INSERT OR REPLACE INTO "t" VALUES (1, 2)`
    );
  });

  test("INSERT OR IGNORE with a column list", async () => {
    await roundTrips(
      "INSERT OR IGNORE INTO t (a, b) VALUES (1, 2)",
      `INSERT OR IGNORE INTO "t" ("a", "b") VALUES (1, 2)`
    );
  });

  test("INSERT OR REPLACE with a SELECT source", async () => {
    await roundTrips("INSERT OR REPLACE INTO t SELECT * FROM u");
  });

  test("INSERT BY NAME", async () => {
    await roundTrips(
      "INSERT INTO t BY NAME SELECT 42 AS j",
      `INSERT INTO "t" BY NAME SELECT 42 AS "j"`
    );
  });

  test("modifier keys throw on postgres", () => {
    assert.throws(
      () => format({ "insert-or-replace-into": "t", values: [[{ v: 1 }]] }, { dialect: "postgres" }),
      /require dialect 'duckdb'/
    );
  });
});

// ===========================================================================
describe("statement forms", () => {
  test("DESCRIBE table", async () => {
    await roundTrips("DESCRIBE t", `DESCRIBE "t"`);
  });

  test("DESCRIBE TABLE t normalizes", async () => {
    await roundTrips("DESCRIBE TABLE t", `DESCRIBE "t"`);
  });

  test("DESCRIBE SELECT", async () => {
    await roundTrips("DESCRIBE SELECT 1 AS a", `DESCRIBE SELECT 1 AS "a"`);
  });

  test("SUMMARIZE", async () => {
    await roundTrips("SUMMARIZE t", `SUMMARIZE "t"`);
  });

  test("SHOW TABLES", async () => {
    await roundTrips("SHOW TABLES", "SHOW TABLES");
  });

  test("DESCRIBE as a derived table", async () => {
    await roundTrips("SELECT column_name FROM (DESCRIBE SELECT 1 AS a)");
  });

  test("PIVOT statement", async () => {
    await roundTrips("PIVOT t ON a USING sum(b)", `PIVOT "t" ON "a" USING SUM("b")`);
  });

  test("PIVOT with IN filter and GROUP BY", async () => {
    await roundTrips(
      "PIVOT t ON a IN ('x','y') USING sum(b) GROUP BY c",
      `PIVOT "t" ON "a" IN ('x', 'y') USING SUM("b") GROUP BY "c"`
    );
  });

  test("PIVOT as a derived table", async () => {
    await roundTrips("SELECT * FROM (PIVOT t ON a USING sum(b))");
  });

  test("UNPIVOT statement", async () => {
    await roundTrips(
      "UNPIVOT t ON a, b INTO NAME n VALUE v",
      `UNPIVOT "t" ON "a", "b" INTO NAME "n" VALUE "v"`
    );
  });

  test("standard postfix PIVOT", async () => {
    await roundTrips("SELECT * FROM Produce PIVOT(SUM(sales) FOR quarter IN ('Q1','Q2'))");
  });

  test("statement clause keys throw on postgres", () => {
    for (const clause of [
      { describe: "t" },
      { summarize: "t" },
      { show: "TABLES" },
      { pivot: { style: "duckdb", source: "t", on: ["a"], using: [["%sum", "b"]] } },
    ] as SqlClause[]) {
      assert.throws(() => format(clause, { dialect: "postgres" }), /require dialect 'duckdb'/);
    }
  });
});

// ===========================================================================
describe("pre-existing parser bugs fixed along the way", () => {
  test("JOIN ... USING is no longer dropped", async () => {
    const out = await roundTrips("SELECT k FROM a JOIN b USING (el) GROUP BY k");
    assert.match(out, /USING \("el"\)/);
  });

  test("JOIN (subquery) keeps its join and condition on postgres too", () => {
    const clause = fromSql("SELECT * FROM t1 JOIN (SELECT i FROM t2) s ON t1.i = s.i");
    assert.ok(clause.join, "join key missing");
    const out = format(clause, { dialect: "postgres", inline: true })[0];
    assert.match(out, /INNER JOIN \(SELECT "i" FROM "t2"\) AS "s" ON/);
  });

  test("FROM range(10) tbl(i) keeps alias and column names", async () => {
    await roundTrips(
      "SELECT tbl.i FROM range(10) tbl(i)",
      `SELECT "tbl"."i" FROM RANGE(10) AS "tbl"("i")`
    );
  });

  test("::int[] no longer collapses to ARRAY", () => {
    const clause = fromSql("SELECT NULL::int[] FROM t");
    assert.deepEqual(clause.select, [["cast", null, "int[]"]]);
  });

  test("aggregate DISTINCT with ORDER BY", async () => {
    await roundTrips(
      "SELECT STRING_AGG(DISTINCT s ORDER BY s ASC) FROM t",
      `SELECT STRING_AGG(DISTINCT "s" ORDER BY "s" ASC) FROM "t"`
    );
  });

  test("CTE column aliases", async () => {
    const out = await roundTrips("WITH c(x, y) AS (SELECT 1, 2) SELECT * FROM c");
    assert.match(out, /"x", "y"/);
  });

  test("AS MATERIALIZED is dropped, body preserved", async () => {
    const out = await roundTrips("WITH c(x) AS MATERIALIZED (SELECT 1) SELECT * FROM c");
    assert.doesNotMatch(out, /MATERIALIZED/);
  });
});

// ===========================================================================
describe("set operations and grouping extras", () => {
  test("EXCEPT round-trips", async () => {
    await roundTrips("SELECT 1 EXCEPT SELECT 2", "SELECT 1 EXCEPT SELECT 2");
  });

  test("INTERSECT round-trips", async () => {
    await roundTrips("SELECT 1 INTERSECT SELECT 1", "SELECT 1 INTERSECT SELECT 1");
  });

  test("EXCEPT ALL round-trips", async () => {
    await roundTrips("SELECT 1 a EXCEPT ALL SELECT 1 a");
  });

  test("mixed set-op chains stay left-associative", async () => {
    // pgsql-ast-parser right-nests; the parser rebuilds left-associative —
    // (1 EXCEPT 1) UNION 2 = {1,2}, not 1 EXCEPT (1 UNION 2) = {}.
    await roundTrips(
      "SELECT 1 EXCEPT SELECT 1 UNION SELECT 2",
      "SELECT 1 EXCEPT SELECT 1 UNION SELECT 2"
    );
  });

  test("IS DISTINCT FROM round-trips", async () => {
    await roundTrips(
      "SELECT 1 IS DISTINCT FROM NULL",
      "SELECT 1 IS DISTINCT FROM NULL"
    );
  });

  test("chained IS [NOT] DISTINCT FROM with AND", async () => {
    await roundTrips("SELECT a IS DISTINCT FROM b AND a IS NOT DISTINCT FROM c FROM t");
  });

  test("list comprehension lowers to list_transform", async () => {
    await roundTrips(
      "SELECT [x*2 for x in [1,2,3] if x > 1]",
      `SELECT LIST_TRANSFORM(LIST_FILTER([1, 2, 3], "x" -> "x" > 1), "x" -> "x" * 2)`
    );
  });

  test("bare FROM VALUES gains parentheses", async () => {
    await roundTrips("SELECT col FROM VALUES (0), (1) AS tab(col)");
  });

  test("bare HAVING without GROUP BY", async () => {
    await roundTrips("SELECT 42 HAVING 42 > 20", "SELECT 42 HAVING 42 > 20");
  });

  test("FILTER without WHERE is normalised", async () => {
    const out = await roundTrips("SELECT sum(x) FILTER (x > 1) FROM t");
    assert.match(out, /FILTER \(WHERE/);
  });

  test("empty grouping items round-trip", async () => {
    await roundTrips("SELECT count(*) FROM t GROUP BY (), a");
  });

  test("trailing commas are dropped", async () => {
    await roundTrips("SELECT 1 a, 2 b, FROM t", `SELECT 1 AS "a", 2 AS "b" FROM "t"`);
  });

  test("NULLS ordering inside aggregate ORDER BY", async () => {
    await roundTrips("SELECT first(i ORDER BY i NULLS LAST) FROM t");
  });

  test("casts inside list literals are not slices", async () => {
    await roundTrips("SELECT [0.43::float, 0.6::float]");
  });

  test("subscript with a cast index is not a slice", async () => {
    await roundTrips("SELECT a[2::int] FROM t");
  });

  test("FROM-first keeps trailing clauses after FROM", async () => {
    const out = await roundTrips(
      "FROM (VALUES (1,2),(3,4)) AS t(k, v) SELECT DISTINCT ON (k) * ORDER BY k"
    );
    assert.ok(out.indexOf("FROM") < out.indexOf("ORDER BY"), out);
  });

  test("subscript field chains", async () => {
    await roundTrips("SELECT l[1].x FROM t", `SELECT ("l"[1])."x" FROM "t"`);
  });
});
