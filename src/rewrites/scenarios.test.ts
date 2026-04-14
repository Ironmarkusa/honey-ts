/**
 * Integration tests against realistic shapes the notebook/report agent will emit.
 *
 * Each test documents what the helper does (and does not do) against a shape
 * the DMP will see in production. Cases that we knowingly don't handle are
 * marked so — the DMP side treats these as `parse_status: 'fallback'` or
 * silently no-ops for date-swap.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { fromSql, toSql } from "../index.js";
import { rewriteDateRange, describeDatePredicates } from "./date-range.js";
import { replaceColumn, replaceTable } from "./rewrite.js";
import { addWhere } from "./modify.js";
import { apply } from "./apply.js";

function render(clause: unknown): string {
  const [sql] = toSql(clause as never, { inline: true }) as [string, ...unknown[]];
  return sql;
}

// ============================================================================
// Scenario 1 — typical ROI report cell
// ============================================================================

describe("scenario: ROI report cell", () => {
  const sql = `SELECT channel, SUM(spend) AS spend, SUM(revenue) AS revenue
               FROM fct_roi_monthly
               WHERE brand_id = 'acme' AND date_day >= '2024-01-01' AND date_day < '2024-02-01'
               GROUP BY channel
               ORDER BY spend DESC`;

  it("detects a single date-range predicate", () => {
    const preds = describeDatePredicates(fromSql(sql));
    assert.strictEqual(preds.length, 1);
    assert.strictEqual(preds[0]!.column, "date_day");
    assert.strictEqual(preds[0]!.source, "range");
  });

  it("swaps the date range and preserves brand_id filter", () => {
    const out = rewriteDateRange(fromSql(sql), {
      column: "date_day",
      from: "2025-03-01",
      to: "2025-04-01",
    });
    const s = render(out);
    assert.match(s, /"brand_id" = 'acme'/);
    assert.match(s, /"date_day" >= '2025-03-01'/);
    assert.match(s, /"date_day" < '2025-04-01'/);
    assert.doesNotMatch(s, /2024/);
  });

  it("supports tenant injection + date swap in a single apply pipeline", () => {
    const out = apply(
      fromSql(sql),
      (c) => addWhere(c, ["=", "tenant_id", { $: "tenant_abc" }]),
      (c) =>
        rewriteDateRange(c, {
          column: "date_day",
          from: "2025-03-01",
          to: "2025-04-01",
        })
    );
    const s = render(out);
    assert.match(s, /"tenant_id" = 'tenant_abc'/);
    assert.match(s, /2025-03-01/);
  });
});

// ============================================================================
// Scenario 2 — joined table, aliased qualified date column
// ============================================================================

describe("scenario: joined table with aliased date column", () => {
  const sql = `SELECT o.id, u.email FROM orders o JOIN users u ON u.id = o.user_id
               WHERE o.created_at >= '2024-01-01' AND o.created_at < '2024-02-01'`;

  it("rewrites o.created_at through alias", () => {
    const out = rewriteDateRange(fromSql(sql), {
      column: "o.created_at",
      from: "2025-06-01",
      to: "2025-07-01",
    });
    const s = render(out);
    assert.match(s, /"o"\."created_at" >= '2025-06-01'/);
    assert.match(s, /"o"\."created_at" < '2025-07-01'/);
  });
});

// ============================================================================
// Scenario 3 — CTE with date predicate (healing target)
// ============================================================================

describe("scenario: CTE date predicate + column healing", () => {
  const sql = `WITH monthly AS (
    SELECT channel, SUM(spend_usd) AS spend FROM fct_spend
    WHERE date_day >= '2024-01-01'
    GROUP BY channel
  )
  SELECT channel, spend FROM monthly WHERE spend > 100`;

  it("describeDatePredicates returns correct CTE scope", () => {
    const preds = describeDatePredicates(fromSql(sql));
    assert.strictEqual(preds.length, 1);
    assert.match(preds[0]!.scope, /with:monthly/);
  });

  it("rewriteDateRange works inside the CTE", () => {
    const out = rewriteDateRange(fromSql(sql), {
      column: "date_day",
      from: "2025-01-01",
      to: "2025-02-01",
    });
    const s = render(out);
    assert.match(s, /"date_day" >= '2025-01-01'/);
    assert.match(s, /"date_day" < '2025-02-01'/);
  });

  it("replaceColumn heals through CTE and aggregate functions", () => {
    const out = replaceColumn(fromSql(sql), {
      from: "spend_usd",
      to: "spend_amount",
    });
    const s = render(out);
    assert.match(s, /SUM\("spend_amount"\)/i);
    assert.doesNotMatch(s, /spend_usd/);
    // The output alias "spend" must be preserved (it matches end of the col name)
    assert.match(s, /AS "spend"/);
  });
});

// ============================================================================
// Scenario 4 — BETWEEN → half-open rewrite
// ============================================================================

describe("scenario: BETWEEN DATE literal → half-open", () => {
  const sql = `SELECT * FROM t WHERE date_day BETWEEN DATE '2024-01-01' AND DATE '2024-12-31'`;

  it("detects BETWEEN source", () => {
    const preds = describeDatePredicates(fromSql(sql));
    assert.strictEqual(preds.length, 1);
    assert.strictEqual(preds[0]!.source, "between");
  });

  it("rewrites to half-open by default", () => {
    const out = rewriteDateRange(fromSql(sql), {
      column: "date_day",
      from: "2025-01-01",
      to: "2025-04-01",
    });
    const s = render(out);
    assert.doesNotMatch(s, /BETWEEN/i);
    assert.match(s, /"date_day" >= '2025-01-01'/);
    assert.match(s, /"date_day" < '2025-04-01'/);
  });
});

// ============================================================================
// Scenario 5 — table rename (healing)
// ============================================================================

describe("scenario: table rename for healing", () => {
  const sql = `SELECT u.id, o.total FROM users u JOIN orders o ON u.id = o.user_id WHERE u.status = 'active'`;

  it("preserves aliases + rewrites qualified refs", () => {
    const out = replaceTable(fromSql(sql), "users", "members");
    const s = render(out);
    assert.match(s, /FROM "members" AS "u"/);
    assert.match(s, /"u"\."id"/); // alias preserved
    assert.match(s, /"u"\."status"/); // alias preserved
    assert.doesNotMatch(s, /"users"/);
  });
});

// ============================================================================
// Documented non-coverage (explicit no-ops)
// ============================================================================

describe("scenario: function-wrapped date predicate — silently no-op", () => {
  const sql = `SELECT date_trunc('month', created_at) AS m, COUNT(*) FROM events
               WHERE date_trunc('month', created_at) >= '2024-01-01'
               GROUP BY 1`;

  it("describeDatePredicates returns empty (function, not bare column)", () => {
    const preds = describeDatePredicates(fromSql(sql));
    assert.strictEqual(preds.length, 0);
  });

  it("rewriteDateRange with explicit column throws — caller should guard", () => {
    // With column specified but no matching bare predicate, it throws inside
    // inferSingleColumn ... no, wait: explicit column skips inference. It
    // should find no hits and just return the clause unchanged.
    const out = rewriteDateRange(fromSql(sql), {
      column: "created_at",
      from: "2025-01-01",
      to: "2025-02-01",
    });
    // Unchanged — no matching predicate at the bare-column level
    assert.match(render(out), /2024-01-01/);
  });
});

describe("scenario: OR'd date windows — silently no-op (documented limitation)", () => {
  const sql = `SELECT * FROM t
               WHERE (d >= '2024-01-01' AND d < '2024-02-01')
                  OR (d >= '2024-06-01' AND d < '2024-07-01')`;

  it("describeDatePredicates does not descend into OR branches (MVP limitation)", () => {
    const preds = describeDatePredicates(fromSql(sql));
    assert.strictEqual(preds.length, 0);
  });

  it("rewriteDateRange leaves OR-nested predicates alone", () => {
    const out = rewriteDateRange(fromSql(sql), {
      column: "d",
      from: "2025-01-01",
      to: "2025-02-01",
    });
    // Original predicates intact
    const s = render(out);
    assert.match(s, /2024-01-01/);
    assert.match(s, /2024-06-01/);
  });
});

describe("scenario: no WHERE — rewriteDateRange throws on column inference", () => {
  const sql = `SELECT channel, SUM(spend) FROM fct_roi_monthly GROUP BY channel`;

  it("throws when no column given and no date predicates exist", () => {
    assert.throws(
      () =>
        rewriteDateRange(fromSql(sql), {
          from: "2025-01-01",
          to: "2025-02-01",
        }),
      /no date-range predicates/
    );
  });

  it("explicit column on a WHERE-less clause is a no-op", () => {
    const out = rewriteDateRange(fromSql(sql), {
      column: "date_day",
      from: "2025-01-01",
      to: "2025-02-01",
    });
    const s = render(out);
    assert.doesNotMatch(s, /WHERE/);
  });
});

describe("scenario: DuckDB-only syntax — fromSql throws (caller handles fallback)", () => {
  it("EXCLUDE clause is unparseable — caller must try/catch", () => {
    assert.throws(
      () => fromSql(`SELECT * EXCLUDE (secret) FROM users`),
      /Syntax error|Unexpected/
    );
  });

  it("QUALIFY is unparseable", () => {
    assert.throws(
      () =>
        fromSql(
          `SELECT channel FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY channel ORDER BY spend DESC) = 1`
        ),
      /Syntax error|Unexpected/
    );
  });
});
