/**
 * Tests for the DuckDB source rewriting front end.
 *
 * Two things must hold for every construct:
 *   1. it parses (the rewrite produced PostgreSQL-parseable text), and
 *   2. it round-trips back to native DuckDB syntax that DuckDB accepts.
 *
 * (2) is what stops a rewrite from "working" by quietly discarding meaning.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fromSql } from "./parser.js";
import { format } from "./sql.js";
import { checkSyntax } from "./duckdb-oracle.js";
import { preprocessDuckDb, protectedSpans } from "./duckdb-preprocess.js";

const duck = (sql: string) =>
  format(fromSql(sql, { dialect: "duckdb" }), { dialect: "duckdb", inline: true })[0];

/** Parse as DuckDB, emit as DuckDB, and assert DuckDB accepts the result. */
async function roundTrips(input: string, expected?: string) {
  const out = duck(input);
  if (expected !== undefined) assert.equal(out, expected);
  const check = await checkSyntax(out);
  assert.ok(check.valid, `DuckDB rejected round-trip of ${input}\n  => ${out}\n  ${check.error}`);
  return out;
}

// ===========================================================================
describe("DuckDB preprocessor: list literals", () => {
  test("simple list", async () => {
    await roundTrips("SELECT [1, 2, 3]", "SELECT [1, 2, 3]");
  });

  test("empty list", async () => {
    await roundTrips("SELECT []", "SELECT []");
  });

  test("nested lists", async () => {
    await roundTrips("SELECT [[1, 2], [3, 4]]", "SELECT [[1, 2], [3, 4]]");
  });

  test("list in WHERE", async () => {
    await roundTrips("SELECT a FROM t WHERE b = [1, 2]");
  });

  test("list of strings", async () => {
    await roundTrips("SELECT ['a', 'b']", "SELECT ['a', 'b']");
  });

  test("subscripting is not rewritten as a literal", async () => {
    await roundTrips("SELECT a[1] FROM t", `SELECT a[1] FROM t`);
  });

  test("string-keyed subscripting", async () => {
    await roundTrips("SELECT col['key'] FROM t", `SELECT col['key'] FROM t`);
  });

  test("brackets inside string literals are untouched", () => {
    const out = preprocessDuckDb("SELECT '[1,2]' AS s");
    assert.equal(out, "SELECT '[1,2]' AS s");
  });

  test("brackets inside quoted identifiers are untouched", () => {
    const out = preprocessDuckDb(`SELECT "weird[col]" FROM t`);
    assert.equal(out, `SELECT "weird[col]" FROM t`);
  });

  test("comments are stripped, never rewritten as constructs", () => {
    // pgsql-ast-parser cannot tokenize some valid comment contents, so the
    // DuckDB path removes comments entirely — and their brackets must never
    // have become list literals along the way.
    const out = preprocessDuckDb("SELECT 1 -- [1,2]\n");
    assert.doesNotMatch(out, /__honey_list/);
    assert.doesNotMatch(out, /\[1,2\]/);
    assert.match(out, /^SELECT 1/);
  });
});

// ===========================================================================
describe("DuckDB preprocessor: struct literals", () => {
  test("simple struct", async () => {
    await roundTrips("SELECT {'a': 1}", "SELECT {'a': 1}");
  });

  test("multi-key struct", async () => {
    await roundTrips("SELECT {'a': 1, 'b': 'x'}", "SELECT {'a': 1, 'b': 'x'}");
  });

  test("struct containing a list", async () => {
    await roundTrips("SELECT {'a': [1, 2]}", "SELECT {'a': [1, 2]}");
  });

  test("struct in WHERE", async () => {
    await roundTrips("SELECT a FROM t WHERE b = {'k': 1}");
  });
});

// ===========================================================================
describe("DuckDB preprocessor: list slicing", () => {
  test("bounded slice", async () => {
    await roundTrips("SELECT a[1:2] FROM t", `SELECT a[1:2] FROM t`);
  });

  test("open upper bound", async () => {
    await roundTrips("SELECT a[2:] FROM t", `SELECT a[2:] FROM t`);
  });

  test("open lower bound", async () => {
    await roundTrips("SELECT a[:3] FROM t", `SELECT a[:3] FROM t`);
  });
});

// ===========================================================================
describe("DuckDB preprocessor: TRY_CAST", () => {
  test("basic", async () => {
    await roundTrips("SELECT TRY_CAST(a AS INT) FROM t", `SELECT TRY_CAST(a AS INT) FROM t`);
  });

  test("preserves precision", async () => {
    await roundTrips(
      "SELECT TRY_CAST(a AS DECIMAL(7,4)) FROM t",
      `SELECT TRY_CAST(a AS DECIMAL(7,4)) FROM t`
    );
  });

  test("plain CAST is unaffected", async () => {
    await roundTrips("SELECT CAST(a AS INT) FROM t", `SELECT CAST(a AS INT) FROM t`);
  });
});

// ===========================================================================
describe("DuckDB preprocessor: aggregate ORDER BY", () => {
  test("single ordering column", async () => {
    await roundTrips("SELECT list(v ORDER BY v) FROM t", `SELECT LIST(v ORDER BY v ASC) FROM t`);
  });

  test("descending", async () => {
    await roundTrips("SELECT arg_max(a, b, 3 ORDER BY a DESC) FROM t");
  });

  test("several ordering columns", async () => {
    await roundTrips("SELECT list(v ORDER BY v DESC, w ASC) FROM t");
  });

  test("with a preceding argument", async () => {
    await roundTrips("SELECT string_agg(x, ',' ORDER BY x) FROM t");
  });

  test("a subquery's own ORDER BY is left alone", async () => {
    // array(SELECT ... ORDER BY ...) — the ORDER BY belongs to the subquery.
    await roundTrips("SELECT array(SELECT i FROM t ORDER BY i DESC) AS a");
  });
});

// ===========================================================================
describe("DuckDB preprocessor: GROUP BY / ORDER BY ALL", () => {
  test("GROUP BY ALL emits a bare keyword, not a quoted column", async () => {
    const out = await roundTrips("SELECT a, count(*) FROM t GROUP BY ALL");
    assert.match(out, /GROUP BY ALL$/);
    assert.doesNotMatch(out, /"all"/i);
  });

  test("ORDER BY ALL", async () => {
    const out = await roundTrips("SELECT a FROM t ORDER BY ALL");
    assert.match(out, /ORDER BY ALL$/);
  });
});

// ===========================================================================
describe("DuckDB preprocessor: FROM-first syntax", () => {
  test("FROM t SELECT a", async () => {
    await roundTrips("FROM t SELECT a", `SELECT a FROM t`);
  });

  test("bare FROM becomes SELECT *", async () => {
    await roundTrips("FROM t", `SELECT * FROM t`);
  });

  test("FROM with WHERE", async () => {
    await roundTrips("FROM t WHERE a = 1");
  });

  test("INSERT INTO t FROM ...", async () => {
    await roundTrips("INSERT INTO t FROM u");
  });
});

// ===========================================================================
describe("DuckDB preprocessor: named arguments", () => {
  test("=> form", async () => {
    await roundTrips("SELECT histogram(i, bin_count => 10) FROM t");
  });

  test(":= form", async () => {
    await roundTrips("SELECT f(x := 1)");
  });
});

// ===========================================================================
describe("DuckDB preprocessor: == operator", () => {
  test("== normalises to =", async () => {
    await roundTrips("SELECT a FROM t WHERE i == 0", `SELECT a FROM t WHERE i = 0`);
  });

  test("!= is not touched", async () => {
    await roundTrips("SELECT a FROM t WHERE i != 0");
  });

  test("== inside a string literal is untouched", () => {
    assert.equal(preprocessDuckDb("SELECT 'a==b'"), "SELECT 'a==b'");
  });
});

// ===========================================================================
describe("DuckDB preprocessor: VALUES derived tables", () => {
  // Regression: fromToClause forced every derived table through selectToClause,
  // so a VALUES list collapsed to an empty clause and emitted "FROM ()".
  test("VALUES with a column alias list", async () => {
    await roundTrips(
      "SELECT * FROM (VALUES (1,2)) t(a,b)",
      `SELECT * FROM (VALUES (1, 2)) AS t(a, b)`
    );
  });

  test("multi-row VALUES", async () => {
    await roundTrips("SELECT * FROM (VALUES (1,2),(3,4)) AS t(a,b)");
  });

  test("aggregates over a VALUES table", async () => {
    await roundTrips("SELECT arg_min(a, b) FROM (VALUES (1, 10), (2, 5)) t(a, b)");
  });

  test("subquery with a column alias list", async () => {
    await roundTrips("SELECT * FROM (SELECT 1 AS x) t(a)");
  });

  test("subquery without one still works", async () => {
    await roundTrips("SELECT * FROM (SELECT 1 AS x) t");
  });
});

// ===========================================================================
describe("DuckDB preprocessor: scanner", () => {
  test("finds single-quoted strings", () => {
    const spans = protectedSpans("SELECT 'abc'");
    assert.equal(spans.length, 1);
    assert.equal("SELECT 'abc'".slice(spans[0]!.start, spans[0]!.end), "'abc'");
  });

  test("handles doubled quote escapes", () => {
    const sql = "SELECT 'it''s' , [1]";
    const out = preprocessDuckDb(sql);
    assert.match(out, /'it''s'/);
    assert.match(out, /__honey_list\(1\)/);
  });

  test("dollar-quoted blocks become single-quoted strings, contents untouched", () => {
    // The content must survive verbatim — in particular the brackets must NOT
    // be rewritten as a list literal.
    assert.equal(preprocessDuckDb("SELECT $$ [1,2] $$"), "SELECT ' [1,2] '");
    assert.equal(preprocessDuckDb("SELECT $tag$it's$tag$"), "SELECT 'it''s'");
    assert.equal(preprocessDuckDb("SELECT $$a$b$$"), "SELECT 'a$b'");
  });

  test("block comments are stripped whole", () => {
    assert.equal(preprocessDuckDb("SELECT /* [1,2] */ 1").replace(/\s+/g, " "), "SELECT 1");
  });

  test("nested block comments are stripped whole", () => {
    assert.equal(
      preprocessDuckDb("SELECT /* a /* b */ [1] */ 1").replace(/\s+/g, " "),
      "SELECT 1"
    );
  });
});

// ===========================================================================
describe("DuckDB preprocessor: postgres parsing is unaffected", () => {
  // The preprocessor must be opt-in. Without {dialect:"duckdb"} nothing changes.
  const unchanged = [
    "SELECT a FROM t WHERE b = 1",
    "SELECT a[1] FROM t",
    "SELECT count(*) FROM t GROUP BY a",
    "WITH x AS (SELECT 1 AS a) SELECT * FROM x",
    "SELECT CAST(a AS INT) FROM t",
  ];

  for (const sql of unchanged) {
    test(`unchanged: ${sql.slice(0, 44)}`, () => {
      assert.deepEqual(fromSql(sql), fromSql(sql, { dialect: "duckdb" }));
    });
  }

  test("DuckDB-only syntax still fails on the postgres front end", () => {
    for (const sql of ["SELECT [1,2]", "SELECT {'a':1}", "FROM t SELECT a"]) {
      assert.throws(() => fromSql(sql), `${sql} should not parse as postgres`);
    }
  });
});
