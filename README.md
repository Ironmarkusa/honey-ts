# honey-ts

**SQL as data structures for TypeScript** - A port of [HoneySQL](https://github.com/seancorfield/honeysql) for PostgreSQL.

```typescript
import { format, fromSql, injectWhere } from 'honey-ts';

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
const secured = injectWhere(clause, ["=", "tenant_id", { $: "tenant_123" }]);
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
3. **Inject tenant filters, auth checks** via `walkClauses()` or `injectWhere()`
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
import { fromSql, format, injectWhere } from 'honey-ts';

// LLM-generated SQL with subqueries
const llmSql = `
  SELECT * FROM orders
  WHERE user_id IN (SELECT id FROM users WHERE role = 'premium')
`;

// Parse and inject tenant filter into ALL queries (including subqueries!)
const clause = fromSql(llmSql);
const secured = injectWhere(clause, ["=", "tenant_id", { $: tenantId }]);

// Both orders and users tables now have tenant_id filter
const [sql, ...params] = format(secured);
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

- **108 tests** covering parsing, formatting, and round-trips
- **~5,500 generated SQL statements** via property-based testing with fast-check
- Deterministic round-trip validation: `toSql(fromSql(sql)) === normalize(sql)`

## License

MIT

## Credits

Inspired by and ported from [HoneySQL](https://github.com/seancorfield/honeysql) by Sean Corfield.
