# Philosophy

## Data as SQL

honey-ts follows HoneySQL's core philosophy: **SQL is data**. Instead of concatenating strings or using a method-chaining DSL, you represent SQL queries as plain JavaScript data structures.

```typescript
// This IS your query
const query = {
  select: ["id", "name"],
  from: "users",
  where: ["=", "active", { $: true }]
};
```

This isn't a builder that creates SQL—it's the query itself. The data structure is the source of truth.

## Why Data Structures?

### 1. Composability

Data structures compose naturally:

```typescript
const baseQuery = { select: ["*"], from: "users" };
const withFilter = { ...baseQuery, where: ["=", "active", { $: true }] };
const paginated = { ...withFilter, limit: { $: 10 }, offset: { $: 0 } };
```

No special merge functions needed—just spread syntax.

### 2. Inspectability

You can examine and modify queries programmatically:

```typescript
if (clause.where) {
  console.log("Query has WHERE clause:", clause.where);
}

// Add a condition
clause.where = ["and", clause.where, ["=", "tenant_id", { $: id }]];
```

### 3. Serializability

Clause maps are JSON-serializable. You can:
- Store queries in databases
- Send them over the network
- Cache them
- Log them for debugging

### 4. Testability

Testing is straightforward—just compare objects:

```typescript
expect(buildUserQuery()).toEqual({
  select: ["id", "name"],
  from: "users"
});
```

## Inspiration: HoneySQL

[HoneySQL](https://github.com/seancorfield/honeysql) is a Clojure library that pioneered this approach. Created by Sean Corfield, it has been battle-tested in production for years.

Key concepts borrowed from HoneySQL:

### Maps for Statements
```clojure
;; Clojure HoneySQL
{:select [:id :name]
 :from :users
 :where [:= :active true]}
```

```typescript
// TypeScript honey-ts
{
  select: ["id", "name"],
  from: "users",
  where: ["=", "active", { $: true }]
}
```

### Arrays for Expressions

The first element is the operator, rest are arguments:

```typescript
["=", "id", { $: 1 }]           // id = $1
["and", expr1, expr2, expr3]    // expr1 AND expr2 AND expr3
["%count", "*"]                 // COUNT(*)
["between", "x", { $: 1 }, { $: 10 }]  // x BETWEEN $1 AND $2
```

### Function Prefix

Functions use `%` prefix to distinguish from operators:

```typescript
["%count", "*"]         // COUNT(*)
["%lower", "name"]      // LOWER(name)
["%coalesce", "x", "y"] // COALESCE(x, y)
```

## Departures from HoneySQL

### Clean Syntax (No Legacy)

HoneySQL supports both `:keyword` and "string" identifiers for backwards compatibility. honey-ts uses a clean, single syntax:

```typescript
// Plain strings are identifiers
"id", "users", "u.id"

// Values must be wrapped
{ $: "active" }    // parameterized value
{ text: "hello" }  // typed/cast value
```

### TypeScript Types

Full TypeScript support with discriminated unions:

```typescript
type SqlExpr =
  | string           // identifier
  | number           // literal
  | boolean          // literal
  | null             // NULL
  | SqlExpr[]        // expression
  | SqlClause;       // subquery

interface SqlClause {
  select?: SqlExpr[];
  from?: SqlExpr;
  where?: SqlExpr;
  // ...
}
```

### PostgreSQL Focus

While HoneySQL supports multiple SQL dialects, honey-ts focuses on PostgreSQL:
- Numbered parameters (`$1`, `$2`) by default
- PostgreSQL operators registered via `import 'honey-ts/pg-ops'`
- Parser uses `pgsql-ast-parser`

### Bidirectional Conversion

HoneySQL is primarily clause → SQL. honey-ts adds SQL → clause:

```typescript
// Both directions
const sql = toSql(clause);
const clause = fromSql(sql);

// Round-trip preserves semantics
toSql(fromSql(sql)) ≡ normalize(sql)
```

## Design Decisions

### Why `{$: value}` for Values?

We considered several syntaxes:

```typescript
// Option 1: Prefix (like HoneySQL keywords)
":active"  // confusing in TypeScript

// Option 2: Wrapper function
val("active")  // creates objects, verbose

// Option 3: Object wrapper ✓
{ $: "active" }  // clear, serializable, minimal
```

The `{$: value}` syntax:
- Is valid JSON
- Clearly marks values vs identifiers
- Supports type casting: `{text: "hello"}` → `$1::text`

### Why Not Method Chaining?

Method chaining obscures the data:

```typescript
// Method chaining - the query is hidden inside the builder
query.select("id").from("users").where("active", true)

// Data structure - the query IS the data
{ select: ["id"], from: "users", where: ["=", "active", { $: true }] }
```

With data structures, you always have direct access to the query shape.

### Why Parse SQL?

The primary use case is LLM integration:

1. LLMs generate SQL strings naturally
2. Parsing to clause maps enables programmatic modification
3. Critical for security: inject tenant filters, auth checks
4. Round-trip back to safe, parameterized SQL

## Trade-offs

### Verbosity

Clause maps are more verbose than raw SQL for simple queries:

```sql
SELECT id FROM users WHERE active
```

```typescript
{
  select: ["id"],
  from: "users",
  where: ["=", "active", { $: true }]
}
```

This is intentional—the structure makes programmatic manipulation possible.

### Learning Curve

Developers familiar with SQL must learn the clause map structure. The mapping is mostly 1:1, but some constructs (like expressions) take getting used to.

### Parser Limitations

The SQL parser (`pgsql-ast-parser`) doesn't support every PostgreSQL feature. See [Production Readiness](production-readiness.md) for known limitations.

## When to Use honey-ts

**Good fit:**
- LLM-generated SQL with security requirements
- Dynamic query building with complex conditions
- Multi-tenant applications needing tenant isolation
- Applications that need to inspect/modify queries programmatically

**Not ideal:**
- Static, hand-written SQL queries
- Performance-critical paths where string concatenation is faster
- SQL features not supported by the parser
