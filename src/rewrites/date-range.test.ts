import { describe, it } from "node:test";
import assert from "node:assert";
import { fromSql, toSql } from "../index.js";
import { describeDatePredicates, rewriteDateRange } from "./date-range.js";

function renderSql(clause: unknown): string {
  const [sql] = toSql(clause as never, { inline: true }) as [string, ...unknown[]];
  return sql;
}

describe("describeDatePredicates", () => {
  it("finds a BETWEEN predicate", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE d BETWEEN '2024-01-01' AND '2024-12-31'"
    );
    const preds = describeDatePredicates(clause);
    assert.strictEqual(preds.length, 1);
    assert.strictEqual(preds[0]!.source, "between");
    assert.strictEqual(preds[0]!.column, "d");
  });

  it("finds a half-open range as a single entry", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE d >= '2024-01-01' AND d < '2024-02-01'"
    );
    const preds = describeDatePredicates(clause);
    assert.strictEqual(preds.length, 1);
    assert.strictEqual(preds[0]!.source, "range");
    assert.strictEqual(preds[0]!.fromInclusive, true);
    assert.strictEqual(preds[0]!.toInclusive, false);
  });

  it("finds a single-bound range", () => {
    const clause = fromSql("SELECT * FROM t WHERE d >= '2024-01-01'");
    const preds = describeDatePredicates(clause);
    assert.strictEqual(preds.length, 1);
    assert.strictEqual(preds[0]!.source, "range");
    assert.ok(preds[0]!.from);
    assert.strictEqual(preds[0]!.to, undefined);
  });

  it("ignores equality predicates (ambiguous shape)", () => {
    const clause = fromSql("SELECT * FROM t WHERE d = '2024-01-01'");
    const preds = describeDatePredicates(clause);
    assert.strictEqual(preds.length, 0);
  });

  it("finds predicates in subqueries and CTEs with correct scope", () => {
    const clause = fromSql(
      "WITH c AS (SELECT * FROM a WHERE d >= '2024-01-01') SELECT * FROM c WHERE d < '2025-01-01'"
    );
    const preds = describeDatePredicates(clause);
    assert.strictEqual(preds.length, 2);
    const scopes = preds.map((p) => p.scope);
    assert.ok(scopes.some((s) => s.includes("with:c")));
    assert.ok(scopes.some((s) => s === "root.where"));
  });

  it("groups multiple date columns separately", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE created_at >= '2024-01-01' AND updated_at < '2024-12-31'"
    );
    const preds = describeDatePredicates(clause);
    assert.strictEqual(preds.length, 2);
    const cols = preds.map((p) => p.column).sort();
    assert.deepStrictEqual(cols, ["created_at", "updated_at"]);
  });

  it("returns no predicates when none present", () => {
    const clause = fromSql("SELECT * FROM t WHERE status = 'active'");
    const preds = describeDatePredicates(clause);
    assert.strictEqual(preds.length, 0);
  });
});

describe("rewriteDateRange", () => {
  it("swaps a half-open range on an explicit column", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE d >= '2024-01-01' AND d < '2024-02-01'"
    );
    const result = rewriteDateRange(clause, {
      column: "d",
      from: "2025-01-01",
      to: "2025-02-01",
    });
    const sql = renderSql(result);
    assert.match(sql, /"d" >= '2025-01-01'/);
    assert.match(sql, /"d" < '2025-02-01'/);
    assert.doesNotMatch(sql, /2024/);
  });

  it("swaps a BETWEEN predicate for a half-open range by default", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE d BETWEEN '2024-01-01' AND '2024-12-31'"
    );
    const result = rewriteDateRange(clause, {
      column: "d",
      from: "2025-01-01",
      to: "2025-12-31",
    });
    const sql = renderSql(result);
    assert.doesNotMatch(sql, /BETWEEN/);
    assert.match(sql, />=/);
    assert.match(sql, /</);
  });

  it("emits BETWEEN when strategy=between", () => {
    const clause = fromSql("SELECT * FROM t WHERE d >= '2024-01-01'");
    const result = rewriteDateRange(clause, {
      column: "d",
      from: "2025-01-01",
      to: "2025-12-31",
      strategy: "between",
    });
    const sql = renderSql(result);
    assert.match(sql, /BETWEEN '2025-01-01' AND '2025-12-31'/);
  });

  it("emits fully-inclusive when strategy=inclusive", () => {
    const clause = fromSql("SELECT * FROM t WHERE d >= '2024-01-01'");
    const result = rewriteDateRange(clause, {
      column: "d",
      from: "2025-01-01",
      to: "2025-12-31",
      strategy: "inclusive",
    });
    const sql = renderSql(result);
    assert.match(sql, /"d" <= '2025-12-31'/);
  });

  it("preserves non-date predicates", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE status = 'active' AND d >= '2024-01-01' AND d < '2024-02-01' AND region = 'us'"
    );
    const result = rewriteDateRange(clause, {
      column: "d",
      from: "2025-01-01",
      to: "2025-02-01",
    });
    const sql = renderSql(result);
    assert.match(sql, /"status" = 'active'/);
    assert.match(sql, /"region" = 'us'/);
  });

  it("rewrites in subqueries and CTEs", () => {
    const clause = fromSql(
      "WITH c AS (SELECT * FROM a WHERE d >= '2024-01-01') SELECT * FROM c WHERE d < '2025-01-01'"
    );
    const result = rewriteDateRange(clause, {
      column: "d",
      from: "2026-01-01",
      to: "2026-02-01",
    });
    const sql = renderSql(result);
    assert.doesNotMatch(sql, /2024-01-01/);
    assert.doesNotMatch(sql, /2025-01-01/);
    // CTE body should have new range
    assert.ok((sql.match(/2026/g) ?? []).length >= 2);
  });

  it("auto-detects column when only one date column exists", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE d >= '2024-01-01' AND d < '2024-02-01'"
    );
    const result = rewriteDateRange(clause, {
      from: "2025-01-01",
      to: "2025-02-01",
    });
    const sql = renderSql(result);
    assert.match(sql, /2025-01-01/);
  });

  it("throws when multiple date columns exist and none specified", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE created_at >= '2024-01-01' AND updated_at < '2024-02-01'"
    );
    assert.throws(
      () =>
        rewriteDateRange(clause, {
          from: "2025-01-01",
          to: "2025-02-01",
        }),
      /multiple date columns/
    );
  });

  it("throws when no date predicate exists and no column specified", () => {
    const clause = fromSql("SELECT * FROM t WHERE status = 'active'");
    assert.throws(
      () => rewriteDateRange(clause, { from: "2025-01-01", to: "2025-02-01" }),
      /no date-range predicates/
    );
  });

  it("is idempotent when applied twice with the same range", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE d >= '2024-01-01' AND d < '2024-02-01'"
    );
    const once = rewriteDateRange(clause, {
      column: "d",
      from: "2025-01-01",
      to: "2025-02-01",
    });
    const twice = rewriteDateRange(once, {
      column: "d",
      from: "2025-01-01",
      to: "2025-02-01",
    });
    assert.strictEqual(renderSql(once), renderSql(twice));
  });

  it("accepts Date objects for from/to", () => {
    const clause = fromSql("SELECT * FROM t WHERE d >= '2024-01-01'");
    const result = rewriteDateRange(clause, {
      column: "d",
      from: new Date("2025-03-15T00:00:00Z"),
      to: new Date("2025-04-15T00:00:00Z"),
    });
    const sql = renderSql(result);
    assert.match(sql, /2025-03-15/);
    assert.match(sql, /2025-04-15/);
  });
});
