import { describe, it } from "node:test";
import assert from "node:assert";
import { fromSql, toSql } from "../index.js";
import {
  replaceWhere,
  replacePredicate,
  replaceSelect,
  replaceTable,
  replaceColumn,
  replaceFunction,
} from "./rewrite.js";
import { col, op, fn, dateRange, and, not } from "./matchers.js";

// Helper: render SQL with values inlined so test assertions can match literals
function renderSql(clause: unknown): string {
  const [sql] = toSql(clause as never, { inline: true }) as [string, ...unknown[]];
  return sql;
}

describe("replaceWhere", () => {
  it("replaces a single predicate", () => {
    const clause = fromSql("SELECT * FROM t WHERE date >= '2024-01-01'");
    const result = replaceWhere(clause, dateRange("date"), [
      ">=",
      "date",
      { $: "2025-01-01" },
    ]);
    const sql = renderSql(result);
    assert.match(sql, /2025-01-01/);
    assert.doesNotMatch(sql, /2024-01-01/);
  });

  it("replaces multiple matching predicates in a conjunction", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE date >= '2024-01-01' AND date < '2024-02-01'"
    );
    const result = replaceWhere(
      clause,
      and(dateRange("date"), not(op("and"))),
      (hit) => {
        if (!Array.isArray(hit)) return null;
        const [opName, colExpr, ...rest] = hit;
        // only swap the value, not column or operator
        return [opName, colExpr, ...rest.map(() => ({ $: "TOKEN" }))] as never;
      }
    );
    const sql = renderSql(result);
    assert.doesNotMatch(sql, /2024-01-01/);
    assert.doesNotMatch(sql, /2024-02-01/);
  });

  it("replaces predicates inside subqueries", () => {
    const clause = fromSql(
      "SELECT * FROM a WHERE x IN (SELECT id FROM b WHERE d >= '2024-01-01')"
    );
    const result = replaceWhere(clause, dateRange("d"), [
      ">=",
      "d",
      { $: "2025-01-01" },
    ]);
    const sql = renderSql(result);
    assert.match(sql, /2025-01-01/);
  });

  it("replaces predicates inside CTEs", () => {
    const clause = fromSql(
      "WITH c AS (SELECT * FROM t WHERE d >= '2024-01-01') SELECT * FROM c"
    );
    const result = replaceWhere(clause, dateRange("d"), [
      ">=",
      "d",
      { $: "2025-01-01" },
    ]);
    const sql = renderSql(result);
    assert.match(sql, /2025-01-01/);
  });

  it("leaves HAVING predicates alone", () => {
    const clause = fromSql(
      "SELECT status FROM t GROUP BY status HAVING COUNT(*) > 5"
    );
    const result = replaceWhere(clause, op(">"), [">", ["%count", "*"], { $: 99 }]);
    const sql = renderSql(result);
    assert.match(sql, /> 5/);  // unchanged
  });

  it("returning null from the replacement function preserves the node", () => {
    const clause = fromSql("SELECT * FROM t WHERE d >= '2024-01-01'");
    const result = replaceWhere(clause, dateRange("d"), () => null);
    assert.strictEqual(renderSql(result), renderSql(clause));
  });
});

describe("replacePredicate", () => {
  it("rewrites both WHERE and HAVING", () => {
    const clause = fromSql(
      "SELECT status FROM t WHERE x = 1 GROUP BY status HAVING COUNT(*) > 5"
    );
    const result = replacePredicate(
      clause,
      op("="),
      ["=", "x", { $: 42 }]
    );
    const sqlBefore = renderSql(clause);
    const sqlAfter = renderSql(result);
    assert.notStrictEqual(sqlAfter, sqlBefore);
    assert.match(sqlAfter, /42/);
  });
});

describe("replaceSelect", () => {
  it("replaces a bare column select", () => {
    const clause = fromSql("SELECT id, email FROM users");
    const result = replaceSelect(clause, col("email"), ["%lower", "email"]);
    assert.match(renderSql(result), /LOWER/i);
  });

  it("preserves alias when replacing aliased expressions", () => {
    const clause = fromSql("SELECT COUNT(*) as total FROM users");
    const result = replaceSelect(clause, fn("count"), [
      "%count-distinct",
      "id",
    ]);
    const sql = renderSql(result);
    assert.match(sql, /COUNT\(DISTINCT/i);
    assert.match(sql, /total/);
  });
});

describe("replaceTable", () => {
  it("renames table in FROM", () => {
    const clause = fromSql("SELECT * FROM users WHERE id = 1");
    const result = replaceTable(clause, "users", "members");
    const sql = renderSql(result);
    assert.match(sql, /FROM "members"/);
    assert.doesNotMatch(sql, /"users"/);
  });

  it("preserves aliases", () => {
    const clause = fromSql("SELECT u.email FROM users u WHERE u.id = 1");
    const result = replaceTable(clause, "users", "members");
    const sql = renderSql(result);
    assert.match(sql, /FROM "members" AS "u"/);
    assert.match(sql, /"u"\."email"/);
    assert.match(sql, /"u"\."id"/);
  });

  it("renames in JOIN target", () => {
    const clause = fromSql(
      "SELECT * FROM a JOIN users ON a.user_id = users.id"
    );
    const result = replaceTable(clause, "users", "members");
    const sql = renderSql(result);
    assert.match(sql, /JOIN "members"/);
    assert.match(sql, /"members"\."id"/);
  });

  it("rewrites qualified column refs not using alias", () => {
    const clause = fromSql("SELECT users.email FROM users");
    const result = replaceTable(clause, "users", "members");
    const sql = renderSql(result);
    assert.match(sql, /"members"\."email"/);
  });
});

describe("replaceColumn", () => {
  it("renames a bare column", () => {
    const clause = fromSql("SELECT id, email FROM users WHERE email = 'x'");
    const result = replaceColumn(clause, {
      from: "email",
      to: "contact_email",
    });
    const sql = renderSql(result);
    assert.match(sql, /"contact_email"/);
    assert.doesNotMatch(sql, /"email"/);
  });

  it("renames a qualified column with the actual table name", () => {
    const clause = fromSql("SELECT users.email FROM users WHERE users.id = 1");
    const result = replaceColumn(clause, {
      from: "users.email",
      to: "users.contact_email",
    });
    const sql = renderSql(result);
    assert.match(sql, /"users"\."contact_email"/);
    assert.doesNotMatch(sql, /"users"\."email"/);
    // id should be untouched
    assert.match(sql, /"users"\."id"/);
  });

  it("renames column through an alias (alias→table resolution)", () => {
    const clause = fromSql(
      "SELECT u.email FROM users u WHERE u.email = 'x' AND u.id = 1"
    );
    const result = replaceColumn(clause, {
      from: "users.email",
      to: "users.contact_email",
    });
    const sql = renderSql(result);
    assert.match(sql, /"u"\."contact_email"/);
    assert.doesNotMatch(sql, /"u"\."email"/);
    assert.match(sql, /"u"\."id"/);
  });

  it("does not touch a same-named column from another table", () => {
    const clause = fromSql(
      "SELECT u.email, o.email FROM users u JOIN orders o ON u.id = o.user_id"
    );
    const result = replaceColumn(clause, {
      from: "users.email",
      to: "users.contact_email",
    });
    const sql = renderSql(result);
    assert.match(sql, /"u"\."contact_email"/);
    assert.match(sql, /"o"\."email"/); // unchanged
  });
});

describe("replaceFunction", () => {
  it("swaps count for count-distinct", () => {
    const clause = fromSql("SELECT COUNT(user_id) FROM events");
    const result = replaceFunction(clause, "count", "count-distinct");
    assert.match(renderSql(result), /COUNT\(DISTINCT/i);
  });

  it("accepts a transform function", () => {
    const clause = fromSql("SELECT SUM(amount) FROM orders");
    const result = replaceFunction(clause, "sum", (args) => [
      "%coalesce",
      ["%sum", ...args] as never,
      { $: 0 },
    ]);
    const sql = renderSql(result);
    assert.match(sql, /COALESCE/i);
    assert.match(sql, /SUM/i);
  });
});

describe("round-trip invariance", () => {
  it("replaceWhere preserves untouched siblings byte-for-byte", () => {
    const clause = fromSql(
      "SELECT id, name FROM t WHERE a = 1 AND d >= '2024-01-01' AND b = 2"
    );
    const result = replaceWhere(clause, dateRange("d"), [">=", "d", { $: "2025-01-01" }]);
    const sql = renderSql(result);
    // "a = 1" and "b = 2" predicates should survive intact
    assert.match(sql, /"a" = 1/);
    assert.match(sql, /"b" = 2/);
  });

  it("replaceColumn round-trips cleanly (parse → rewrite → format → parse)", () => {
    const clause = fromSql("SELECT email FROM users WHERE email = 'x'");
    const result = replaceColumn(clause, { from: "email", to: "mail" });
    const sql = renderSql(result);
    const reparsed = fromSql(sql);
    // Second round-trip should be idempotent
    const sql2 = renderSql(reparsed);
    assert.strictEqual(sql, sql2);
  });
});
