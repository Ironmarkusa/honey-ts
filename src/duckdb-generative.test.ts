/**
 * Generative tests for the DuckDB dialect.
 *
 * The corpus tests prove we handle SQL that DuckDB's own suite contains; these
 * prove the reverse direction — that arbitrary clause maps built through the
 * honey-ts API emit SQL DuckDB accepts. Every generated statement is checked by
 * the real DuckDB parser, so a malformed emitter rule fails here even if no
 * hand-written test happens to cover that shape.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { format } from "./sql.js";
import { checkSyntax } from "./duckdb-oracle.js";
import type { SqlClause, SqlExpr } from "./types.js";
import "./pg-ops.js";

const duck = (clause: SqlClause) =>
  format(clause, { dialect: "duckdb", inline: true })[0];

/** Assert a generated clause both emits and survives DuckDB's parser. */
async function accepts(clause: SqlClause): Promise<void> {
  let sql: string;
  try {
    sql = duck(clause);
  } catch (e) {
    assert.fail(
      `emitter threw on ${JSON.stringify(clause)}\n  ${e instanceof Error ? e.message : e}`
    );
  }
  const check = await checkSyntax(sql);
  assert.ok(
    check.valid,
    `DuckDB rejected: ${sql}\n  ${check.error}\n  clause: ${JSON.stringify(clause)}`
  );
}

// --- generators -------------------------------------------------------------

const ident = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);
const intVal = fc.integer({ min: -1000, max: 1000 }).map((v) => ({ v }));
const strVal = fc
  .stringMatching(/^[a-zA-Z0-9 _-]{0,15}$/)
  .map((v) => ({ v }));
const scalar: fc.Arbitrary<SqlExpr> = fc.oneof(intVal, strVal, ident);

/** DuckDB list literal: [1, 'a', col] */
const listLiteral: fc.Arbitrary<SqlExpr> = fc
  .array(scalar, { minLength: 0, maxLength: 4 })
  .map((items) => ["list", ...items] as SqlExpr);

/** Nested list literal: [[1], [2, 3]] */
const nestedList: fc.Arbitrary<SqlExpr> = fc
  .array(fc.array(intVal, { minLength: 0, maxLength: 3 }), { minLength: 1, maxLength: 3 })
  .map((rows) => ["list", ...rows.map((r) => ["list", ...r])] as SqlExpr);

/** DuckDB struct literal: {'a': 1, 'b': 'x'} */
const structLiteral: fc.Arbitrary<SqlExpr> = fc
  .uniqueArray(fc.tuple(ident, scalar), {
    minLength: 1,
    maxLength: 4,
    selector: ([k]) => k,
  })
  .map((pairs) => ["struct", ...pairs] as SqlExpr);

/** Lambda over a list: list_transform([...], x -> x + 1) */
const lambdaExpr: fc.Arbitrary<SqlExpr> = fc
  .tuple(fc.constantFrom("x", "y", "e"), fc.integer({ min: 1, max: 50 }))
  .map(([param, n]) => [
    "%list_transform",
    ["list", { v: 1 }, { v: 2 }, { v: 3 }],
    ["lambda", param, ["+", param, { v: n }]],
  ] as SqlExpr);

/** Multi-parameter lambda. */
const lambda2Expr: fc.Arbitrary<SqlExpr> = fc
  .constant([
    "%list_zip",
    ["list", { v: 1 }],
    ["lambda", ["x", "y"], ["+", "x", "y"]],
  ] as SqlExpr);

/** Operators that lower to DuckDB functions. */
const loweredOp: fc.Arbitrary<SqlExpr> = fc
  .tuple(
    fc.constantFrom("~*", "!~*", "#>", "#>>", "?", "@?", "@>", "<@"),
    ident,
    fc.stringMatching(/^[a-z$.]{1,8}$/)
  )
  .map(([op, col, arg]) => [op, col, { v: arg }] as SqlExpr);

/** Operators DuckDB shares with PostgreSQL. */
const nativeOp: fc.Arbitrary<SqlExpr> = fc
  .tuple(fc.constantFrom("=", "<>", "<", ">", "<=", ">=", "~", "like", "ilike"), ident, scalar)
  .map(([op, col, val]) => [op, col, val] as SqlExpr);

const selectItem: fc.Arbitrary<SqlExpr> = fc.oneof(
  ident,
  listLiteral,
  nestedList,
  structLiteral,
  lambdaExpr,
  lambda2Expr,
  fc.constant("*" as SqlExpr)
);

/**
 * Star with EXCLUDE / REPLACE modifiers.
 *
 * The two column lists are partitioned from one distinct pool because DuckDB
 * forbids a column from appearing in both. The overlapping case is covered by
 * an explicit test below, which asserts the emitter refuses it.
 */
const starExpr: fc.Arbitrary<SqlExpr> = fc
  .tuple(
    fc.uniqueArray(ident, { minLength: 0, maxLength: 5 }),
    fc.integer({ min: 0, max: 5 })
  )
  .map(([cols, split]) => {
    const exclude = cols.slice(0, split);
    const replace = cols.slice(split);
    const spec: Record<string, unknown> = {};
    if (exclude.length) spec.exclude = exclude;
    if (replace.length) spec.replace = replace.map((c) => [["%lower", c], c]);
    return ["star", spec] as SqlExpr;
  });

const whereExpr: fc.Arbitrary<SqlExpr> = fc.oneof(
  nativeOp,
  loweredOp,
  fc.tuple(fc.constantFrom("and", "or"), nativeOp, loweredOp).map(
    ([op, l, r]) => [op, l, r] as SqlExpr
  )
);

const clauseArb: fc.Arbitrary<SqlClause> = fc
  .tuple(
    fc.array(selectItem, { minLength: 1, maxLength: 4 }),
    ident,
    fc.option(whereExpr, { nil: undefined }),
    fc.option(fc.array(ident, { minLength: 1, maxLength: 2 }), { nil: undefined }),
    fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined })
  )
  .map(([select, from, where, groupBy, limit]) => {
    const clause: SqlClause = { select, from: [from] };
    if (where) clause.where = where;
    if (groupBy) clause["group-by"] = groupBy;
    if (limit !== undefined) clause.limit = { v: limit };
    return clause;
  });

// --- properties -------------------------------------------------------------

// Each run makes a real DuckDB parser call, but PREPARE/DEALLOCATE on an
// in-memory database costs microseconds, so we can afford a deep sweep.
const RUNS = 500;

describe("DuckDB generative: emitted SQL is always valid", () => {
  test("arbitrary clause maps", async () => {
    await fc.assert(
      fc.asyncProperty(clauseArb, async (clause) => {
        await accepts(clause);
      }),
      { numRuns: RUNS }
    );
  });

  test("list literals", async () => {
    await fc.assert(
      fc.asyncProperty(listLiteral, async (expr) => {
        await accepts({ select: [expr] });
      }),
      { numRuns: RUNS }
    );
  });

  test("nested list literals", async () => {
    await fc.assert(
      fc.asyncProperty(nestedList, async (expr) => {
        await accepts({ select: [expr] });
      }),
      { numRuns: RUNS }
    );
  });

  test("struct literals", async () => {
    await fc.assert(
      fc.asyncProperty(structLiteral, async (expr) => {
        await accepts({ select: [expr] });
      }),
      { numRuns: RUNS }
    );
  });

  test("lambda expressions", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(lambdaExpr, lambda2Expr), async (expr) => {
        await accepts({ select: [expr] });
      }),
      { numRuns: RUNS }
    );
  });

  test("star modifiers", async () => {
    await fc.assert(
      fc.asyncProperty(starExpr, async (expr) => {
        await accepts({ select: [expr], from: ["t"] });
      }),
      { numRuns: RUNS }
    );
  });

  test("lowered operators", async () => {
    await fc.assert(
      fc.asyncProperty(loweredOp, async (expr) => {
        await accepts({ select: [{ v: 1 }], from: ["t"], where: expr });
      }),
      { numRuns: RUNS }
    );
  });

  test("QUALIFY", async () => {
    await fc.assert(
      fc.asyncProperty(ident, fc.integer({ min: 1, max: 10 }), async (col, n) => {
        await accepts({
          select: [col],
          from: ["t"],
          qualify: ["=", ["over", ["%row_number"], { "partition-by": [col] }], { v: n }],
        });
      }),
      { numRuns: RUNS }
    );
  });
});

describe("DuckDB generative: dialect isolation", () => {
  test("DuckDB-only constructs never emit on postgres", () => {
    fc.assert(
      fc.property(
        fc.oneof(listLiteral, structLiteral, lambdaExpr, starExpr),
        (expr) => {
          assert.throws(
            () => format({ select: [expr], from: ["t"] }, { dialect: "postgres" }),
            /require dialect 'duckdb'/
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  test("a column in both EXCLUDE and REPLACE is refused", () => {
    // DuckDB: 'Column "x" cannot occur in both EXCLUDE and REPLACE list'.
    // Found by this suite before the emitter checked for it.
    fc.assert(
      fc.property(ident, fc.uniqueArray(ident, { minLength: 0, maxLength: 2 }), (col, others) => {
        assert.throws(
          () =>
            duck({
              select: [
                ["star", { exclude: [col, ...others], replace: [[["%lower", col], col]] }],
              ],
              from: ["t"],
            }),
          /cannot appear in both EXCLUDE and REPLACE/
        );
      }),
      { numRuns: RUNS }
    );
  });

  test("operators DuckDB lacks never emit on duckdb", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("@@", "<->", "?|", "?&", "#-"),
        ident,
        (op, col) => {
          assert.throws(
            () => duck({ select: [{ v: 1 }], from: ["t"], where: [op, col, { v: "x" }] }),
            /is not supported by dialect 'duckdb'/
          );
        }
      ),
      { numRuns: RUNS }
    );
  });
});
