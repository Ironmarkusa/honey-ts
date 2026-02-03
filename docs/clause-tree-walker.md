# Clause Tree Walker

The clause tree walker is an advanced feature for recursively transforming SQL queries. It's essential for security patterns like tenant isolation where you need to inject conditions into **all** subqueries.

## The Problem

SQL queries can be arbitrarily nested:

```sql
SELECT * FROM orders
WHERE user_id IN (
  SELECT id FROM users
  WHERE department_id IN (
    SELECT id FROM departments
    WHERE org_id = 'org_123'
  )
)
```

If you only inject a tenant filter at the top level, subqueries bypass your security:

```typescript
// WRONG: Only adds filter to outer query
clause.where = ["and", clause.where, ["=", "tenant_id", { $: tenantId }]];
// The users and departments subqueries still lack tenant_id!
```

## The Solution

`walkClauses()` recursively visits every clause in the query tree:

```typescript
import { walkClauses } from 'honey-ts';

const secured = walkClauses(clause, (c) => {
  if (c.from) {
    // This clause queries a table—add tenant filter
    return {
      ...c,
      where: c.where
        ? ["and", c.where, ["=", "tenant_id", { $: tenantId }]]
        : ["=", "tenant_id", { $: tenantId }]
    };
  }
  return c;
});
```

## API

### `walkClauses(clause, transform)`

```typescript
function walkClauses(
  clause: SqlClause,
  transform: (c: SqlClause) => SqlClause
): SqlClause;
```

**Parameters:**
- `clause`: The root clause map to transform
- `transform`: Function called for each clause, returns transformed clause

**Visits:**
- Main query
- WITH / WITH RECURSIVE CTEs
- UNION / INTERSECT / EXCEPT branches
- Subqueries in FROM
- Subqueries in WHERE (IN, EXISTS, scalar)
- Scalar subqueries in SELECT
- Subqueries in HAVING

**Returns:** New clause tree with transforms applied

### `injectWhere(clause, condition)`

Convenience wrapper for the most common use case:

```typescript
function injectWhere(clause: SqlClause, condition: SqlExpr): SqlClause;
```

Injects the condition into all clauses that have `from`, `delete-from`, or `update`.

```typescript
const secured = injectWhere(clause, ["=", "tenant_id", { $: tenantId }]);
```

## How It Works

The walker traverses the clause tree depth-first:

```
1. Transform CTEs (WITH clauses)
2. Transform set operations (UNION, etc.)
3. Transform expressions (FROM, WHERE, SELECT, HAVING)
   - If expression contains a clause, recurse
4. Apply transform to current clause
5. Return transformed clause
```

Example traversal for:
```typescript
{
  with: [["active", { select: ["*"], from: "users" }]],
  select: ["*"],
  from: "active",
  where: ["in", "id", { select: ["id"], from: "orders" }]
}
```

Order of `transform()` calls:
1. CTE clause: `{ select: ["*"], from: "users" }`
2. Subquery in WHERE: `{ select: ["id"], from: "orders" }`
3. Main clause (with updated CTE and subquery)

## Examples

### Tenant Isolation

```typescript
import { fromSql, format, injectWhere } from 'honey-ts';

const llmSql = `
  SELECT * FROM orders
  WHERE user_id IN (SELECT id FROM users WHERE role = 'admin')
`;

const clause = fromSql(llmSql);
const secured = injectWhere(clause, ["=", "tenant_id", { $: "tenant_123" }]);
const [sql] = format(secured, { inline: true });

// Result: Both orders AND users have tenant_id filter
// SELECT * FROM orders WHERE (user_id IN (
//   SELECT id FROM users WHERE (role = 'admin') AND (tenant_id = 'tenant_123')
// )) AND (tenant_id = 'tenant_123')
```

### Soft Delete Filter

Automatically filter out soft-deleted records:

```typescript
const withSoftDelete = walkClauses(clause, (c) => {
  if (c.from) {
    const existingWhere = c.where;
    const softDeleteFilter = ["is", "deleted_at", null];
    return {
      ...c,
      where: existingWhere
        ? ["and", existingWhere, softDeleteFilter]
        : softDeleteFilter
    };
  }
  return c;
});
```

### Audit Logging

Collect all tables being queried:

```typescript
const tables: string[] = [];

walkClauses(clause, (c) => {
  if (typeof c.from === "string") {
    tables.push(c.from);
  } else if (Array.isArray(c.from)) {
    for (const f of c.from) {
      if (typeof f === "string") tables.push(f);
      if (Array.isArray(f) && typeof f[0] === "string") tables.push(f[0]);
    }
  }
  return c; // Return unchanged
});

console.log("Tables accessed:", tables);
```

### Table Allowlist Validation

```typescript
const allowedTables = new Set(["users", "orders", "products"]);

function validateAllowedTables(clause: SqlClause): void {
  walkClauses(clause, (c) => {
    if (typeof c.from === "string" && !allowedTables.has(c.from)) {
      throw new Error(`Unauthorized table: ${c.from}`);
    }
    if (Array.isArray(c.from)) {
      for (const f of c.from) {
        const tableName = typeof f === "string" ? f :
                          (Array.isArray(f) && typeof f[0] === "string") ? f[0] : null;
        if (tableName && !allowedTables.has(tableName)) {
          throw new Error(`Unauthorized table: ${tableName}`);
        }
      }
    }
    return c;
  });
}
```

### Automatic Row-Level Security

```typescript
function applyRLS(clause: SqlClause, userId: string): SqlClause {
  return walkClauses(clause, (c) => {
    // Different tables have different RLS rules
    if (c.from === "user_data") {
      return merge(c, where(["=", "owner_id", { $: userId }]));
    }
    if (c.from === "shared_data") {
      return merge(c, where(["or",
        ["=", "owner_id", { $: userId }],
        ["=", "public", { $: true }]
      ]));
    }
    return c;
  });
}
```

### Query Complexity Limiting

```typescript
function validateComplexity(clause: SqlClause, maxSubqueries: number): void {
  let subqueryCount = 0;

  walkClauses(clause, (c) => {
    subqueryCount++;
    if (subqueryCount > maxSubqueries) {
      throw new Error(`Query too complex: ${subqueryCount} subqueries (max: ${maxSubqueries})`);
    }
    return c;
  });
}
```

## Handling Expression Trees

`walkClauses` only visits clause maps, not arbitrary expressions. For deep expression inspection, you may need custom traversal:

```typescript
function walkExpr(expr: SqlExpr, visitor: (e: SqlExpr) => void): void {
  visitor(expr);

  if (Array.isArray(expr)) {
    for (const item of expr) {
      walkExpr(item as SqlExpr, visitor);
    }
  } else if (typeof expr === "object" && expr !== null) {
    // Could be a clause (subquery)
    if ("select" in expr || "from" in expr) {
      walkClauses(expr as SqlClause, (c) => {
        // Visit expressions within this clause
        if (c.where) walkExpr(c.where as SqlExpr, visitor);
        if (c.select) {
          const selects = Array.isArray(c.select) ? c.select : [c.select];
          for (const s of selects) walkExpr(s as SqlExpr, visitor);
        }
        return c;
      });
    }
  }
}

// Usage: Find all column references
const columns: string[] = [];
walkExpr(clause.where, (e) => {
  if (typeof e === "string" && !e.startsWith("%")) {
    columns.push(e);
  }
});
```

## Performance Considerations

- `walkClauses` creates new objects (immutable transformation)
- For very deep nesting, consider stack depth
- Caching results is safe since transformations are pure

## Debugging

Log all transformations:

```typescript
const secured = walkClauses(clause, (c) => {
  console.log("Visiting clause:", JSON.stringify(c, null, 2));
  const transformed = addTenantFilter(c);
  console.log("Transformed to:", JSON.stringify(transformed, null, 2));
  return transformed;
});
```

## Best Practices

1. **Always return a clause** from your transform function, even if unchanged
2. **Don't mutate** the input clause—create new objects
3. **Order matters**: Transform is called after children are processed
4. **Test with complex queries**: Include CTEs, UNIONs, nested subqueries
5. **Combine with validation**: First validate, then transform

```typescript
// Recommended pattern
function secureQuery(sql: string, tenantId: string): [string, unknown[]] {
  const clause = fromSql(sql);

  // Validate first
  validateAllowedTables(clause);
  validateComplexity(clause, 10);

  // Then transform
  const secured = injectWhere(clause, ["=", "tenant_id", { $: tenantId }]);

  // Format and return
  return format(secured);
}
```
