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
sentinel calls, then converts them back to native honey constructs after
parsing, so the clause map round-trips to real DuckDB syntax. Handled:

| construct | example |
|---|---|
| list literals | `[1, 2, 3]`, nested |
| struct literals | `{'a': 1, 'b': 'x'}` |
| list slicing | `a[1:2]`, `a[2:]`, `a[:3]` |
| `TRY_CAST` | `TRY_CAST(a AS INT)` |
| aggregate `ORDER BY` | `list(v ORDER BY v DESC)` |
| `GROUP BY` / `ORDER BY ALL` | `GROUP BY ALL` |
| FROM-first | `FROM t SELECT a` |
| named arguments | `f(bin_count => 10)`, `f(x := 1)` |
| `==` | normalised to `=` |

Rewrites are string-, identifier- and comment-aware, so brackets inside
`'literals'`, `"identifiers"`, `$$blocks$$` and comments are never touched.
Without `{dialect: 'duckdb'}` parsing is byte-for-byte unchanged.

On DuckDB's own 23,670-statement test corpus: the PostgreSQL front end parses
68.9%, the DuckDB front end **80.8%**, and **98.4%** of what parses round-trips
back to SQL DuckDB accepts.

### Known limitations

- Not yet parsed: `EXCLUDE`/`REPLACE` star modifiers, `QUALIFY`, lambdas,
  `PIVOT`, `ASOF`/`POSITIONAL` joins, `COLUMNS()`, `USING SAMPLE`. These can all
  still be *built* as clause maps and emitted — only reading them back from SQL
  is unsupported.
- Data-modifying CTEs (`WITH d AS (DELETE ... RETURNING ...) SELECT`) parse and
  emit, but DuckDB rejects them — they are PostgreSQL-only.
- `E'...'` escape-string literals fail upstream in `pgsql-ast-parser`.
- Integer division differs semantically: `5/2` is `2` on PostgreSQL and `2.5` on
  DuckDB. The dialect layer does not rewrite this, because doing so correctly
  needs operand types.

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
