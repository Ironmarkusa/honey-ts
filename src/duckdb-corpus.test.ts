/**
 * DuckDB corpus round-trip tests.
 *
 * The fixture is DuckDB's own sqllogictest suite (test/sql/**\/*.test in the
 * duckdb repo), deduplicated and normalised. Every statement goes
 *
 *     SQL --fromSql--> clause map --format(duckdb)--> SQL --> DuckDB's parser
 *
 * and we assert three things, in increasing order of importance:
 *
 *   1. how many statements the front end can parse at all (informational),
 *   2. that nothing which parses then CRASHES the emitter (hard invariant),
 *   3. how many round-tripped statements DuckDB still accepts (locked baseline).
 *
 * (2) is the invariant worth having. Every emitter bug this suite has found so
 * far — data-modifying CTEs, nested ARRAY literals, INSERT ... SELECT — showed
 * up as a TypeError from a statement that had parsed perfectly well.
 *
 * Regenerate the fixture with: npx tsx scripts/extract-duckdb-corpus.ts <path-to-duckdb-repo>
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fromSql } from "./parser.js";
import { format } from "./sql.js";
import { checkSyntax } from "./duckdb-oracle.js";
import type { SqlClause } from "./types.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "test", "fixtures", "duckdb-corpus.json"
);

interface Fixture {
  source: string;
  duckdbVersion: string;
  statements: Array<{ sql: string; kind: "select" | "dml" }>;
}

/**
 * Locked baselines. These are floors, not equalities: improving the parser or
 * emitter should make the numbers go up, and the test should only fail when
 * they go DOWN. Raise a floor once an improvement lands so it cannot silently
 * regress later.
 */
const BASELINE = {
  /** Statements the pgsql-ast-parser front end can parse. Actual: 16561/26403. */
  parsed: 16561,
  /** Round-tripped statements DuckDB's parser still accepts. Actual: 15826. */
  accepted: 15826,
};

/** Errors that mean "this front end does not support that syntax", not "bug". */
const EXPECTED_PARSE_FAILURE =
  /Syntax error|Unexpected end of input|invalid syntax|Ambiguous SQL syntax|Bad escaped character|Unexpected input|not supported|Expected /i;

interface Outcome {
  total: number;
  parsed: number;
  parseFailures: number;
  emitCrashes: Array<{ sql: string; error: string }>;
  accepted: number;
  rejected: Array<{ sql: string; emitted: string; error: string }>;
}

let outcome: Outcome;
let fixture: Fixture;

before(async () => {
  fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

  const result: Outcome = {
    total: fixture.statements.length,
    parsed: 0,
    parseFailures: 0,
    emitCrashes: [],
    accepted: 0,
    rejected: [],
  };

  const emitted: Array<{ sql: string; emitted: string }> = [];

  for (const { sql } of fixture.statements) {
    let clause: SqlClause;
    try {
      clause = fromSql(sql);
      result.parsed++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A parse failure on DuckDB-specific syntax is expected — the front end
      // is a PostgreSQL parser. A failure of any OTHER shape is a real bug and
      // is counted as a crash so the assertions below catch it.
      if (EXPECTED_PARSE_FAILURE.test(message)) {
        result.parseFailures++;
      } else {
        result.emitCrashes.push({ sql, error: message.split("\n")[0]! });
      }
      continue;
    }

    try {
      emitted.push({ sql, emitted: format(clause, { dialect: "duckdb", inline: true })[0] });
    } catch (e) {
      result.emitCrashes.push({
        sql,
        error: e instanceof Error ? e.message.split("\n")[0]! : String(e),
      });
    }
  }

  for (const item of emitted) {
    const check = await checkSyntax(item.emitted);
    if (check.valid) result.accepted++;
    else result.rejected.push({ ...item, error: check.error ?? "unknown" });
  }

  outcome = result;
});

describe("DuckDB corpus round-trip", () => {
  test("fixture is the expected shape", () => {
    assert.ok(fixture.statements.length > 20000, `${fixture.statements.length} statements`);
    assert.match(fixture.source, /duckdb/);
  });

  test("no statement crashes the emitter", () => {
    // The hard invariant: anything that parses must emit. Failures here are
    // honey-ts bugs, not unsupported syntax.
    const sample = outcome.emitCrashes
      .slice(0, 5)
      .map((c) => `\n  ${c.error}\n    ${c.sql.slice(0, 110)}`)
      .join("");
    assert.equal(
      outcome.emitCrashes.length,
      0,
      `${outcome.emitCrashes.length} statements crashed the emitter:${sample}`
    );
  });

  test(`at least ${BASELINE.parsed} statements parse`, () => {
    assert.ok(
      outcome.parsed >= BASELINE.parsed,
      `parsed ${outcome.parsed}, baseline ${BASELINE.parsed} ` +
        `(${((100 * outcome.parsed) / outcome.total).toFixed(1)}% of ${outcome.total})`
    );
  });

  test(`at least ${BASELINE.accepted} round-trips are accepted by DuckDB`, () => {
    assert.ok(
      outcome.accepted >= BASELINE.accepted,
      `accepted ${outcome.accepted}, baseline ${BASELINE.accepted} ` +
        `(${((100 * outcome.accepted) / outcome.parsed).toFixed(2)}% of parsed)`
    );
  });

  test("acceptance rate of parsed statements stays above 95%", () => {
    const rate = (100 * outcome.accepted) / outcome.parsed;
    assert.ok(rate >= 95, `acceptance rate ${rate.toFixed(2)}%`);
  });

  test("corpus summary", () => {
    // Not an assertion so much as a record of where the front end stands.
    const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;
    console.log(
      [
        "",
        `  corpus statements : ${outcome.total}`,
        `  parsed            : ${outcome.parsed} (${pct(outcome.parsed, outcome.total)})`,
        `  parse failures    : ${outcome.parseFailures} (DuckDB-only syntax)`,
        `  emitter crashes   : ${outcome.emitCrashes.length}`,
        `  DuckDB accepted   : ${outcome.accepted} (${pct(outcome.accepted, outcome.parsed)} of parsed)`,
        `  DuckDB rejected   : ${outcome.rejected.length}`,
      ].join("\n")
    );
    assert.ok(true);
  });
});

describe("DuckDB corpus: rejection analysis", () => {
  test("rejections are dominated by known upstream mis-parses", () => {
    // A rejection means pgsql-ast-parser accepted DuckDB-specific syntax and
    // produced a WRONG clause map — a silent mis-parse, which is more dangerous
    // than a parse failure. We track the categories so a new one is visible.
    const byError = new Map<string, number>();
    for (const r of outcome.rejected) {
      const key = r.error.replace(/[0-9]+/g, "N").slice(0, 50);
      byError.set(key, (byError.get(key) ?? 0) + 1);
    }
    const top = [...byError].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log("\n  top rejection reasons:");
    for (const [err, n] of top) console.log(`    ${String(n).padStart(4)}  ${err}`);

    // No single failure mode should be allowed to blow up unnoticed.
    const worst = top[0]?.[1] ?? 0;
    assert.ok(
      worst < outcome.parsed * 0.05,
      `one rejection reason accounts for ${worst} statements`
    );
  });
});
