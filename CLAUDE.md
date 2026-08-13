# honey-ts - Building React Components

This library provides a schema-aware query builder API designed for building SQL construction UIs.

## Quick Start

```typescript
import { createQueryBuilder, fromSql, toSql } from 'honey-ts';

// Initialize with your database schema
const builder = createQueryBuilder({
  tables: [
    {
      name: 'users',
      schema: 'public',
      columns: [
        { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
        { name: 'email', type: 'text', nullable: false },
        { name: 'name', type: 'text', nullable: true },
        { name: 'created_at', type: 'timestamp', nullable: false },
      ],
    },
    {
      name: 'orders',
      schema: 'public',
      columns: [
        { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
        { name: 'user_id', type: 'integer', nullable: false, isForeignKey: true, references: { table: 'users', column: 'id' } },
        { name: 'total', type: 'numeric', nullable: false },
        { name: 'status', type: 'text', nullable: false },
      ],
    },
  ],
});
```

## Core Concepts

### SqlClause (HoneySQL Format)

Queries are represented as plain JavaScript objects:

```typescript
const clause = {
  select: ['u.email', 'u.name'],
  from: [['users', 'u']],
  where: ['=', 'u.status', { $: 'active' }],
  'order-by': [['u.created_at', 'desc']],
  limit: { $: 100 },
};

// Convert to SQL
const [sql, ...params] = toSql(clause);
// => ['SELECT u.email, u.name FROM users AS u WHERE u.status = ? ORDER BY u.created_at DESC LIMIT ?', 'active', 100]
```

### Parsing SQL

```typescript
const clause = fromSql("SELECT * FROM users WHERE status = 'active'");
// Returns HoneySQL clause object
```

## Building UI Components

### Table Selector

```tsx
function TableSelector({ builder, onSelect }) {
  const tables = builder.getTablesForFrom();

  return (
    <select onChange={(e) => onSelect(e.target.value)}>
      {tables.map((t) => (
        <option key={t.name} value={t.name}>
          {t.schema}.{t.name}
        </option>
      ))}
    </select>
  );
}
```

### Column Selector

```tsx
function ColumnSelector({ builder, clause, onSelect }) {
  // Gets columns from all tables in FROM + JOINs
  const columns = builder.getColumnsForSelect(clause);

  return (
    <select onChange={(e) => onSelect(e.target.value)}>
      {columns.map((c) => (
        <option key={c.qualified} value={c.qualified}>
          {c.qualified} ({c.column.type})
        </option>
      ))}
    </select>
  );
}
```

### Operator Selector (Context-Aware)

```tsx
function OperatorSelector({ builder, columnType, onSelect }) {
  const operators = builder.getOperatorsForType(columnType);

  return (
    <select onChange={(e) => onSelect(e.target.value)}>
      {operators.map((op) => (
        <option key={op.op} value={op.op}>
          {op.label}
        </option>
      ))}
    </select>
  );
}

// Text columns get: =, <>, like, ilike, ~, ~*, etc.
// Numeric columns get: =, <>, <, <=, >, >=, between, etc.
// JSON columns get: =, <>, ->, ->>, @>, ?, etc.
```

### Function Selector

```tsx
function FunctionSelector({ builder, columnType, onSelect }) {
  const fns = builder.getFunctionsForType(columnType);
  const aggregates = builder.getAggregateFunctions();

  return (
    <>
      <optgroup label="Functions">
        {fns.map((f) => (
          <option key={f.name} value={f.name} title={f.description}>
            {f.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Aggregates">
        {aggregates.map((f) => (
          <option key={f.name} value={f.name} title={f.description}>
            {f.label}
          </option>
        ))}
      </optgroup>
    </>
  );
}
```

### Join Suggestions

```tsx
function JoinSuggestions({ builder, clause, onJoin }) {
  const joinable = builder.getJoinableTables(clause);

  return (
    <div>
      {joinable.map((j) => (
        <button
          key={j.table.name}
          onClick={() => {
            const updated = builder.addJoin(
              clause,
              j.table.name,
              j.suggestedOn,
              j.joinType
            );
            onJoin(updated);
          }}
        >
          {j.joinType.toUpperCase()} JOIN {j.table.name}
        </button>
      ))}
    </div>
  );
}
```

### WHERE Builder

```tsx
function WhereBuilder({ builder, clause, onChange }) {
  const columns = builder.getColumnsForWhere(clause);
  const [selectedCol, setSelectedCol] = useState(null);
  const [selectedOp, setSelectedOp] = useState(null);
  const [value, setValue] = useState('');

  const operators = selectedCol
    ? builder.getOperatorsForType(selectedCol.column.type)
    : [];

  const addCondition = () => {
    const condition = [selectedOp.op, selectedCol.qualified, { $: value }];
    const updated = builder.addWhere(clause, condition);
    onChange(updated);
  };

  return (
    <div>
      <select onChange={(e) => setSelectedCol(columns.find(c => c.qualified === e.target.value))}>
        {columns.map((c) => (
          <option key={c.qualified} value={c.qualified}>{c.qualified}</option>
        ))}
      </select>

      <select onChange={(e) => setSelectedOp(operators.find(o => o.op === e.target.value))}>
        {operators.map((op) => (
          <option key={op.op} value={op.op}>{op.label}</option>
        ))}
      </select>

      {selectedOp?.valueType === 'single' && (
        <input
          type={selectedOp.valueInputType || 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}

      <button onClick={addCondition}>Add</button>
    </div>
  );
}
```

## Clause Manipulation API

All manipulation methods return new clause objects (immutable):

```typescript
// Start with empty clause
let clause = {};

// Add FROM
clause = builder.addFrom(clause, 'users', 'u');

// Add SELECT columns
clause = builder.addSelect(clause, 'u.email');
clause = builder.addSelect(clause, ['%lower', 'u.name'], 'name_lower');

// Add JOIN (with FK-based suggestion)
const joinable = builder.getJoinableTables(clause);
if (joinable.length > 0) {
  clause = builder.addJoin(clause, joinable[0].table.name, joinable[0].suggestedOn, joinable[0].joinType);
}

// Add WHERE conditions
clause = builder.addWhere(clause, ['=', 'u.status', { $: 'active' }]);
clause = builder.addWhere(clause, ['>', 'u.created_at', { $: new Date('2024-01-01') }]);

// Set ORDER BY
clause = builder.setOrderBy(clause, [['u.created_at', 'desc']]);

// Set LIMIT/OFFSET
clause = builder.setLimit(clause, 100);
clause = builder.setOffset(clause, 0);

// Remove items
clause = builder.removeSelect(clause, 'name_lower');
clause = builder.removeWhere(clause, 0);  // Remove first WHERE condition
clause = builder.clear(clause, 'order-by');

// Convert to SQL
const [sql, ...params] = toSql(clause);
```

## Validation

```typescript
const result = builder.validate(clause);

if (!result.valid) {
  result.errors.forEach((e) => {
    console.error(`${e.path}: ${e.message} [${e.code}]`);
  });
}

result.warnings.forEach((w) => {
  console.warn(`${w.path}: ${w.message}`);
});
```

## Dialects

`toSql`/`format` take a dialect. The default is `postgres`; `duckdb` is fully
supported.

```typescript
import { format } from 'honey-ts';

format(clause, { dialect: 'duckdb' });
```

**DuckDB is not a superset of PostgreSQL.** Its parser is a fork of the Postgres
grammar, but 13 of the operators `pg-ops` registers have no DuckDB equivalent.
The dialect handles this in three ways:

| PostgreSQL | DuckDB | behaviour |
|---|---|---|
| `~*` `!~*` | `regexp_matches(s, p, 'i')` | lowered automatically |
| `#>` `#>>` | `json_extract` / `json_extract_string` | lowered automatically |
| `?` `@?` | `json_exists` | lowered automatically |
| `@>` `<@` | `json_contains` | lowered automatically |
| `jsonb` | `JSON` | type alias |
| `@@` `<->` `?\|` `?&` `#-` | — | **throws** |

Emitting an unsupported operator throws rather than producing SQL that would
fail at query time:

```typescript
format({ select: [['@@', 'doc', { v: 'x' }]] }, { dialect: 'duckdb' });
// Error: Operator '@@' is not supported by dialect 'duckdb'
```

### DuckDB-specific syntax

These constructs throw on any other dialect:

```typescript
// SELECT * EXCLUDE (id) REPLACE (lower(name) AS name)
{ select: [['star', { exclude: ['id'], replace: [[['%lower', 'name'], 'name']] }]] }

// [1, 2, 3]
['list', { v: 1 }, { v: 2 }, { v: 3 }]

// {'a': 1, 'b': 'x'}
['struct', ['a', { v: 1 }], ['b', { v: 'x' }]]

// list_transform([1,2], x -> x + 1)
['%list_transform', ['list', { v: 1 }, { v: 2 }], ['lambda', 'x', ['+', 'x', { v: 1 }]]]

// QUALIFY (clause key, emitted after HAVING and before ORDER BY)
{ select: ['a'], from: ['t'], qualify: ['=', ['%row_number'], { v: 1 }] }
```

### DuckDB function catalog

`honey-ts/duckdb-ops` exposes 799 functions generated from DuckDB's own
`duckdb_functions()` catalog — names, argument names/types, return types,
descriptions and overloads — plus the reserved-keyword set:

```typescript
import { DUCKDB_FUNCTIONS_BY_NAME, DUCKDB_AGGREGATES } from 'honey-ts/duckdb-ops';

DUCKDB_FUNCTIONS_BY_NAME.get('date_trunc');
// { name: '%date_trunc', label: 'DATE_TRUNC', description: 'Truncate to specified precision',
//   returnType: 'TIMESTAMP', args: [{name:'part',type:'VARCHAR'}, ...], overloads: [...] }
```

Regenerate after a DuckDB version bump (requires the `@duckdb/node-api`
devDependency) and review the diff:

```bash
npm run gen:duckdb-ops
```

### Parsing DuckDB SQL

`fromSql` parses with a PostgreSQL parser by default. Pass the dialect to enable
a rewriting front end that handles DuckDB-only syntax:

```typescript
import { fromSql } from 'honey-ts';

fromSql("SELECT [1, 2], {'a': 1} FROM t GROUP BY ALL", { dialect: 'duckdb' });
```

It rewrites DuckDB constructs into PostgreSQL-parseable text using reserved
sentinel calls (or dispatches whole statements to dedicated mini-parsers),
then converts them back to native honey constructs after parsing, so the
clause map round-trips to real DuckDB syntax. Handled:

| construct | example |
|---|---|
| list / struct / map literals | `[1, 2]`, `{'a': 1}`, `MAP {'k': v}` |
| list slicing / subscripts | `a[1:2]`, `a[2:]`, `col['key']` |
| lambdas (both syntaxes) | `x -> x + 1`, `lambda x : x + 1` |
| `TRY_CAST`, composite type casts | `x::STRUCT(a INT)`, `::MAP(K,V)`, `::INT[3]` |
| field access | `({'a':1}).a`, chained |
| aggregate `ORDER BY` / `DISTINCT` | `list(v ORDER BY v DESC)` |
| `EXPORT_STATE` | `sum(x) EXPORT_STATE` |
| star modifiers | `* EXCLUDE (a) REPLACE (e AS n)`, `t.*` |
| `GROUP BY ALL`, `GROUPING SETS` | `GROUP BY ALL` |
| window frames + `EXCLUDE`, named `WINDOW` | `ROWS BETWEEN ... EXCLUDE TIES`, `OVER w` |
| `QUALIFY` | after WHERE/GROUP BY/HAVING |
| join variants | `ASOF [LEFT] JOIN`, `SEMI`, `ANTI`, `POSITIONAL` |
| `USING SAMPLE` | `10%`, `5 ROWS`, `reservoir(10) REPEATABLE (42)` |
| statements | `PIVOT`/`UNPIVOT` (both syntaxes), `DESCRIBE`, `SUMMARIZE`, `SHOW` |
| INSERT modifiers | `INSERT OR REPLACE/IGNORE`, `BY NAME` |
| set operations | `EXCEPT [ALL]`, `INTERSECT`, mixed chains kept left-associative |
| comparisons | `IS [NOT] DISTINCT FROM` |
| comprehensions | `[x*2 for x in l if x > 1]` → `list_transform`/`list_filter` |
| relaxed grammar | bare `HAVING`, `FILTER (cond)`, `GROUP BY ()`, trailing commas, bare `FROM VALUES` |
| misc | `//` division, `COLLATE`, `IGNORE NULLS`, `INTERVAL 5 SECOND`, `1.5e-3`, `$$strings$$`, `==`, FROM-first, unaliased subqueries, CTE column aliases |

Rewrites are string-, identifier- and comment-aware, so construct-like text
inside `'literals'`, `"identifiers"` and comments is never touched. Without
`{dialect: 'duckdb'}` parsing is byte-for-byte unchanged.

**The `->` ambiguity** is resolved by DuckDB's own catalog: an arrow is read
as a lambda only in argument position of a function whose signature has a
`LAMBDA`-typed parameter (`list_transform`, `list_filter`, ..., plus
`COLUMNS`); everywhere else it stays the JSON operator. A test pins the
lambda-function list against the generated catalog.

Strong types for every construct live in `honey-ts` as `duckdb.*`:
constructors (`duckdb.list(...)`, `duckdb.struct({...})`, `duckdb.lambda`,
`duckdb.star`, `duckdb.map`, `duckdb.collate`, ...), guards
(`duckdb.isDuckDBLambda(x)`, ...), and clause typing —
`fromSql(sql, {dialect: 'duckdb'})` returns `DuckDBClause` with typed
`qualify`/`sample`/`pivot`/join-variant keys.

On DuckDB's own 23,670-statement test corpus: the PostgreSQL front end parses
68.9%, the DuckDB front end **94.0%**, and **99.0%** of what parses round-trips
back to SQL DuckDB accepts (verified against a live DuckDB parser in CI).

### Known limitations

- Data-modifying CTEs (`WITH d AS (DELETE ... RETURNING ...) SELECT`) parse and
  emit, but DuckDB rejects them — they are PostgreSQL-only.
- `E'...'` escape-string literals fail upstream in `pgsql-ast-parser`.
- `AS MATERIALIZED` CTE hints are dropped on parse (results unchanged).
- Named `WINDOW` clauses are expanded inline; `FROM`-first and `INTERVAL n
  UNIT` normalise to equivalent forms rather than round-tripping verbatim.
- Integer division differs semantically: `5/2` is `2` on PostgreSQL and `2.5` on
  DuckDB. The dialect layer does not rewrite this, because doing so correctly
  needs operand types. (`5 // 2` is the DuckDB-only integer form and throws on
  postgres.)

## SQL Guard (LLM Validation)

For validating LLM-generated SQL:

```typescript
import { guardSql, fromSql } from 'honey-ts';

const clause = fromSql(llmGeneratedSql);

const result = guardSql(clause, {
  allowedTables: ['public.*', 'analytics.events'],
  allowedOperations: ['select'],
  requireLimit: true,
  maxRows: 10000,
  requireWhere: [],  // operations that must have WHERE
});

if (!result.allowed) {
  console.error(result.reason);
  // "Table 'admin.secrets' not in allowed list"
  // "Operation 'delete' not allowed"
  // "Query exceeds max rows limit of 10000"
}
```

## Query Analysis

For understanding existing queries:

```typescript
import { analyzeSelects, getTableAliases, getReferencedColumns } from 'honey-ts';

const clause = fromSql(`
  SELECT u.email, LOWER(TRIM(u.name)) as clean_name
  FROM users u
`);

// Get table alias mapping
const aliases = getTableAliases(clause);
// { items: Map { 'u' => 'users' }, children: [] }

// Analyze SELECT expressions
const analysis = analyzeSelects(clause);
// {
//   items: [
//     { alias: 'email', sources: ['users.email'], isPassthrough: true, expr: 'u.email' },
//     { alias: 'clean_name', sources: ['users.name'], isPassthrough: false, expr: ['%lower', ['%trim', 'u.name']] }
//   ],
//   children: []
// }

// Get all columns referenced in an expression
const cols = getReferencedColumns(['%lower', ['%trim', 'u.name']], new Map([['u', 'users']]));
// ['users.name']
```

## Type Definitions

```typescript
interface ColumnSchema {
  name: string;
  type: string;  // PostgreSQL type
  nullable: boolean;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  references?: { table: string; column: string };
}

interface TableSchema {
  name: string;
  schema: string;
  columns: ColumnSchema[];
}

interface DatabaseSchema {
  tables: TableSchema[];
}

interface OperatorInfo {
  op: string;           // '=', '<>', 'like', '->', etc.
  label: string;        // 'equals', 'contains', etc.
  valueType: 'single' | 'none' | 'list' | 'range';
  valueInputType?: string;  // 'text', 'number', 'date'
}

interface FunctionInfo {
  name: string;         // '%lower', '%count', etc.
  label: string;        // 'LOWER', 'COUNT'
  description: string;
  returnType: string;
  args: Array<{ name: string; type: string; optional?: boolean }>;
}
```

## Expression Format

HoneySQL expressions use arrays with the operator/function first:

```typescript
// Comparison: ['=', column, value]
['=', 'u.status', { $: 'active' }]

// Function call: ['%fn', ...args]
['%lower', 'u.email']
['%coalesce', 'u.name', { $: 'Anonymous' }]

// Nested: compose naturally
['%lower', ['%trim', 'u.email']]

// Parameters: { $: value }
{ $: 'active' }      // => ?  (param: 'active')
{ $: 100 }           // => ?  (param: 100)
{ $: null }          // => NULL

// Raw SQL: { raw: 'sql' }
{ raw: 'NOW()' }

// Aliasing: [expr, alias]
[['%count', '*'], 'total']
['u.email', 'user_email']
```

## Best Practices

1. **Initialize once**: Create the QueryBuilder at app startup with your full schema
2. **Immutable updates**: All clause manipulation returns new objects - use React state normally
3. **Validate before execute**: Use `guardSql` for LLM input, `builder.validate` for user input
4. **Type-aware operators**: Use `getOperatorsForType` to show only valid operators
5. **FK-aware joins**: Use `getJoinableTables` to suggest joins with correct conditions
