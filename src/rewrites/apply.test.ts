import { describe, it } from "node:test";
import assert from "node:assert";
import { fromSql, toSql } from "../index.js";
import { apply, applyWith } from "./apply.js";
import { addWhere, setLimit } from "./modify.js";
import { rewriteDateRange } from "./date-range.js";
import { replaceTable } from "./rewrite.js";

function renderSql(clause: unknown): string {
  const [sql] = toSql(clause as never, { inline: true }) as [string, ...unknown[]];
  return sql;
}

describe("apply", () => {
  it("passes clause through zero transforms unchanged", () => {
    const clause = fromSql("SELECT * FROM t");
    const result = apply(clause);
    assert.deepStrictEqual(result, clause);
  });

  it("composes transforms left-to-right", () => {
    const clause = fromSql(
      "SELECT * FROM t WHERE d >= '2024-01-01' AND d < '2024-02-01'"
    );
    const result = apply(
      clause,
      (c) => rewriteDateRange(c, { column: "d", from: "2025-01-01", to: "2025-02-01" }),
      (c) => addWhere(c, ["=", "tenant_id", { $: "acme" }]),
      (c) => setLimit(c, 100)
    );
    const sql = renderSql(result);
    assert.match(sql, /2025-01-01/);
    assert.match(sql, /"tenant_id" = 'acme'/);
    assert.match(sql, /LIMIT 100/);
  });

  it("order matters: last transform wins on conflicts", () => {
    const clause = fromSql("SELECT * FROM a");
    const r1 = apply(
      clause,
      (c) => replaceTable(c, "a", "b"),
      (c) => replaceTable(c, "b", "c")
    );
    assert.match(renderSql(r1), /FROM "c"/);
  });
});

describe("applyWith", () => {
  it("runs validator after each transform", () => {
    const clause = fromSql("SELECT * FROM t");
    const seen: number[] = [];
    applyWith(
      { validate: (_r, i) => { seen.push(i); } },
      clause,
      (c) => setLimit(c, 10),
      (c) => setLimit(c, 20)
    );
    assert.deepStrictEqual(seen, [0, 1]);
  });

  it("validator can replace step result by returning a clause", () => {
    const clause = fromSql("SELECT * FROM t");
    const result = applyWith(
      {
        validate: (r) => {
          // Force limit to 999 no matter what
          return setLimit(r, 999);
        },
      },
      clause,
      (c) => setLimit(c, 10),
      (c) => setLimit(c, 20)
    );
    assert.match(renderSql(result), /LIMIT 999/);
  });

  it("validator throwing aborts the pipeline", () => {
    const clause = fromSql("SELECT * FROM t");
    assert.throws(
      () =>
        applyWith(
          {
            validate: (_r, i) => {
              if (i === 0) throw new Error("nope");
            },
          },
          clause,
          (c) => setLimit(c, 10),
          (c) => setLimit(c, 20)
        ),
      /nope/
    );
  });
});
