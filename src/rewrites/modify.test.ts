import { describe, it } from "node:test";
import assert from "node:assert";
import { fromSql, toSql } from "../index.js";
import {
  addWhere,
  removeWhere,
  removePredicate,
  addSelect,
  removeSelect,
  addGroupBy,
  removeGroupBy,
  addOrderBy,
  setOrderBy,
  clearOrderBy,
  setLimit,
  setOffset,
  clearLimit,
} from "./modify.js";
import { col, op, dateRange } from "./matchers.js";

function renderSql(clause: unknown): string {
  const [sql] = toSql(clause as never, { inline: true }) as [string, ...unknown[]];
  return sql;
}

describe("addWhere", () => {
  it("sets WHERE when absent", () => {
    const clause = fromSql("SELECT * FROM t");
    const result = addWhere(clause, ["=", "tenant_id", { $: "acme" }]);
    assert.match(renderSql(result), /WHERE "tenant_id" = 'acme'/);
  });

  it("ANDs with existing WHERE", () => {
    const clause = fromSql("SELECT * FROM t WHERE x = 1");
    const result = addWhere(clause, ["=", "tenant_id", { $: "acme" }]);
    const sql = renderSql(result);
    assert.match(sql, /"x" = 1/);
    assert.match(sql, /"tenant_id" = 'acme'/);
    assert.match(sql, /AND/);
  });

  it("injects into subqueries with scope=all (default)", () => {
    const clause = fromSql(
      "SELECT * FROM a WHERE y IN (SELECT id FROM b WHERE z = 1)"
    );
    const result = addWhere(clause, ["=", "tenant_id", { $: "acme" }]);
    const sql = renderSql(result);
    // count occurrences
    const count = (sql.match(/tenant_id/g) ?? []).length;
    assert.strictEqual(count, 2);
  });

  it("scope=root only touches outer clause", () => {
    const clause = fromSql(
      "SELECT * FROM a WHERE y IN (SELECT id FROM b WHERE z = 1)"
    );
    const result = addWhere(clause, ["=", "tenant_id", { $: "acme" }], {
      scope: "root",
    });
    const sql = renderSql(result);
    const count = (sql.match(/tenant_id/g) ?? []).length;
    assert.strictEqual(count, 1);
  });

  it("dedups exact duplicate conditions", () => {
    const clause = fromSql("SELECT * FROM t WHERE x = 1");
    const cond: never = ["=", "x", { $: 1 }] as never;
    const once = addWhere(clause, cond);
    const twice = addWhere(once, cond);
    assert.deepStrictEqual(once, twice);
  });

  it("does not inject into clauses without FROM (e.g., pure VALUES)", () => {
    const clause = { values: [[{ $: 1 }, { $: 2 }]] as never };
    const result = addWhere(clause, ["=", "t", { $: "x" }]);
    assert.strictEqual(result.where, undefined);
  });
});

describe("removeWhere", () => {
  it("drops WHERE clause when the only predicate matches", () => {
    const clause = fromSql("SELECT * FROM t WHERE date >= '2024-01-01'");
    const result = removeWhere(clause, dateRange("date"));
    assert.strictEqual(result.where, undefined);
  });

  it("collapses AND when all children removed", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE date >= '2024-01-01' AND date < '2024-02-01'"
    );
    const result = removeWhere(clause, dateRange("date"));
    assert.strictEqual(result.where, undefined);
  });

  it("collapses 2-arg AND to single child when one removed", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE date >= '2024-01-01' AND status = 'active'"
    );
    const result = removeWhere(clause, dateRange("date"));
    // WHERE should now be just ["=", "status", ...]
    const where = result.where as unknown[];
    assert.strictEqual(where[0], "=");
  });

  it("keeps remaining children in N-ary AND", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE date >= '2024-01-01' AND a = 1 AND b = 2"
    );
    const result = removeWhere(clause, dateRange("date"));
    const sql = renderSql(result);
    assert.match(sql, /"a" = 1/);
    assert.match(sql, /"b" = 2/);
    assert.doesNotMatch(sql, /2024-01-01/);
  });

  it("removes in CTEs and subqueries", () => {
    const clause = fromSql(
      "WITH c AS (SELECT * FROM a WHERE d >= '2024-01-01') SELECT * FROM c WHERE d < '2025-01-01'"
    );
    const result = removeWhere(clause, dateRange("d"));
    const sql = renderSql(result);
    assert.doesNotMatch(sql, /d >= /);
    assert.doesNotMatch(sql, /d < /);
  });
});

describe("removePredicate", () => {
  it("drops from both WHERE and HAVING", () => {
    const clause = fromSql(
      "SELECT status FROM t WHERE x = 1 GROUP BY status HAVING COUNT(*) > 5"
    );
    const result = removePredicate(clause, op(">"));
    assert.strictEqual(result.having, undefined);
  });
});

describe("addSelect / removeSelect", () => {
  it("appends a select item", () => {
    const clause = fromSql("SELECT id FROM t");
    const result = addSelect(clause, "name");
    assert.match(renderSql(result), /"id", "name"/);
  });

  it("appends with alias", () => {
    const clause = fromSql("SELECT id FROM t");
    const result = addSelect(clause, ["%count", "*"], "total");
    assert.match(renderSql(result), /COUNT\(\*\) AS "total"/i);
  });

  it("removes by matcher", () => {
    const clause = fromSql("SELECT id, email, name FROM t");
    const result = removeSelect(clause, col("email"));
    const sql = renderSql(result);
    assert.match(sql, /"id", "name"/);
    assert.doesNotMatch(sql, /"email"/);
  });
});

describe("addGroupBy / removeGroupBy", () => {
  it("adds group-by column", () => {
    const clause = fromSql("SELECT status FROM t");
    const result = addGroupBy(clause, "status");
    assert.match(renderSql(result), /GROUP BY "status"/);
  });

  it("removes by matcher", () => {
    const clause = fromSql("SELECT * FROM t GROUP BY status, region");
    const result = removeGroupBy(clause, col("status"));
    const sql = renderSql(result);
    assert.match(sql, /GROUP BY "region"/);
  });
});

describe("order-by / limit / offset", () => {
  it("addOrderBy appends", () => {
    const clause = fromSql("SELECT * FROM t ORDER BY id");
    const result = addOrderBy(clause, [["name", "desc"]] as never);
    const sql = renderSql(result);
    assert.match(sql, /ORDER BY "id".*"name" DESC/);
  });

  it("addOrderBy prepends", () => {
    const clause = fromSql("SELECT * FROM t ORDER BY id");
    const result = addOrderBy(clause, [["name", "desc"]] as never, {
      position: "prepend",
    });
    const sql = renderSql(result);
    assert.match(sql, /ORDER BY "name" DESC.*"id"/);
  });

  it("setOrderBy replaces", () => {
    const clause = fromSql("SELECT * FROM t ORDER BY id");
    const result = setOrderBy(clause, [["name", "desc"]] as never);
    const sql = renderSql(result);
    assert.match(sql, /ORDER BY "name" DESC/);
    assert.doesNotMatch(sql, /"id"/);
  });

  it("clearOrderBy removes", () => {
    const clause = fromSql("SELECT * FROM t ORDER BY id");
    const result = clearOrderBy(clause);
    assert.doesNotMatch(renderSql(result), /ORDER BY/);
  });

  it("setLimit / setOffset / clearLimit", () => {
    const clause = fromSql("SELECT * FROM t");
    let r = setLimit(clause, 100);
    assert.match(renderSql(r), /LIMIT 100/);
    r = setOffset(r, 20);
    assert.match(renderSql(r), /OFFSET 20/);
    r = clearLimit(r);
    assert.doesNotMatch(renderSql(r), /LIMIT/);
  });
});
