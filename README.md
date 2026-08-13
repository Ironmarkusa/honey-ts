# honey-ts

**SQL as data structures for TypeScript** - A port of [HoneySQL](https://github.com/seancorfield/honeysql) for PostgreSQL and DuckDB.

```typescript
import { format, fromSql, modify, $ } from 'honey-ts';

// Build SQL from data structures
const query = {
  select: ["id", "name", "email"],
  from: "users",
  where: ["=", "status", { $: "active" }]
};

const [sql, ...params] = format(query);
// => ["SELECT id, name, email FROM users WHERE status = $1", "active"]

// Parse SQL back to data structures
const clause = fromSql("SELECT * FROM orders WHERE total > 100");
// => { select: ["*"], from: "orders", where: [">", "total", { $: 100 }] }

// Inject conditions across all subqueries (tenant isolation!)
const secured = modify.addWhere(clause, ["=", "tenant_id", $("tenant_123")]);
```

## Why honey-ts?

**For LLM-powered SQL generation with deterministic safety guarantees.**

The typical LLM SQL workflow is brittle:
1. LLM generates SQL string
2. Hope it's valid
3. Hope it doesn't access unauthorized data
4. Execute and pray

With honey-ts:
1. LLM generates SQL string (or clause map directly)
2. Parse to structured data: `fromSql(sql)`
3. **Inject tenant filters, auth checks** via `modify.addWhere()` — subquery- and join-aware, deduplicating
4. Convert back to parameterized SQL: `format(clause)`
5. Execute with confidence

The round-trip is deterministic: `toSql(fromSql(sql))` produces equivalent SQL.

## Installation

```bash
# From npm (when published)
npm install honey-ts

# From GitHub
npm install github:Ironmarkusa/honey-ts
```

## Quick Start

### Data-First Approach

```typescript
import { format } from 'honey-ts';

// Plain strings are identifiers
// {$: value} wraps values for parameterization
const query = {
  select: ["id", "name"],
  from: "users",
  where: ["and",
    ["=", "status", { $: "active" }],
    [">", "created_at", { $: new Date("2024-01-01") }]
  ],
  "order-by": [["created_at", "desc"]],
  limit: { $: 10 }
};

const [sql, ...params] = format(query);
// sql: SELECT id, name FROM users WHERE (status = $1) AND (created_at > $2) ORDER BY created_at DESC LIMIT $3
// params: ["active", Date, 10]
```

### Round-Trip Parsing

```typescript
import { fromSql, format } from 'honey-ts';

// Parse any SQL
const clause = fromSql(`
  SELECT u.id, COUNT(o.id) as order_count
  FROM users u
  LEFT JOIN orders o ON u.id = o.user_id
  WHERE u.status = 'active'
  GROUP BY u.id
  HAVING COUNT(o.id) > 5
`);

// Modify programmatically
clause.limit = { $: 100 };

// Back to SQL
const [sql, ...params] = format(clause);
```

### Tenant Isolation with Tree Walker

```typescript
import { fromSql, format, modify, $ } from 'honey-ts';

// LLM-generated SQL with subqueries
const llmSql = `
  SELECT * FROM orders
  WHERE user_id IN (SELECT id FROM users WHERE role = 'premium')
`;

// Parse and inject tenant filter into ALL queries (including subqueries!)
const clause = fromSql(llmSql);
const secured = modify.addWhere(clause, ["=", "tenant_id", $(tenantId)]);

// Both orders and users tables now have tenant_id filter
const [sql, ...params] = format(secured);
```

## DuckDB Dialect

honey-ts speaks DuckDB as a first-class dialect — parsing, emitting, and typed
construction, all verified against a live DuckDB parser. On DuckDB's own
23,675-statement test suite, `fromSql` parses **94%** and **99%** of parsed
statements round-trip to SQL DuckDB accepts.

```typescript
import { format, fromSql, duckdb } from 'honey-ts';

// Parse DuckDB syntax (lists, structs, lambdas, PIVOT, QUALIFY, ...)
const clause = fromSql(
  "SELECT [x * 2 for x in ids] FROM t QUALIFY row_number() OVER (PARTITION BY g) = 1",
  { dialect: 'duckdb' }
);

// Emit DuckDB SQL
const [sql] = format(clause, { dialect: 'duckdb' });

// Or build with typed constructors
const query = {
  select: [
    duckdb.list({ $: 1 }, { $: 2 }),                    // [1, 2]
    duckdb.struct({ a: { $: 1 } }),                     // {'a': 1}
    duckdb.star({ exclude: ['secret'] }),               // * EXCLUDE (secret)
  ],
  from: ['t'],
  qualify: ['=', ['%row_number'], { $: 1 }],
};
```

### What's covered

Lists `[1,2]`, structs `{'a':1}`, `MAP {}` literals, slicing `a[1:2]`, lambdas
(both `x -> x+1` and `lambda x: x+1`), list comprehensions, `TRY_CAST`,
composite type casts (`::STRUCT(...)`, `::INT[3]`), field access `(x).a`,
star `EXCLUDE`/`REPLACE`, `QUALIFY`, `GROUP BY ALL`, `GROUPING SETS`, window
frames + named `WINDOW` clauses, `ASOF`/`SEMI`/`ANTI`/`POSITIONAL` joins,
`USING SAMPLE`, `PIVOT`/`UNPIVOT` (both syntaxes), `DESCRIBE`/`SUMMARIZE`/`SHOW`,
`INSERT OR REPLACE`/`IGNORE`/`BY NAME`, `EXPORT_STATE`, `EXCEPT`/`INTERSECT`,
`IS DISTINCT FROM`, `COLLATE`, `//` division, multi-part names
(`db.schema.table`), and DuckDB's relaxed grammar (trailing commas, bare
`HAVING`, `FROM`-first, unaliased subqueries, ...).

### Dialect separation

DuckDB is **not** a superset of PostgreSQL, and the dialect boundary is
enforced both ways:

```typescript
// PG operators DuckDB lacks are lowered when possible...
format({ select: [['~*', 'email', { $: '^a' }]] }, { dialect: 'duckdb' });
// => REGEXP_MATCHES(email, ?, 'i')

// ...and THROW when they aren't — never emitting SQL that fails at query time
format({ select: [['@@', 'doc', { $: 'x' }]] }, { dialect: 'duckdb' });
// Error: Operator '@@' is not supported by dialect 'duckdb'

// DuckDB-only constructs throw on postgres the same way
format({ select: [duckdb.list({ $: 1 })] }, { dialect: 'postgres' });
// Error: list literals require dialect 'duckdb'
```

The `->` lambda/JSON ambiguity is resolved from DuckDB's own catalog: an arrow
is a lambda only in argument position of a function whose signature takes a
`LAMBDA` parameter; everywhere else it stays the JSON operator.

### Function catalog

`honey-ts/duckdb-ops` exposes 799 functions generated from DuckDB's own
`duckdb_functions()` — names, signatures, descriptions, and the reserved
keyword set — for building schema-aware UIs:

```typescript
import { DUCKDB_FUNCTIONS_BY_NAME } from 'honey-ts/duckdb-ops';

DUCKDB_FUNCTIONS_BY_NAME.get('date_trunc');
// { name: '%date_trunc', label: 'DATE_TRUNC', returnType: 'TIMESTAMP',
//   args: [{ name: 'part', type: 'VARCHAR' }, ...], overloads: [...] }
```

## Syntax Reference

### Identifiers and Values

```typescript
// Plain strings = SQL identifiers (columns, tables)
"id"              // => id
"users"           // => users
"u.id"            // => u.id

// {$: value} = parameterized values
{ $: "active" }   // => $1 (with "active" as param)
{ $: 42 }         // => $1 (with 42 as param)
{ $: true }       // => $1 (with true as param)

// {type: value} = typed/cast values
{ text: "hello" } // => $1::text
{ jsonb: {...} }  // => $1::jsonb (auto-stringified)

// null is null
null              // => NULL
```

### Identifier Quoting

By default every identifier is quoted — exact semantics, immune to reserved
words, case folding, and injection through identifier position:

```typescript
format({ select: ["id"], from: "users" });
// SELECT "id" FROM "users"
```

Pass `quoted: false` for quote-only-when-necessary output (reserved words,
mixed case, and special characters stay quoted — bare lowercase names don't):

```typescript
format({ select: ["id", "select", "createdAt"], from: "users" }, { quoted: false });
// SELECT id, "select", "createdAt" FROM users
```

Two rules worth knowing:

- A plain string that doesn't *look* like an identifier (`"user name"`) is
  treated as a **value**, not a column — use `ident("user name")` to reference
  an exotic column name. `ident()` always quotes exactly and doubles any
  embedded quotes.
- Dots in plain strings split into qualified parts (`"u.id"` → `"u"."id"`);
  `ident("weird.name")` keeps the dot inside one identifier.

### Expressions (Arrays)

```typescript
// [operator, ...args]
["=", "id", { $: 1 }]                    // id = $1
["and", expr1, expr2]                    // (expr1) AND (expr2)
["or", expr1, expr2]                     // (expr1) OR (expr2)
["in", "status", [{ $: "a" }, { $: "b" }]] // status IN ($1, $2)
["between", "age", { $: 18 }, { $: 65 }]   // age BETWEEN $1 AND $2
["like", "name", { $: "A%" }]            // name LIKE $1
["is", "deleted_at", null]               // deleted_at IS NULL
["is-not", "email", null]                // email IS NOT NULL

// Functions use % prefix
["%count", "*"]                          // COUNT(*)
["%sum", "amount"]                       // SUM(amount)
["%coalesce", "name", { $: "Unknown" }]  // COALESCE(name, $1)

// Aliased expressions
[["%count", "*"], "total"]               // COUNT(*) AS total
```

### Clause Maps

```typescript
// SELECT
{ select: ["id", "name"] }
{ "select-distinct": ["status"] }
{ "select-distinct-on": [["user_id"], "*"] }

// FROM with alias
{ from: [["users", "u"]] }

// JOINs
{ join: [[["orders", "o"], ["=", "u.id", "o.user_id"]]] }
{ "left-join": [[...]] }

// WHERE (multiple calls AND together)
{ where: ["=", "active", { $: true }] }

// GROUP BY / HAVING
{ "group-by": ["status"] }
{ having: [">", ["%count", "*"], { $: 5 }] }

// ORDER BY
{ "order-by": [["created_at", "desc"], ["id", "asc"]] }

// LIMIT / OFFSET
{ limit: { $: 10 }, offset: { $: 20 } }

// INSERT
{ "insert-into": "users", columns: ["name", "email"], values: [[{ $: "Alice" }, { $: "a@b.com" }]] }

// UPDATE
{ update: "users", set: { name: { $: "Bob" } }, where: ["=", "id", { $: 1 }] }

// DELETE
{ "delete-from": "users", where: ["=", "id", { $: 1 }] }

// WITH (CTE)
{ with: [["active_users", { select: ["*"], from: "users", where: [...] }]], select: ["*"], from: "active_users" }

// UNION
{ union: [{ select: [...], from: "a" }, { select: [...], from: "b" }] }
```

## Documentation

| Document | Description |
|----------|-------------|
| [Philosophy](docs/philosophy.md) | Design decisions and HoneySQL inspiration |
| [API Reference](docs/api-reference.md) | Complete API documentation |
| [LLM Integration](docs/llm-integration.md) | Using honey-ts with AI agents |
| [Production Readiness](docs/production-readiness.md) | Testing, security, known limitations |
| [Examples](docs/examples.md) | Recipes and patterns |
| [Clause Tree Walker](docs/clause-tree-walker.md) | Advanced recursive transformations |

## Testing

```bash
npm test
```

- **683 tests** covering parsing, formatting, round-trips, and dialect behavior
- **Property-based fuzzing** with fast-check, validated against a live DuckDB parser
- **DuckDB's own 23,675-statement test corpus** round-tripped in CI, with parse
  and acceptance rates locked in as regression floors
- Semantic spot-checks that *execute* original vs. round-tripped SQL on real
  data and compare results — catching meaning changes syntax checks can't see

## License

MIT

## Credits

Inspired by and ported from [HoneySQL](https://github.com/seancorfield/honeysql) by Sean Corfield.
