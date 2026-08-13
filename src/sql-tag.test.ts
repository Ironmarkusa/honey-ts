/**
 * Tests for the sql`` tagged template: literal text is raw SQL, every
 * interpolation is a bound parameter unless it's a recognized honey construct.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { format, sql, ident, $, raw, literal } from "./sql.js";
import { checkSyntax } from "./duckdb-oracle.js";
import type { SqlClause } from "./types.js";

describe("sql tagged template", () => {
  test("interpolations become parameters in order", () => {
    const [q, ...params] = format({
      select: ["*"], from: "users",
      where: sql`status = ${"active"} AND age > ${21}`,
    } as SqlClause);
    assert.equal(q, "SELECT * FROM users WHERE status = $1 AND age > $2");
    assert.deepEqual(params, ["active", 21]);
  });

  test("hostile input stays a parameter", () => {
    const evil = "'; DROP TABLE users; --";
    const [q, ...params] = format({ select: ["*"], from: "t", where: sql`name = ${evil}` } as SqlClause);
    assert.equal(q, "SELECT * FROM t WHERE name = $1");
    assert.deepEqual(params, [evil]);
  });

  test("fragments nest with correct parameter numbering", () => {
    const tenant = sql`tenant_id = ${"t1"}`;
    const [q, ...params] = format({
      select: ["*"], from: "t",
      where: sql`${tenant} AND active = ${true}`,
    } as SqlClause);
    assert.equal(q, "SELECT * FROM t WHERE tenant_id = $1 AND active = TRUE");
    assert.deepEqual(params, ["t1"]); // booleans inline as SQL keywords, honey convention
  });

  test("honey constructs splice as SQL", () => {
    const [q, ...params] = format({
      select: ["*"], from: "t",
      where: sql`${ident("user name")} = ${"bob"} AND id IN ${{ select: ["id"], from: "vips" } as SqlClause}`,
    } as SqlClause);
    assert.equal(q, `SELECT * FROM t WHERE "user name" = $1 AND id IN (SELECT id FROM vips)`);
    assert.deepEqual(params, ["bob"]);
  });

  test("expression arrays splice; $() forces an array parameter", () => {
    const [q1] = format({ select: ["*"], from: "t", where: sql`${["=", "a", { $: 1 }]}` } as SqlClause);
    assert.equal(q1, "SELECT * FROM t WHERE a = $1");

    const [q2, ...p2] = format({ select: ["*"], from: "t", where: sql`ids = ANY(${$([1, 2, 3])})` } as SqlClause);
    assert.equal(q2, "SELECT * FROM t WHERE ids = ANY($1)");
    assert.deepEqual(p2, [[1, 2, 3]]);
  });

  test("plain objects are parameters (JSONB payloads), not clauses", () => {
    const [q, ...params] = format({ select: ["*"], from: "t", where: sql`data = ${{ a: 1, b: [2] }}` } as SqlClause);
    assert.equal(q, "SELECT * FROM t WHERE data = $1");
    assert.deepEqual(params, [{ a: 1, b: [2] }]);
  });

  test("Dates are parameters", () => {
    const d = new Date("2024-01-01");
    const [, ...params] = format({ select: ["*"], from: "t", where: sql`ts > ${d}` } as SqlClause);
    assert.deepEqual(params, [d]);
  });

  test("raw() and literal() splice", () => {
    const [q] = format({
      select: [sql`${raw("NOW()")} - ${literal(7)}`], from: "t",
    } as SqlClause, { inline: true });
    assert.equal(q, "SELECT NOW() - 7 FROM t");
  });

  test("a whole statement as a fragment formats directly", () => {
    const [q, ...params] = format(sql`SELECT * FROM users WHERE id = ${5}` as never);
    assert.equal(q, "SELECT * FROM users WHERE id = $1");
    assert.deepEqual(params, [5]);
  });

  test("duckdb dialect placeholders and oracle acceptance", async () => {
    const [q, ...params] = format(
      { select: ["*"], from: "t", where: sql`a = ${1} AND b = ${2}` } as SqlClause,
      { dialect: "duckdb" }
    );
    assert.equal(q, "SELECT * FROM t WHERE a = ? AND b = ?");
    assert.deepEqual(params, [1, 2]);
    assert.ok((await checkSyntax(q.replace(/\?/g, "1"))).valid);
  });
});
