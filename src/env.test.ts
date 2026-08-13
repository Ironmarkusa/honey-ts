/**
 * Tests for createEnv: delegation correctness, memoization, dialect-filtered
 * suggestions, and document portability.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createEnv, duckdb, $ } from "./index.js";
import { DUCKDB_FUNCTIONS_BY_NAME } from "./duckdb-ops.generated.js";
import type { DatabaseSchema, SqlClause } from "./index.js";

const SCHEMA: DatabaseSchema = {
  tables: [
    {
      name: "orders", schema: "main",
      columns: [
        { name: "id", type: "INTEGER", nullable: false, isPrimaryKey: true },
        { name: "total", type: "DECIMAL(10,2)", nullable: false },
        { name: "status", type: "VARCHAR", nullable: false },
      ],
    },
  ],
};

describe("createEnv basics", () => {
  const env = createEnv({ dialect: "duckdb", schema: SCHEMA, catalog: DUCKDB_FUNCTIONS_BY_NAME });

  test("parse uses the env dialect", () => {
    const clause = env.parse("SELECT status FROM orders QUALIFY row_number() OVER () = 1");
    assert.ok(clause.qualify, "duckdb syntax parsed");
  });

  test("emit uses the env dialect and defaults", () => {
    const clause = env.parse("SELECT status FROM orders WHERE total > 5");
    const [sql, ...params] = env.emit(clause);
    assert.equal(sql, "SELECT status FROM orders WHERE total > 5");
    assert.deepEqual(params, []);
  });

  test("emit overrides merge over env defaults", () => {
    const pretty = createEnv({ dialect: "postgres", format: { quoted: true } });
    const [sql] = pretty.emit({ select: ["id"], from: "orders" } as SqlClause);
    assert.equal(sql, `SELECT "id" FROM "orders"`);
    const [bare] = pretty.emit({ select: ["id"], from: "orders" } as SqlClause, { quoted: false });
    assert.equal(bare, "SELECT id FROM orders");
  });

  test("config is frozen", () => {
    assert.throws(() => {
      (env.config as { dialect?: string }).dialect = "postgres";
    }, TypeError);
  });

  test("unknown dialect fails at construction, not first use", () => {
    assert.throws(() => createEnv({ dialect: "mysql" as never }), /unknown dialect/);
  });
});

describe("memoization", () => {
  const env = createEnv({ dialect: "duckdb", schema: SCHEMA, catalog: DUCKDB_FUNCTIONS_BY_NAME });
  const clause = env.parse("SELECT status, sum(total) FROM orders GROUP BY status");

  test("validate returns the identical result object for the same document", () => {
    const a = env.validate(clause);
    const b = env.validate(clause);
    assert.equal(a, b, "same reference — memoized");
    assert.ok(a.valid);
  });

  test("a new document misses the memo", () => {
    const edited = { ...clause };
    assert.notEqual(env.validate(edited), env.validate(clause));
  });

  test("inferrer is memoized per document", () => {
    assert.equal(env.inferrer(clause), env.inferrer(clause));
  });

  test("typeOf sugar works through the memoized inferrer", () => {
    assert.equal(env.typeOf(clause, ["%sum", "total"])?.type, "numeric(10,2)");
    assert.equal(env.typeOf(clause, "status")?.type, "text");
  });
});

describe("dialect-aware suggestions", () => {
  const duck = createEnv({ dialect: "duckdb", schema: SCHEMA, catalog: DUCKDB_FUNCTIONS_BY_NAME });
  const pg = createEnv({ dialect: "postgres", schema: SCHEMA });

  test("lowered operators stay available on duckdb", () => {
    const textOps = duck.operatorsFor("text").map((o) => o.op);
    assert.ok(textOps.includes("~*"), "~* stays — it lowers on duckdb");
    const jsonOps = duck.operatorsFor("jsonb").map((o) => o.op);
    for (const op of ["->", "->>", "@>", "?"]) {
      assert.ok(jsonOps.includes(op), `${op} stays — it lowers on duckdb`);
    }
  });

  test("the filter removes dialect-unsupported operators when present", () => {
    // The builder's current table happens to contain no duckdb-unsupported
    // operators — the filter is the safety net for when one is added. Verify
    // it against the dialect's own deny list.
    const denied = [...(duck.config.dialect === "duckdb" ? ["@@", "<->", "?|", "?&", "#-"] : [])];
    for (const type of ["text", "jsonb", "tsvector"]) {
      const offered = duck.operatorsFor(type).map((o) => o.op);
      for (const op of denied) {
        assert.ok(!offered.includes(op), `${op} must never be offered on duckdb`);
      }
    }
  });

  test("every suggested operator actually emits on the env dialect", () => {
    for (const envUnderTest of [duck, pg]) {
      for (const type of ["text", "integer", "jsonb", "tsvector", "timestamp"]) {
        for (const op of envUnderTest.operatorsFor(type)) {
          const clause = {
            select: [{ v: 1 }],
            from: "orders",
            where:
              op.valueType === "none"
                ? ([op.op, "status"] as never)
                : ([op.op, "status", { v: "x" }] as never),
          } as SqlClause;
          assert.doesNotThrow(
            () => envUnderTest.emit(clause),
            `${envUnderTest.config.dialect} suggested ${op.op} but emit rejected it`
          );
        }
      }
    }
  });

  test("functionsFor uses the catalog when present", () => {
    const fns = duck.functionsFor("text").map((f) => f.name);
    assert.ok(fns.includes("%lower"), "catalog text functions include lower");
    assert.ok(fns.length > 50, `catalog-driven list is rich (${fns.length})`);
  });

  test("functionsFor falls back to the builder list without a catalog", () => {
    const fns = pg.functionsFor("text");
    assert.ok(fns.length > 0);
  });
});

describe("emittable — document portability", () => {
  const env = createEnv({ dialect: "duckdb", schema: SCHEMA, catalog: DUCKDB_FUNCTIONS_BY_NAME });

  test("a plain query runs anywhere", () => {
    const clause = env.parse("SELECT status FROM orders WHERE total > 5");
    assert.deepEqual(env.emittable(clause), ["postgres", "duckdb"]);
  });

  test("duckdb constructs pin the document to duckdb", () => {
    const clause = { select: [duckdb.list($(1), $(2))], from: "orders" } as SqlClause;
    assert.deepEqual(env.emittable(clause), ["duckdb"]);
  });

  test("pg-only operators pin the document to postgres", () => {
    const clause = { select: ["id"], from: "orders", where: ["@@", "doc", $("x")] } as SqlClause;
    assert.deepEqual(env.emittable(clause), ["postgres"]);
  });

  test("memoized per document", () => {
    const clause = env.parse("SELECT status FROM orders");
    assert.equal(env.emittable(clause), env.emittable(clause));
  });
});

describe("polish: picker quality and validation noise", () => {
  const env = createEnv({ dialect: "duckdb", schema: SCHEMA, catalog: DUCKDB_FUNCTIONS_BY_NAME });

  test("functionsFor never returns operator spellings", () => {
    for (const type of ["timestamp", "text", "integer"]) {
      const names = env.functionsFor(type).map((f) => f.name.replace(/^%/, ""));
      for (const n of names) {
        assert.match(n, /^[a-z_][a-z0-9_]*$/, `operator-ish entry leaked: ${n}`);
      }
    }
  });

  test("type-specific functions rank above generic ANY-typed ones", () => {
    const names = env.functionsFor("timestamp").map((f) => f.name);
    const specific = names.indexOf("%age");        // age(TIMESTAMP)
    const generic = names.indexOf("%alias");       // alias(ANY)
    assert.ok(specific !== -1, "timestamp-specific fn present");
    assert.ok(generic === -1 || specific < generic, "specific before generic");
  });

  test("unknown column does not cascade into ungrouped-column", () => {
    const result = env.validate(env.parse("SELECT plann, sum(total) FROM orders"));
    const codes = result.problems.map((p) => p.code);
    assert.deepEqual(codes, ["unknown-column"], JSON.stringify(result.problems));
  });

  test("did-you-mean reaches across the schema when scope has no match", () => {
    // "plann" is close to users.plan, but the query only scopes orders.
    const withUsers = createEnv({
      dialect: "duckdb",
      schema: {
        tables: [
          ...SCHEMA.tables,
          { name: "users", schema: "main", columns: [{ name: "plan", type: "TEXT", nullable: false }] },
        ],
      },
      catalog: DUCKDB_FUNCTIONS_BY_NAME,
    });
    const result = withUsers.validate(withUsers.parse("SELECT plann FROM orders"));
    const p = result.problems.find((x) => x.code === "unknown-column")!;
    assert.match(p.hint ?? "", /plan.*users/, p.hint ?? "(no hint)");
  });
});
