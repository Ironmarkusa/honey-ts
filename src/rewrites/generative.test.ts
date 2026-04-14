/**
 * Property tests for the rewrites layer.
 *
 * Invariants:
 *  - `rewriteDateRange` is idempotent when applied twice with the same range.
 *  - `rewriteDateRange` preserves non-date siblings byte-for-byte.
 *  - `replaceColumn` round-trips: format → parse → format is stable.
 *  - `addWhere` then `removeWhere` of the same condition returns the original.
 *  - `apply(c)` with no transforms equals c.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { fromSql, toSql } from "../index.js";
import type { SqlClause, SqlExpr } from "../types.js";
import { apply } from "./apply.js";
import { rewriteDateRange } from "./date-range.js";
import { addWhere, removeWhere } from "./modify.js";
import { replaceColumn } from "./rewrite.js";
import { col as colMatcher, op, and as mAnd, not as mNot } from "./matchers.js";

// ============================================================================
// Generators
// ============================================================================

const identName = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);
const dateStr = fc.date({
  min: new Date("2020-01-01"),
  max: new Date("2030-12-31"),
  noInvalidDate: true,
}).map((d) => d.toISOString().slice(0, 10));

function render(clause: SqlClause): string {
  const [sql] = toSql(clause, { inline: true }) as [string, ...unknown[]];
  return sql;
}

// A simple clause with a half-open date range + optional extra filters
function clauseWithDateRange(
  table: string,
  column: string,
  from: string,
  to: string,
  extraCol?: string,
  extraVal?: string
): SqlClause {
  const range: SqlExpr = [
    "and",
    [">=", column, { $: from }],
    ["<", column, { $: to }],
  ];
  const where: SqlExpr = extraCol && extraVal
    ? ["and", ["=", extraCol, { $: extraVal }], range]
    : range;
  return { select: ["*"], from: table, where };
}

// ============================================================================
// rewriteDateRange properties
// ============================================================================

describe("rewriteDateRange properties", () => {
  it("is idempotent when applied twice with the same range", () => {
    fc.assert(
      fc.property(
        fc.record({
          table: identName,
          column: identName,
          origFrom: dateStr,
          origTo: dateStr,
          newFrom: dateStr,
          newTo: dateStr,
        }),
        ({ table, column, origFrom, origTo, newFrom, newTo }) => {
          fc.pre(origFrom < origTo);
          fc.pre(newFrom < newTo);
          const clause = clauseWithDateRange(table, column, origFrom, origTo);
          const once = rewriteDateRange(clause, {
            column,
            from: newFrom,
            to: newTo,
          });
          const twice = rewriteDateRange(once, {
            column,
            from: newFrom,
            to: newTo,
          });
          assert.strictEqual(render(once), render(twice));
        }
      ),
      { numRuns: 100 }
    );
  });

  it("preserves unrelated predicates in WHERE", () => {
    fc.assert(
      fc.property(
        fc.record({
          table: identName,
          column: identName,
          from: dateStr,
          to: dateStr,
          newFrom: dateStr,
          newTo: dateStr,
          extraCol: identName,
          extraVal: fc.stringMatching(/^[a-z]{1,10}$/),
        }),
        ({ table, column, from, to, newFrom, newTo, extraCol, extraVal }) => {
          fc.pre(from < to);
          fc.pre(newFrom < newTo);
          fc.pre(extraCol !== column);
          const clause = clauseWithDateRange(
            table,
            column,
            from,
            to,
            extraCol,
            extraVal
          );
          const result = rewriteDateRange(clause, {
            column,
            from: newFrom,
            to: newTo,
          });
          const sql = render(result);
          // Extra filter should still be there
          assert.ok(
            sql.includes(`"${extraCol}" = '${extraVal}'`),
            `expected extra filter preserved in: ${sql}`
          );
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ============================================================================
// replaceColumn round-trip
// ============================================================================

describe("replaceColumn round-trip", () => {
  it("format → parse → format is stable after rename", () => {
    fc.assert(
      fc.property(
        fc.record({
          table: identName,
          origCol: identName,
          newCol: identName,
          val: fc.stringMatching(/^[a-z0-9]{1,10}$/),
        }),
        ({ table, origCol, newCol, val }) => {
          fc.pre(origCol !== newCol);
          const clause: SqlClause = {
            select: [origCol],
            from: table,
            where: ["=", origCol, { $: val }],
          };
          const renamed = replaceColumn(clause, { from: origCol, to: newCol });
          const sql1 = render(renamed);
          const reparsed = fromSql(sql1);
          const sql2 = render(reparsed);
          assert.strictEqual(sql1, sql2);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// addWhere / removeWhere inverse
// ============================================================================

describe("addWhere → removeWhere inverse", () => {
  it("add then remove by exact match returns a clause equivalent to the original", () => {
    fc.assert(
      fc.property(
        fc.record({
          table: identName,
          origCol: identName,
          origVal: fc.stringMatching(/^[a-z]{1,5}$/),
          newCol: identName,
          newVal: fc.stringMatching(/^[a-z]{1,5}$/),
        }),
        ({ table, origCol, origVal, newCol, newVal }) => {
          fc.pre(origCol !== newCol);
          const start: SqlClause = {
            select: ["*"],
            from: table,
            where: ["=", origCol, { $: origVal }],
          };
          const newCond: SqlExpr = ["=", newCol, { $: newVal }];
          const added = addWhere(start, newCond);
          // Remove exactly the added condition by matching op("=") AND colMatcher(newCol)
          const matcher = mAnd(
            op("="),
            mNot(colMatcher(origCol)),
            (node) => Array.isArray(node) && (node as SqlExpr[])[1] === newCol
          );
          const removed = removeWhere(added, matcher);
          assert.strictEqual(render(removed), render(start));
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// apply identity
// ============================================================================

describe("apply identity", () => {
  it("apply(c) with no transforms equals c", () => {
    fc.assert(
      fc.property(
        fc.record({
          table: identName,
          column: identName,
        }),
        ({ table, column }) => {
          const clause: SqlClause = { select: [column], from: table };
          const result = apply(clause);
          assert.deepStrictEqual(result, clause);
        }
      ),
      { numRuns: 50 }
    );
  });
});
