# Examples

## Basic Queries

### Simple SELECT

```typescript
import { format } from 'honey-ts';

const query = {
  select: ["id", "name", "email"],
  from: "users",
  where: ["=", "active", { $: true }]
};

const [sql, ...params] = format(query);
// SELECT id, name, email FROM users WHERE active = $1
// params: [true]
```

### SELECT with Multiple Conditions

```typescript
const query = {
  select: ["*"],
  from: "orders",
  where: ["and",
    ["=", "status", { $: "completed" }],
    [">", "total", { $: 100 }],
    ["<", "created_at", { $: new Date("2024-01-01") }]
  ]
};
```

### SELECT with JOIN

```typescript
const query = {
  select: ["u.id", "u.name", "o.total"],
  from: [["users", "u"]],
  join: [
    [["orders", "o"], ["=", "u.id", "o.user_id"]]
  ],
  where: ["=", "o.status", { $: "completed" }]
};
```

### SELECT with LEFT JOIN

```typescript
const query = {
  select: ["u.name", ["%count", "o.id"]],
  from: [["users", "u"]],
  "left-join": [
    [["orders", "o"], ["=", "u.id", "o.user_id"]]
  ],
  "group-by": ["u.id", "u.name"]
};
```

### SELECT with Subquery in FROM

```typescript
const query = {
  select: ["*"],
  from: [[
    { select: ["*"], from: "users", where: ["=", "active", { $: true }] },
    "active_users"
  ]]
};
```

### SELECT with Subquery in WHERE

```typescript
const query = {
  select: ["*"],
  from: "orders",
  where: ["in", "user_id", {
    select: ["id"],
    from: "users",
    where: ["=", "role", { $: "premium" }]
  }]
};
```

### SELECT with EXISTS

```typescript
const query = {
  select: ["*"],
  from: [["users", "u"]],
  where: ["%exists", {
    select: [{ $: 1 }],
    from: [["orders", "o"]],
    where: ["=", "o.user_id", "u.id"]
  }]
};
```

---

## Aggregations

### COUNT with GROUP BY

```typescript
const query = {
  select: ["status", [["%count", "*"], "count"]],
  from: "orders",
  "group-by": ["status"]
};
// SELECT status, COUNT(*) AS count FROM orders GROUP BY status
```

### Multiple Aggregates

```typescript
const query = {
  select: [
    "category",
    [["%count", "*"], "total"],
    [["%sum", "amount"], "total_amount"],
    [["%avg", "amount"], "avg_amount"]
  ],
  from: "transactions",
  "group-by": ["category"],
  "order-by": [["%count", "*"], "desc"]
};
```

### HAVING Clause

```typescript
const query = {
  select: ["user_id", [["%count", "*"], "order_count"]],
  from: "orders",
  "group-by": ["user_id"],
  having: [">", ["%count", "*"], { $: 10 }]
};
```

### COUNT DISTINCT

```typescript
const query = {
  select: [
    "department",
    [["%count-distinct", "user_id"], "unique_users"]
  ],
  from: "orders",
  "group-by": ["department"]
};
// SELECT department, COUNT(DISTINCT user_id) AS unique_users FROM orders GROUP BY department
```

### FILTER Clause (PostgreSQL)

```typescript
const query = {
  select: [
    [["%count", "*"], "total"],
    [["filter", ["%count", "*"], ["=", "status", { $: "active" }]], "active_count"],
    [["filter", ["%count", "*"], ["=", "status", { $: "pending" }]], "pending_count"]
  ],
  from: "users"
};
```

---

## Window Functions

### ROW_NUMBER

```typescript
const query = {
  select: [
    "id",
    "name",
    [["over", ["%row_number"], { "order-by": [["created_at", "asc"]] }], "rn"]
  ],
  from: "users"
};
// SELECT id, name, ROW_NUMBER() OVER (ORDER BY created_at) AS rn FROM users
```

### Partitioned Window Function

```typescript
const query = {
  select: [
    "department",
    "name",
    "salary",
    [["over", ["%rank"], {
      "partition-by": ["department"],
      "order-by": [["salary", "desc"]]
    }], "salary_rank"]
  ],
  from: "employees"
};
```

### Running Total

```typescript
const query = {
  select: [
    "id",
    "amount",
    [["over", ["%sum", "amount"], {
      "order-by": [["id", "asc"]]
    }], "running_total"]
  ],
  from: "transactions"
};
```

---

## CTEs (WITH Clauses)

### Simple CTE

```typescript
const query = {
  with: [
    ["active_users", {
      select: ["*"],
      from: "users",
      where: ["=", "active", { $: true }]
    }]
  ],
  select: ["*"],
  from: "active_users"
};
```

### Multiple CTEs

```typescript
const query = {
  with: [
    ["recent_orders", {
      select: ["*"],
      from: "orders",
      where: [">", "created_at", { $: new Date("2024-01-01") }]
    }],
    ["high_value", {
      select: ["*"],
      from: "recent_orders",
      where: [">", "total", { $: 1000 }]
    }]
  ],
  select: ["*"],
  from: "high_value"
};
```

### Recursive CTE

```typescript
const query = {
  "with-recursive": [
    ["nums", {
      union: [
        { select: [{ $: 1 }] },
        {
          select: [["+", "n", { $: 1 }]],
          from: "nums",
          where: ["<", "n", { $: 10 }]
        }
      ]
    }]
  ],
  select: ["*"],
  from: "nums"
};
```

---

## INSERT

### Basic INSERT

```typescript
const query = {
  "insert-into": "users",
  columns: ["name", "email"],
  values: [[{ $: "Alice" }, { $: "alice@example.com" }]]
};
```

### INSERT Multiple Rows

```typescript
const query = {
  "insert-into": "users",
  columns: ["name", "email"],
  values: [
    [{ $: "Alice" }, { $: "alice@example.com" }],
    [{ $: "Bob" }, { $: "bob@example.com" }]
  ]
};
```

### INSERT with RETURNING

```typescript
const query = {
  "insert-into": "users",
  columns: ["name", "email"],
  values: [[{ $: "Alice" }, { $: "alice@example.com" }]],
  returning: ["id", "created_at"]
};
```

### UPSERT (ON CONFLICT)

```typescript
const query = {
  "insert-into": "users",
  columns: ["id", "name", "email"],
  values: [[{ $: 1 }, { $: "Alice" }, { $: "alice@example.com" }]],
  "on-conflict": ["id"],
  "do-update-set": {
    name: "excluded.name",
    email: "excluded.email"
  }
};
```

### ON CONFLICT DO NOTHING

```typescript
const query = {
  "insert-into": "users",
  columns: ["email", "name"],
  values: [[{ $: "alice@example.com" }, { $: "Alice" }]],
  "on-conflict": ["email"],
  "do-nothing": true
};
```

---

## UPDATE

### Basic UPDATE

```typescript
const query = {
  update: "users",
  set: {
    name: { $: "New Name" },
    updated_at: ["%now"]
  },
  where: ["=", "id", { $: 1 }]
};
```

### UPDATE with Expression

```typescript
const query = {
  update: "products",
  set: {
    stock: ["-", "stock", { $: 1 }],  // stock = stock - 1
    updated_at: ["%now"]
  },
  where: ["=", "id", { $: productId }]
};
```

### UPDATE with RETURNING

```typescript
const query = {
  update: "users",
  set: { status: { $: "active" } },
  where: ["=", "id", { $: 1 }],
  returning: ["*"]
};
```

---

## DELETE

### Basic DELETE

```typescript
const query = {
  "delete-from": "users",
  where: ["=", "id", { $: 1 }]
};
```

### DELETE with RETURNING

```typescript
const query = {
  "delete-from": "sessions",
  where: ["<", "expires_at", ["%now"]],
  returning: ["user_id"]
};
```

---

## UNION / INTERSECT / EXCEPT

### UNION

```typescript
const query = {
  union: [
    { select: ["id", "name"], from: "users", where: ["=", "role", { $: "admin" }] },
    { select: ["id", "name"], from: "users", where: ["=", "role", { $: "moderator" }] }
  ]
};
```

### UNION ALL

```typescript
const query = {
  "union-all": [
    { select: ["id"], from: "table_a" },
    { select: ["id"], from: "table_b" }
  ]
};
```

---

## PostgreSQL Specific

### JSON/JSONB Operations

```typescript
import 'honey-ts/pg-ops';

// Get JSON field
const query = {
  select: [["->>", "data", { $: "name" }]],
  from: "users"
};

// JSON contains
const query2 = {
  select: ["*"],
  from: "products",
  where: ["@>", "metadata", { jsonb: { featured: true } }]
};
```

### Array Operations

```typescript
const query = {
  select: ["*"],
  from: "posts",
  where: ["&&", "tags", ["array", { $: "typescript" }, { $: "sql" }]]
};
// WHERE tags && ARRAY['typescript', 'sql']
```

### Full-Text Search

```typescript
const query = {
  select: ["*"],
  from: "articles",
  where: ["@@", "search_vector", ["%to_tsquery", { $: "typescript & database" }]]
};
```

### LATERAL Subquery

```typescript
const query = {
  select: ["u.id", "recent.total"],
  from: [
    [["users", "u"]],
    [["lateral", {
      select: [["%sum", "amount"], "total"],
      from: "orders",
      where: ["=", "user_id", "u.id"],
      "order-by": [["created_at", "desc"]],
      limit: { $: 5 }
    }], "recent"]
  ]
};
```

---

## Security Patterns

### Tenant Isolation

```typescript
import { fromSql, format, injectWhere } from 'honey-ts';

const llmSql = "SELECT * FROM orders WHERE total > 100";
const clause = fromSql(llmSql);
const secured = injectWhere(clause, ["=", "tenant_id", { $: currentTenantId }]);
const [sql, ...params] = format(secured);
```

### Whitelist Tables

```typescript
import { walkClauses } from 'honey-ts';

const allowedTables = new Set(["users", "orders", "products"]);

function validateTables(clause: SqlClause): boolean {
  let valid = true;
  walkClauses(clause, (c) => {
    if (typeof c.from === "string" && !allowedTables.has(c.from)) {
      valid = false;
    }
    return c;
  });
  return valid;
}
```

### Read-Only Enforcement

```typescript
function ensureReadOnly(clause: SqlClause): void {
  if (clause.update || clause["delete-from"] || clause["insert-into"]) {
    throw new Error("Only SELECT queries allowed");
  }
}
```
