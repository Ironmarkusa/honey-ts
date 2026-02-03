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
 *
 * New syntax:
 * - Plain strings are identifiers: "id", "users"
 * - Values use {$: value}: {$: "active"}, {$: 42}
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

// Column identifier (plain string)
const columnIdent = identName;

// Table identifier (plain string)
const tableIdent = identName;

// Qualified column (table.column)
const qualifiedColumn = fc.tuple(identName, identName).map(([t, c]) => `${t}.${c}`);

// Typed value wrapper
const typedValue = <T>(arb: fc.Arbitrary<T>) => arb.map((v) => ({ $: v }));

// Literal values wrapped in {$: value}
const literal = fc.oneof(
  typedValue(fc.integer({ min: -1000, max: 1000 })),
  typedValue(fc.stringMatching(/^[a-zA-Z0-9 _-]{1,20}$/)),
  typedValue(fc.boolean()),
  fc.constant(null)
);

// Comparison operators
const comparisonOp = fc.constantFrom("=", "<>", "<", ">", "<=", ">=");

// Simple comparison expression: [op, column, literal]
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
  fc.tuple(booleanOp, comparisonExpr, comparisonExpr).map(([op, left, right]) => [op, left, right])
);

// Aggregate functions
const aggregateFn = fc.constantFrom("%count", "%sum", "%avg", "%max", "%min");

// Select item: column, qualified column, or aggregate
const selectItem: fc.Arbitrary<SqlExpr> = fc.oneof(
  columnIdent,
  qualifiedColumn,
  fc.constant("*"),
  fc.tuple(aggregateFn, columnIdent).map(([fn, col]) => [fn, col]),
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

// CASE expression
const caseExpr: fc.Arbitrary<SqlExpr> = fc.tuple(
  comparisonExpr,
  literal,
  literal
).map(([cond, thenVal, elseVal]) => ["case", cond, thenVal, "else", elseVal]);

// BETWEEN expression
const betweenExpr: fc.Arbitrary<SqlExpr> = fc.tuple(
  columnIdent,
  typedValue(fc.integer({ min: 0, max: 100 })),
  typedValue(fc.integer({ min: 101, max: 200 }))
).map(([col, low, high]) => ["between", col, low, high]);

// IN expression
const inExpr: fc.Arbitrary<SqlExpr> = fc.tuple(
  columnIdent,
  fc.array(typedValue(fc.integer({ min: 1, max: 100 })), { minLength: 1, maxLength: 5 })
).map(([col, vals]) => ["in", col, vals]);

// LIKE expression
const likeExpr: fc.Arbitrary<SqlExpr> = fc.tuple(
  columnIdent,
  fc.stringMatching(/^[a-z]{1,5}%$/)
).map(([col, pattern]) => ["like", col, { $: pattern }]);

// COALESCE expression
const coalesceExpr: fc.Arbitrary<SqlExpr> = fc.tuple(
  columnIdent,
  literal
).map(([col, fallback]) => ["%coalesce", col, fallback]);

// Aliased select item: [[expr], alias]
const aliasedSelectItem: fc.Arbitrary<SqlExpr> = fc.tuple(
  fc.tuple(aggregateFn, columnIdent).map(([fn, col]) => [fn, col]),
  identName
).map(([expr, alias]) => [expr, alias]);

// Extended select item with aliases
const extendedSelectItem: fc.Arbitrary<SqlExpr> = fc.oneof(
  selectItem,
  aliasedSelectItem,
  caseExpr,
  coalesceExpr
);

// Extended select list
const extendedSelectList = fc.array(extendedSelectItem, { minLength: 1, maxLength: 5 });

// Complex WHERE expression (deeper nesting)
const complexWhereExpr: fc.Arbitrary<SqlExpr> = fc.oneof(
  comparisonExpr,
  betweenExpr,
  inExpr,
  likeExpr,
  fc.tuple(booleanOp, comparisonExpr, comparisonExpr).map(([op, l, r]) => [op, l, r]),
  fc.tuple(booleanOp, comparisonExpr, fc.tuple(booleanOp, comparisonExpr, comparisonExpr))
    .map(([op1, e1, [op2, e2, e3]]) => [op1, e1, [op2, e2, e3]])
);

// Window function
const windowFn: fc.Arbitrary<SqlExpr> = fc.tuple(
  fc.constantFrom("%row_number", "%rank", "%dense_rank", "%sum", "%count"),
  fc.option(columnIdent, { nil: undefined }),
  fc.option(fc.array(columnIdent, { minLength: 1, maxLength: 2 }), { nil: undefined }),
  fc.option(orderByList, { nil: undefined })
).map(([fn, arg, partitionBy, orderBy]) => {
  const fnCall: SqlExpr[] = arg ? [fn, arg] : [fn];
  const overSpec: Record<string, unknown> = {};
  if (partitionBy) overSpec["partition-by"] = partitionBy;
  if (orderBy) overSpec["order-by"] = orderBy;
  return ["over", fnCall, overSpec];
});

// Window function with alias
const aliasedWindowFn: fc.Arbitrary<SqlExpr> = fc.tuple(
  windowFn,
  identName
).map(([wfn, alias]) => [wfn, alias]);

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
  limit: typedValue(fc.integer({ min: 1, max: 100 })),
  offset: typedValue(fc.integer({ min: 0, max: 100 })),
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

// SELECT with JOIN
const selectWithJoin: fc.Arbitrary<SqlClause> = fc.tuple(
  tableIdent,
  tableIdent,
  identName,
  identName
).chain(([table1, table2, alias1, alias2]) => {
  const a1 = alias1;
  const a2 = alias1 === alias2 ? alias2 + "2" : alias2;
  return fc.constant({
    select: [`${a1}.id`, `${a2}.id`],
    from: [[table1, a1]],
    join: [
      [[table2, a2], ["=", `${a1}.id`, `${a2}.fk`]]
    ],
  } as SqlClause);
});

// Full SELECT with multiple clauses
const fullSelect: fc.Arbitrary<SqlClause> = fc.record({
  select: selectList,
  from: tableIdent,
  where: fc.option(simpleWhereExpr, { nil: undefined }),
  "order-by": fc.option(orderByList, { nil: undefined }),
  limit: fc.option(typedValue(fc.integer({ min: 1, max: 100 })), { nil: undefined }),
}).map((clause) => {
  const result: SqlClause = { select: clause.select, from: clause.from };
  if (clause.where) result.where = clause.where;
  if (clause["order-by"]) result["order-by"] = clause["order-by"];
  if (clause.limit) result.limit = clause.limit;
  return result;
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
  const values = vals.slice(0, cols.length);
  while (values.length < cols.length) {
    values.push(null);
  }
  return fc.constant({
    "insert-into": table,
    columns: cols,
    values: [values],
  } as SqlClause);
});

// ============================================================================
// Advanced Generators (Subqueries, CTEs, Window Functions)
// ============================================================================

// Subquery in FROM
const subqueryFrom: fc.Arbitrary<SqlClause> = fc.tuple(
  selectList,
  tableIdent,
  identName
).map(([innerSelect, innerTable, alias]) => ({
  select: ["*"],
  from: [[{ select: innerSelect, from: innerTable }, alias]],
} as SqlClause));

// Subquery in WHERE with IN
const subqueryWhereIn: fc.Arbitrary<SqlClause> = fc.tuple(
  selectList,
  tableIdent,
  columnIdent,
  tableIdent,
  comparisonExpr
).map(([outerSelect, outerTable, col, innerTable, innerWhere]) => ({
  select: outerSelect,
  from: outerTable,
  where: ["in", col, { select: [col], from: innerTable, where: innerWhere }],
} as SqlClause));

// EXISTS subquery
const existsSubquery: fc.Arbitrary<SqlClause> = fc.tuple(
  selectList,
  tableIdent,
  identName,
  tableIdent,
  identName
).map(([outerSelect, outerTable, outerAlias, innerTable, innerAlias]) => ({
  select: outerSelect,
  from: [[outerTable, outerAlias]],
  where: ["exists", {
    select: [{ $: 1 }],
    from: [[innerTable, innerAlias]],
    where: ["=", `${outerAlias}.id`, `${innerAlias}.fk`]
  }],
} as SqlClause));

// CTE (WITH clause)
const cteSelect: fc.Arbitrary<SqlClause> = fc.tuple(
  identName,
  selectList,
  tableIdent,
  fc.option(simpleWhereExpr, { nil: undefined })
).map(([cteName, innerSelect, innerTable, innerWhere]) => {
  const innerClause: SqlClause = { select: innerSelect, from: innerTable };
  if (innerWhere) innerClause.where = innerWhere;
  return {
    with: [[cteName, innerClause]],
    select: ["*"],
    from: cteName,
  } as SqlClause;
});

// UNION
const unionSelect: fc.Arbitrary<SqlClause> = fc.tuple(
  selectList,
  tableIdent,
  tableIdent
).map(([cols, table1, table2]) => ({
  union: [
    { select: cols, from: table1 },
    { select: cols, from: table2 },
  ],
} as SqlClause));

// SELECT with window function
const selectWithWindow: fc.Arbitrary<SqlClause> = fc.tuple(
  fc.array(fc.oneof(columnIdent, aliasedWindowFn), { minLength: 1, maxLength: 4 }),
  tableIdent
).map(([cols, table]) => ({
  select: cols,
  from: table,
} as SqlClause));

// SELECT with complex expressions (CASE, BETWEEN, etc.)
const selectWithComplexExpr: fc.Arbitrary<SqlClause> = fc.record({
  select: extendedSelectList,
  from: tableIdent,
  where: fc.option(complexWhereExpr, { nil: undefined }),
  "order-by": fc.option(orderByList, { nil: undefined }),
}).map((clause) => {
  const result: SqlClause = { select: clause.select, from: clause.from };
  if (clause.where) result.where = clause.where;
  if (clause["order-by"]) result["order-by"] = clause["order-by"];
  return result;
});

// SELECT with GROUP BY and HAVING
const selectWithHaving: fc.Arbitrary<SqlClause> = fc.tuple(
  fc.array(columnIdent, { minLength: 1, maxLength: 2 }),
  tableIdent,
  typedValue(fc.integer({ min: 1, max: 10 }))
).map(([groupCols, table, havingVal]) => ({
  select: [...groupCols, [["%count", "*"], "cnt"] as SqlExpr],
  from: table,
  "group-by": groupCols,
  having: [">", ["%count", "*"], havingVal],
} as SqlClause));

// Multiple JOINs
const multipleJoins: fc.Arbitrary<SqlClause> = fc.tuple(
  tableIdent,
  tableIdent,
  tableIdent,
  identName,
  identName,
  identName
).map(([t1, t2, t3, a1, a2, a3]) => {
  const alias1 = a1;
  const alias2 = a1 === a2 ? a2 + "2" : a2;
  const alias3 = [alias1, alias2].includes(a3) ? a3 + "3" : a3;
  return {
    select: [`${alias1}.id`, `${alias2}.name`, `${alias3}.value`],
    from: [[t1, alias1]],
    join: [
      [[t2, alias2], ["=", `${alias1}.id`, `${alias2}.fk`]],
    ],
    "left-join": [
      [[t3, alias3], ["=", `${alias2}.id`, `${alias3}.fk`]],
    ],
  } as SqlClause;
});

// DISTINCT
const selectDistinct: fc.Arbitrary<SqlClause> = fc.record({
  "select-distinct": selectList,
  from: tableIdent,
});

// COUNT(DISTINCT) and aggregate with FILTER
const advancedAggregates: fc.Arbitrary<SqlClause> = fc.tuple(
  fc.array(columnIdent, { minLength: 1, maxLength: 2 }),
  tableIdent
).map(([groupCols, table]) => ({
  select: [
    ...groupCols,
    [["%count-distinct", groupCols[0]], "unique_count"],
    ["filter", ["%count", "*"], ["=", "status", { $: "active" }]],
  ] as SqlExpr[],
  from: table,
  "group-by": groupCols,
}));

// LATERAL subquery
const lateralSubquery: fc.Arbitrary<SqlClause> = fc.tuple(
  tableIdent,
  tableIdent,
  identName,
  identName
).map(([outerTable, innerTable, outerAlias, innerAlias]) => ({
  select: [`${outerAlias}.id`, `${innerAlias}.value`],
  from: [
    [outerTable, outerAlias],
    [["lateral", {
      select: ["*"],
      from: innerTable,
      where: ["=", "fk", `${outerAlias}.id`],
      limit: { $: 3 },
    }], innerAlias],
  ],
} as SqlClause));

// ARRAY expressions
const arrayExpr: fc.Arbitrary<SqlClause> = fc.tuple(
  tableIdent,
  fc.array(typedValue(fc.integer({ min: 1, max: 100 })), { minLength: 2, maxLength: 5 })
).map(([table, vals]) => ({
  select: ["*"],
  from: table,
  where: ["=", "%any", ["array", ...vals], "id"],
} as SqlClause));

// INSERT with ON CONFLICT
const insertOnConflict: fc.Arbitrary<SqlClause> = fc.tuple(
  tableIdent,
  fc.array(identName, { minLength: 2, maxLength: 4 }),
  fc.array(literal, { minLength: 2, maxLength: 4 })
).chain(([table, cols, vals]) => {
  const values = vals.slice(0, cols.length);
  while (values.length < cols.length) values.push(null);
  const conflictCol = cols[0];
  const updateCol = cols.length > 1 ? cols[1] : cols[0];
  return fc.constant({
    "insert-into": table,
    columns: cols,
    values: [values],
    "on-conflict": [conflictCol],
    "do-update-set": { [updateCol!]: ["excluded", updateCol] },
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

describe("advanced generative tests", () => {
  it("subquery in FROM", () => {
    fc.assert(
      fc.property(subqueryFrom, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("subquery in WHERE with IN", () => {
    fc.assert(
      fc.property(subqueryWhereIn, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("EXISTS subquery", () => {
    fc.assert(
      fc.property(existsSubquery, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("CTE (WITH clause)", () => {
    fc.assert(
      fc.property(cteSelect, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("UNION", () => {
    fc.assert(
      fc.property(unionSelect, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("window functions", () => {
    fc.assert(
      fc.property(selectWithWindow, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("complex expressions (CASE, BETWEEN, IN, LIKE)", () => {
    fc.assert(
      fc.property(selectWithComplexExpr, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("GROUP BY with HAVING", () => {
    fc.assert(
      fc.property(selectWithHaving, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("multiple JOINs", () => {
    fc.assert(
      fc.property(multipleJoins, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("SELECT DISTINCT", () => {
    fc.assert(
      fc.property(selectDistinct, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("COUNT(DISTINCT) and FILTER aggregates", () => {
    fc.assert(
      fc.property(advancedAggregates, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("LATERAL subqueries", () => {
    fc.assert(
      fc.property(lateralSubquery, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 100 }
    );
  });

  it("INSERT with ON CONFLICT", () => {
    fc.assert(
      fc.property(insertOnConflict, (clause) => {
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
  const basicStatements = fc.oneof(
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

  const advancedStatements = fc.oneof(
    subqueryFrom,
    subqueryWhereIn,
    existsSubquery,
    cteSelect,
    unionSelect,
    selectWithWindow,
    selectWithComplexExpr,
    selectWithHaving,
    multipleJoins,
    selectDistinct,
    advancedAggregates,
    lateralSubquery,
    insertOnConflict
  );

  const anyStatement = fc.oneof(basicStatements, advancedStatements);

  it("1000 random basic statements", () => {
    fc.assert(
      fc.property(basicStatements, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 1000 }
    );
  });

  it("500 random advanced statements", () => {
    fc.assert(
      fc.property(advancedStatements, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 500 }
    );
  });

  it("2000 random mixed statements", () => {
    fc.assert(
      fc.property(anyStatement, (clause) => {
        roundTripTest(clause);
      }),
      { numRuns: 2000 }
    );
  });
});
