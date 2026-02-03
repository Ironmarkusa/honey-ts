/**
 * Generative/property-based testing for SQL round-trips.
 *
 * Strategy:
 * 1. Generate valid clause maps (structurally valid by construction)
 * 2. Convert to SQL with toSql()
 * 3. Validate SQL is parseable
 * 4. Parse back with fromSql()
 * 5. Convert back to SQL
 * 6. Validate second SQL is parseable
 * 7. Assert both SQL strings match (normalized)
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { parse } from "pgsql-ast-parser";
import { format, fromSql, normalizeSql } from "./index.js";
import type { SqlClause, SqlExpr } from "./types.js";

// ============================================================================
// Validation
// ============================================================================

function isValidSql(sql: string): boolean {
  try {
    parse(sql);
    return true;
  } catch {
    return false;
  }
}

function assertValidSql(sql: string, context: string): void {
  try {
    parse(sql);
  } catch (err) {
    throw new Error(`Invalid SQL (${context}): ${sql}\n${(err as Error).message}`);
  }
}

// ============================================================================
// Generators
// ============================================================================

// Simple identifier names (valid SQL identifiers)
const identName = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);

// Column identifier with : prefix
const columnIdent = identName.map((name) => `:${name}`);

// Table identifier with : prefix
const tableIdent = identName.map((name) => `:${name}`);

// Qualified column (table.column)
const qualifiedColumn = fc.tuple(identName, identName).map(([t, c]) => `${t}.${c}`);

// Any column reference
const columnRef = fc.oneof(columnIdent, qualifiedColumn);

// Literal values
const literal = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  // Avoid problematic strings - no quotes, backslashes, or special chars
  fc.stringMatching(/^[a-zA-Z0-9 _-]{1,20}$/),
  fc.boolean(),
  fc.constant(null)
);

// Comparison operators
const comparisonOp = fc.constantFrom("=", "<>", "<", ">", "<=", ">=");

// Simple comparison expression: [op, column, literal]
// Use IS/IS NOT for null comparisons
const comparisonExpr: fc.Arbitrary<SqlExpr> = fc.tuple(
  comparisonOp,
  columnIdent,
  literal
).map(([op, col, val]) => {
  if (val === null) {
    return op === "<>" ? ["is-not", col, null] : ["is", col, null];
  }
  return [op, col, val];
});

// Boolean connective
const booleanOp = fc.constantFrom("and", "or");

// Simple WHERE expression (no deep nesting to start)
const simpleWhereExpr: fc.Arbitrary<SqlExpr> = fc.oneof(
  comparisonExpr,
  // AND/OR of two comparisons
  fc.tuple(booleanOp, comparisonExpr, comparisonExpr).map(([op, left, right]) => [op, left, right])
);

// Aggregate functions
const aggregateFn = fc.constantFrom("%count", "%sum", "%avg", "%max", "%min");

// Select item: column, qualified column, or aggregate
const selectItem: fc.Arbitrary<SqlExpr> = fc.oneof(
  columnIdent,
  qualifiedColumn,
  fc.constant("*"),
  // Aggregate on column
  fc.tuple(aggregateFn, columnIdent).map(([fn, col]) => [fn, col]),
  // COUNT(*)
  fc.constant(["%count", "*"] as SqlExpr)
);

// Select list (1-5 items)
const selectList = fc.array(selectItem, { minLength: 1, maxLength: 5 });

// Order direction
const orderDir = fc.constantFrom("asc", "desc");

// Order by item
const orderByItem: fc.Arbitrary<SqlExpr> = fc.tuple(columnIdent, orderDir).map(([col, dir]) => [col, dir]);

// Order by list
const orderByList = fc.array(orderByItem, { minLength: 1, maxLength: 3 });

// ============================================================================
// Clause Map Generators
// ============================================================================

// Simple SELECT: select + from
const simpleSelect: fc.Arbitrary<SqlClause> = fc.record({
  select: selectList,
  from: tableIdent,
});

// SELECT with WHERE
const selectWithWhere: fc.Arbitrary<SqlClause> = fc.record({
  select: selectList,
  from: tableIdent,
  where: simpleWhereExpr,
});

// SELECT with ORDER BY
const selectWithOrderBy: fc.Arbitrary<SqlClause> = fc.record({
  select: selectList,
  from: tableIdent,
  "order-by": orderByList,
});

// SELECT with LIMIT/OFFSET
const selectWithLimit: fc.Arbitrary<SqlClause> = fc.record({
  select: selectList,
  from: tableIdent,
  limit: fc.integer({ min: 1, max: 100 }),
  offset: fc.integer({ min: 0, max: 100 }),
});

// SELECT with GROUP BY
const selectWithGroupBy: fc.Arbitrary<SqlClause> = fc.tuple(
  fc.array(columnIdent, { minLength: 1, maxLength: 3 }),
  tableIdent
).map(([groupCols, table]) => ({
  select: [...groupCols, ["%count", "*"] as SqlExpr],
  from: table,
  "group-by": groupCols,
}));

// Full SELECT with multiple clauses
const fullSelect: fc.Arbitrary<SqlClause> = fc.record({
  select: selectList,
  from: tableIdent,
  where: fc.option(simpleWhereExpr, { nil: undefined }),
  "order-by": fc.option(orderByList, { nil: undefined }),
  limit: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
}).map((clause) => {
  // Remove undefined keys
  const result: SqlClause = { select: clause.select, from: clause.from };
  if (clause.where) result.where = clause.where;
  if (clause["order-by"]) result["order-by"] = clause["order-by"];
  if (clause.limit) result.limit = clause.limit;
  return result;
});

// SELECT with JOIN
const selectWithJoin: fc.Arbitrary<SqlClause> = fc.tuple(
  tableIdent,
  tableIdent,
  identName,
  identName
).chain(([table1, table2, alias1, alias2]) => {
  // Ensure different aliases
  const a1 = alias1;
  const a2 = alias1 === alias2 ? alias2 + "2" : alias2;
  return fc.constant({
    select: [`${a1}.id`, `${a2}.id`],
    from: [[table1, `:${a1}`]],
    join: [
      [[table2, `:${a2}`], ["=", `${a1}.id`, `${a2}.fk`]]
    ],
  } as SqlClause);
});

// DELETE statement
const deleteStmt: fc.Arbitrary<SqlClause> = fc.record({
  "delete-from": tableIdent,
  where: simpleWhereExpr,
});

// UPDATE statement
const updateStmt: fc.Arbitrary<SqlClause> = fc.tuple(
  tableIdent,
  fc.array(fc.tuple(identName, literal), { minLength: 1, maxLength: 3 }),
  simpleWhereExpr
).map(([table, setPairs, where]) => ({
  update: table,
  set: Object.fromEntries(setPairs),
  where,
}));

// INSERT statement
const insertStmt: fc.Arbitrary<SqlClause> = fc.tuple(
  tableIdent,
  fc.array(identName, { minLength: 1, maxLength: 5 }),
  fc.array(literal, { minLength: 1, maxLength: 5 })
).chain(([table, cols, vals]) => {
  // Ensure values array matches columns length
  const values = vals.slice(0, cols.length);
  while (values.length < cols.length) {
    values.push(null);
  }
  return fc.constant({
    "insert-into": table,
    columns: cols.map((c) => `:${c}`),
    values: [values],
  } as SqlClause);
});

// ============================================================================
// Round-trip Test
// ============================================================================

function roundTripTest(clause: SqlClause): void {
  // Step 1: Convert to SQL
  const [sql1] = format(clause, { quoted: true, inline: true });

  // Step 2: Validate SQL1 is parseable
  assertValidSql(sql1, "after first toSql");

  // Step 3: Parse back to clause
  const clause2 = fromSql(sql1);

  // Step 4: Convert back to SQL
  const [sql2] = format(clause2, { quoted: true, inline: true });

  // Step 5: Validate SQL2 is parseable
  assertValidSql(sql2, "after round-trip toSql");

  // Step 6: Compare normalized SQL
  const normalized1 = normalizeSql(sql1);
  const normalized2 = normalizeSql(sql2);

  if (normalized1 !== normalized2) {
    throw new Error(
      `Round-trip mismatch:\n` +
      `  Input clause: ${JSON.stringify(clause)}\n` +
      `  SQL1: ${sql1}\n` +
      `  SQL2: ${sql2}\n` +
      `  Normalized1: ${normalized1}\n` +
      `  Normalized2: ${normalized2}`
    );
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("generative round-trip tests", () => {
  it("simple SELECT", () => {
    fc.assert(
      fc.property(simpleSelect, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("SELECT with WHERE", () => {
    fc.assert(
      fc.property(selectWithWhere, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("SELECT with ORDER BY", () => {
    fc.assert(
      fc.property(selectWithOrderBy, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("SELECT with LIMIT/OFFSET", () => {
    fc.assert(
      fc.property(selectWithLimit, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("SELECT with GROUP BY", () => {
    fc.assert(
      fc.property(selectWithGroupBy, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("full SELECT with multiple clauses", () => {
    fc.assert(
      fc.property(fullSelect, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 200 }
    );
  });

  it("SELECT with JOIN", () => {
    fc.assert(
      fc.property(selectWithJoin, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("DELETE statements", () => {
    fc.assert(
      fc.property(deleteStmt, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("UPDATE statements", () => {
    fc.assert(
      fc.property(updateStmt, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("INSERT statements", () => {
    fc.assert(
      fc.property(insertStmt, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// Stress test with combined generators
// ============================================================================

describe("stress test", () => {
  const anyStatement = fc.oneof(
    simpleSelect,
    selectWithWhere,
    selectWithOrderBy,
    selectWithLimit,
    selectWithGroupBy,
    selectWithJoin,
    fullSelect,
    deleteStmt,
    updateStmt,
    insertStmt
  );

  it("1000 random statements", () => {
    fc.assert(
      fc.property(anyStatement, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 1000 }
    );
  });
});
