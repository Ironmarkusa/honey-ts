# API Reference

## Core Functions

### `format(clause, options?)`

Converts a clause map to a SQL string with parameters.

```typescript
import { format } from 'honey-ts';

const [sql, ...params] = format({
  select: ["id", "name"],
  from: "users",
  where: ["=", "active", { $: true }]
});
// sql: "SELECT id, name FROM users WHERE active = $1"
// params: [true]
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dialect` | `"postgres" \| "mysql" \| "sqlite" \| "ansi"` | `"postgres"` | SQL dialect for quoting |
| `quoted` | `boolean` | `false` (unless dialect set) | Quote all identifiers |
| `inline` | `boolean` | `false` | Inline values instead of parameters |
| `numbered` | `boolean` | `true` for postgres | Use `$1` instead of `?` |
| `pretty` | `boolean` | `false` | Add newlines between clauses |

**Aliases:** `toSql` is an alias for `format`.

---

### `fromSql(sql)`

Parses a SQL string into a clause map.

```typescript
import { fromSql } from 'honey-ts';

const clause = fromSql("SELECT id FROM users WHERE active = true");
// => { select: ["id"], from: "users", where: ["=", "active", { $: true }] }
```

Supports: SELECT, INSERT, UPDATE, DELETE, WITH (CTEs), UNION, subqueries.

---

### `fromSqlMulti(sql)`

Parses multiple SQL statements.

```typescript
import { fromSqlMulti } from 'honey-ts';

const clauses = fromSqlMulti("SELECT 1; SELECT 2");
// => [{ select: [{ $: 1 }] }, { select: [{ $: 2 }] }]
```

---

### `normalizeSql(sql)`

Normalizes SQL by parsing and reformatting. Useful for comparison.

```typescript
import { normalizeSql } from 'honey-ts';

normalizeSql("select ID from USERS") === normalizeSql("SELECT id FROM users")
// => true
```

---

## Builder Helpers

All helpers can take an existing clause as the first argument or create a new clause.

### SELECT

```typescript
import { select, selectDistinct, selectDistinctOn } from 'honey-ts';

select("id", "name")
// => { select: ["id", "name"] }

selectDistinct("status")
// => { "select-distinct": ["status"] }

selectDistinctOn(["user_id"], "*")
// => { "select-distinct-on": [["user_id"], "*"] }
```

### FROM

```typescript
import { from } from 'honey-ts';

from("users")
// => { from: "users" }

from(["users", "u"])  // with alias
// => { from: [["users", "u"]] }
```

### WHERE / HAVING

Multiple `where()` calls are combined with AND:

```typescript
import { where, having, merge } from 'honey-ts';

where(["=", "active", { $: true }])
// => { where: ["=", "active", { $: true }] }

// Combining
merge(
  where(["=", "a", { $: 1 }]),
  where(["=", "b", { $: 2 }])
)
// => { where: ["and", ["=", "a", { $: 1 }], ["=", "b", { $: 2 }]] }

having([">", ["%count", "*"], { $: 5 }])
// => { having: [">", ["%count", "*"], { $: 5 }] }
```

### JOIN

```typescript
import { join, leftJoin, rightJoin, innerJoin, fullJoin, crossJoin } from 'honey-ts';

join([["orders", "o"], ["=", "u.id", "o.user_id"]])
// => { join: [[["orders", "o"], ["=", "u.id", "o.user_id"]]] }

leftJoin([["profile", "p"], ["=", "u.id", "p.user_id"]])
// => { "left-join": [[["profile", "p"], ["=", "u.id", "p.user_id"]]] }
```

### GROUP BY / ORDER BY

```typescript
import { groupBy, orderBy } from 'honey-ts';

groupBy("status", "region")
// => { "group-by": ["status", "region"] }

orderBy(["created_at", "desc"], ["id", "asc"])
// => { "order-by": [["created_at", "desc"], ["id", "asc"]] }
```

### LIMIT / OFFSET

```typescript
import { limit, offset } from 'honey-ts';

limit({ $: 10 })
// => { limit: { $: 10 } }

offset({ $: 20 })
// => { offset: { $: 20 } }
```

### INSERT

```typescript
import { insertInto, values, columns } from 'honey-ts';

insertInto("users")
// => { "insert-into": "users" }

values([{ name: { $: "Alice" }, email: { $: "a@b.com" } }])
// => { values: [{ name: { $: "Alice" }, email: { $: "a@b.com" } }] }

columns("name", "email")
// => { columns: ["name", "email"] }
```

### UPDATE

```typescript
import { update, set } from 'honey-ts';

update("users")
// => { update: "users" }

set({ name: { $: "Bob" }, updated_at: ["%now"] })
// => { set: { name: { $: "Bob" }, updated_at: ["%now"] } }
```

### DELETE

```typescript
import { deleteFrom, del } from 'honey-ts';

deleteFrom("users")
// => { "delete-from": "users" }
```

### WITH (CTE)

```typescript
import { withCte, withRecursive } from 'honey-ts';

withCte(["active_users", { select: ["*"], from: "users", where: ["=", "active", { $: true }] }])
// => { with: [["active_users", { ... }]] }

withRecursive(["nums", { ... }])
// => { "with-recursive": [["nums", { ... }]] }
```

### UNION / INTERSECT / EXCEPT

```typescript
import { union, unionAll, intersect, except } from 'honey-ts';

union({ select: ["*"], from: "a" }, { select: ["*"], from: "b" })
// => { union: [{ ... }, { ... }] }
```

### ON CONFLICT (UPSERT)

```typescript
import { onConflict, doNothing, doUpdateSet } from 'honey-ts';

onConflict("id")
// => { "on-conflict": ["id"] }

doNothing()
// => { "do-nothing": true }

doUpdateSet({ name: "excluded.name" })
// => { "do-update-set": { name: "excluded.name" } }
```

### RETURNING

```typescript
import { returning } from 'honey-ts';

returning("*")
// => { returning: ["*"] }

returning("id", "created_at")
// => { returning: ["id", "created_at"] }
```

### FOR (Locking)

```typescript
import { forLock } from 'honey-ts';

forLock("update")
// => { for: ["update"] }

forLock("update", "nowait")
// => { for: ["update", "nowait"] }
```

---

## Composition

### `merge(...clauses)`

Merges multiple clause maps. WHERE clauses are combined with AND.

```typescript
import { merge, select, from, where, orderBy } from 'honey-ts';

const query = merge(
  select("id", "name"),
  from("users"),
  where(["=", "active", { $: true }]),
  where([">", "created_at", { $: new Date() }]),  // ANDed
  orderBy(["created_at", "desc"])
);
```

---

## Tree Walking

### `walkClauses(clause, transform)`

Recursively walks all clause nodes, applying a transform function. Handles CTEs, UNIONs, and subqueries.

```typescript
import { walkClauses } from 'honey-ts';

const transformed = walkClauses(clause, (c) => {
  // c is each clause in the tree (including subqueries)
  if (c.from) {
    // Add condition to all clauses with FROM
    return { ...c, where: ["and", c.where, ["=", "tenant", { $: id }]] };
  }
  return c;
});
```

### `injectWhere(clause, condition)`

Convenience wrapper that injects a WHERE condition into all queries.

```typescript
import { injectWhere } from 'honey-ts';

const secured = injectWhere(clause, ["=", "tenant_id", { $: tenantId }]);
```

---

## Special Expressions

### Raw SQL

```typescript
import { raw } from 'honey-ts';

raw("NOW() + INTERVAL '1 day'")
// Use in clause: { where: ["<", "expires_at", raw("NOW()")] }
```

### Lift (Prevent DSL Interpretation)

```typescript
import { lift } from 'honey-ts';

// Force array to be treated as value, not expression
lift([1, 2, 3])
```

### Parameter Reference

```typescript
import { param, format } from 'honey-ts';

const clause = { select: [param("user_name")], from: "users" };
format(clause, { params: { user_name: "Alice" } });
```

### Map Equals

```typescript
import { mapEquals } from 'honey-ts';

mapEquals({ status: "active", role: "admin" })
// => ["and", ["=", "status", "active"], ["=", "role", "admin"]]
```

---

## PostgreSQL Operators

Import `honey-ts/pg-ops` to register PostgreSQL-specific operators:

```typescript
import 'honey-ts/pg-ops';

// JSON operators
["->", "data", "name"]        // data -> 'name'
["->>", "data", "name"]       // data ->> 'name'
["@>", "data", { jsonb: {} }] // data @> '{}'::jsonb

// Array operators
["&&", "tags", ["array", "a", "b"]]  // tags && ARRAY['a', 'b']

// Regex
["~", "name", "^John"]        // name ~ '^John'
["~*", "name", "john"]        // name ~* 'john' (case-insensitive)

// Full-text search
["@@", "search_vector", ["%to_tsquery", { $: "hello & world" }]]
```

Helper functions:

```typescript
import { jsonbContains, jsonbPath, arrayOverlaps, regexMatch, textSearch } from 'honey-ts/pg-ops';

jsonbContains("data", { status: "active" })
jsonbPath("data", "user", "name")
arrayOverlaps("tags", ["typescript", "sql"])
regexMatch("email", "^[a-z]+@")
textSearch("search_vector", "hello & world")
```

---

## Types

```typescript
import type {
  SqlExpr,
  SqlClause,
  SqlIdent,
  SqlParam,
  SqlRaw,
  SqlLift,
  FormatResult,
  FormatOptions,
} from 'honey-ts';
```

### Type Guards

```typescript
import { isIdent, isParam, isRaw, isLift, isClause, isExprArray } from 'honey-ts';

isIdent("users")     // true
isIdent({ $: 1 })    // false
isClause({ select: ["*"] })  // true
```

### Zod Schemas

Runtime validation schemas:

```typescript
import { SqlClauseSchema, SqlExprSchema, FormatOptionsSchema } from 'honey-ts';

SqlClauseSchema.parse({ select: ["*"], from: "users" });
```

---

## Extension

### Register Custom Clause

```typescript
import { registerClause } from 'honey-ts';

registerClause("my-clause", (k, value, ctx) => {
  return [`MY CLAUSE ${value}`, /* params */];
}, "where");  // insert before "where" in clause order
```

### Register Custom Function

```typescript
import { registerFn } from 'honey-ts';

registerFn("my-fn", (k, args, ctx) => {
  return [`MY_FN(${args.join(", ")})`, /* params */];
});
```

### Register Custom Operator

```typescript
import { registerOp } from 'honey-ts';

registerOp("my-op");
// Now ["|>", a, b] works
```
