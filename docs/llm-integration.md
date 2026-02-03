# LLM Integration

honey-ts was designed specifically for LLM-powered SQL generation. This guide covers best practices for integrating honey-ts with AI agents.

## The Problem

LLMs are good at generating SQL, but string-based SQL has serious problems:

1. **Injection risk**: LLM output might contain unintended SQL
2. **Authorization bypass**: Generated queries might access unauthorized data
3. **Validation difficulty**: Hard to verify correctness before execution
4. **Modification challenges**: Adding tenant filters to string SQL is fragile

## The Solution

Use honey-ts as a bridge:

```
LLM generates SQL → Parse to clause map → Transform → Format back to SQL → Execute
```

## Workflow Options

### Option 1: LLM Generates SQL String

The simplest approach—let the LLM generate standard SQL:

```typescript
import { fromSql, format, injectWhere } from 'honey-ts';

// LLM generates SQL
const llmSql = await llm.generate("Write SQL to get all orders for user 123");
// "SELECT * FROM orders WHERE user_id = 123"

// Parse to structured form
const clause = fromSql(llmSql);

// Inject tenant isolation
const secured = injectWhere(clause, ["=", "tenant_id", { $: currentTenantId }]);

// Format with parameterization
const [sql, ...params] = format(secured);
// "SELECT * FROM orders WHERE (user_id = $1) AND (tenant_id = $2)"
// [123, "tenant_xyz"]

// Execute safely
await db.query(sql, params);
```

**Pros:**
- LLMs are trained on SQL
- No special prompt engineering needed
- Works with any LLM

**Cons:**
- Parser limitations (some SQL constructs not supported)
- Extra parse/format round-trip

### Option 2: LLM Generates Clause Map

Train the LLM to output clause maps directly:

```typescript
// System prompt
const systemPrompt = `
You generate SQL queries as JSON clause maps. Format:
- Identifiers are plain strings: "users", "id", "u.name"
- Values use {$: value}: {$: "active"}, {$: 42}
- Expressions are arrays: ["=", "id", {$: 1}], ["and", expr1, expr2]
- Functions use % prefix: ["%count", "*"], ["%lower", "name"]

Example query:
{
  "select": ["id", "name"],
  "from": "users",
  "where": ["=", "status", {"$": "active"}],
  "order-by": [["created_at", "desc"]],
  "limit": {"$": 10}
}
`;

// LLM generates clause map
const response = await llm.generate(systemPrompt + "\n\nQuery: Get active users");
const clause = JSON.parse(response);

// Transform and execute
const secured = injectWhere(clause, ["=", "tenant_id", { $: currentTenantId }]);
const [sql, ...params] = format(secured);
```

**Pros:**
- No parsing needed
- Direct manipulation of structure
- Can validate schema with Zod

**Cons:**
- Requires prompt engineering
- LLMs less familiar with this format
- JSON syntax errors possible

### Option 3: Hybrid Approach

Let LLM generate SQL but validate by round-tripping:

```typescript
import { fromSql, format, normalizeSql } from 'honey-ts';

const llmSql = await llm.generate(prompt);

// Validate by round-tripping
const clause = fromSql(llmSql);
const [regeneratedSql] = format(clause, { inline: true, quoted: true });

// Compare normalized forms
const original = normalizeSql(llmSql);
const roundTripped = normalizeSql(regeneratedSql);

if (original !== roundTripped) {
  console.warn("SQL was transformed during parsing—may indicate unsupported syntax");
}

// Continue with secured query
const secured = injectWhere(clause, ["=", "tenant_id", { $: tenantId }]);
```

## Security Patterns

### Tenant Isolation

The killer feature—inject tenant filters into ALL subqueries:

```typescript
import { injectWhere, fromSql, format } from 'honey-ts';

// LLM might generate complex queries with subqueries
const llmSql = `
  SELECT * FROM orders
  WHERE user_id IN (
    SELECT id FROM users WHERE role = 'premium'
  )
  AND total > 100
`;

// Parse and inject tenant filter everywhere
const clause = fromSql(llmSql);
const secured = injectWhere(clause, ["=", "tenant_id", { $: tenantId }]);

const [sql] = format(secured, { inline: true });
// Both orders AND users subquery now have tenant_id filter
```

### Table Allowlisting

Restrict which tables can be queried:

```typescript
import { walkClauses } from 'honey-ts';

const allowedTables = new Set(["users", "orders", "products"]);

function validateTables(clause: SqlClause): void {
  walkClauses(clause, (c) => {
    if (c.from) {
      const tables = Array.isArray(c.from) ? c.from : [c.from];
      for (const t of tables) {
        const tableName = typeof t === "string" ? t : (Array.isArray(t) ? t[0] : null);
        if (tableName && !allowedTables.has(tableName)) {
          throw new Error(`Table not allowed: ${tableName}`);
        }
      }
    }
    return c;
  });
}

const clause = fromSql(llmSql);
validateTables(clause);  // throws if unauthorized table
```

### Column Blocklisting

Prevent access to sensitive columns:

```typescript
const blockedColumns = new Set(["password_hash", "ssn", "credit_card"]);

function validateColumns(clause: SqlClause): void {
  walkClauses(clause, (c) => {
    if (c.select && Array.isArray(c.select)) {
      for (const col of c.select) {
        if (typeof col === "string" && blockedColumns.has(col)) {
          throw new Error(`Column not allowed: ${col}`);
        }
      }
    }
    return c;
  });
}
```

### Statement Type Restriction

Only allow SELECT:

```typescript
function validateSelectOnly(clause: SqlClause): void {
  if (clause.update || clause["delete-from"] || clause["insert-into"]) {
    throw new Error("Only SELECT queries allowed");
  }
}
```

## Prompt Engineering Tips

When prompting LLMs to generate SQL for honey-ts:

### 1. Be Explicit About Tables

```
Available tables:
- users (id, name, email, tenant_id, created_at)
- orders (id, user_id, total, status, tenant_id, created_at)

Generate SQL to find users with orders over $100.
```

### 2. Request Parameterized Values

```
Use parameterized values for user input:
- Instead of: WHERE name = 'Alice'
- Use: WHERE name = $1 (parameter: 'Alice')
```

### 3. Avoid Unsupported Syntax

See [Production Readiness](production-readiness.md) for parser limitations. Prompt to avoid:

```
Do not use:
- Window frame specifications (ROWS BETWEEN)
- GROUPING SETS
- Recursive CTEs with complex anchor clauses
```

## Error Handling

```typescript
import { fromSql, format } from 'honey-ts';

async function executeLlmQuery(llmSql: string, tenantId: string) {
  try {
    // Parse
    const clause = fromSql(llmSql);

    // Validate
    validateTables(clause);
    validateSelectOnly(clause);

    // Secure
    const secured = injectWhere(clause, ["=", "tenant_id", { $: tenantId }]);

    // Execute
    const [sql, ...params] = format(secured);
    return await db.query(sql, params);

  } catch (error) {
    if (error.message.includes("syntax error")) {
      // Parse failed—LLM generated invalid SQL
      return { error: "Invalid SQL syntax", retry: true };
    }
    if (error.message.includes("not allowed")) {
      // Security validation failed
      return { error: "Unauthorized access attempt", retry: false };
    }
    throw error;
  }
}
```

## Testing LLM Integration

Property-based testing for security:

```typescript
import fc from 'fast-check';
import { injectWhere, walkClauses, format } from 'honey-ts';

// Test that tenant filter is always present
it("tenant filter injected into all subqueries", () => {
  fc.assert(fc.property(
    arbitraryClause,
    (clause) => {
      const secured = injectWhere(clause, ["=", "tenant_id", { $: "test" }]);

      // Verify every clause with FROM has the tenant filter
      walkClauses(secured, (c) => {
        if (c.from && c.where) {
          const sql = format(c, { inline: true })[0];
          expect(sql).toContain("tenant_id");
        }
        return c;
      });
    }
  ));
});
```

## Real-World Example

```typescript
import { fromSql, format, injectWhere, walkClauses } from 'honey-ts';

class SecureSqlExecutor {
  constructor(
    private db: Database,
    private allowedTables: Set<string>,
    private blockedColumns: Set<string>
  ) {}

  async executeUserQuery(
    sql: string,
    tenantId: string,
    userId: string
  ): Promise<QueryResult> {
    // Parse
    const clause = fromSql(sql);

    // Validate tables
    this.validateTables(clause);

    // Validate columns
    this.validateColumns(clause);

    // Ensure SELECT only
    this.validateSelectOnly(clause);

    // Inject tenant isolation
    let secured = injectWhere(clause, ["=", "tenant_id", { $: tenantId }]);

    // Optionally inject user filter for user-scoped data
    if (this.requiresUserScope(clause)) {
      secured = injectWhere(secured, ["=", "user_id", { $: userId }]);
    }

    // Format and execute
    const [sql, ...params] = format(secured);
    return this.db.query(sql, params);
  }

  private validateTables(clause: SqlClause): void { /* ... */ }
  private validateColumns(clause: SqlClause): void { /* ... */ }
  private validateSelectOnly(clause: SqlClause): void { /* ... */ }
  private requiresUserScope(clause: SqlClause): boolean { /* ... */ }
}
```

## Summary

1. **Parse LLM SQL** with `fromSql()`
2. **Validate** tables, columns, statement types
3. **Transform** with `injectWhere()` or `walkClauses()`
4. **Format** with `format()` for parameterized SQL
5. **Execute** safely

The key insight: by converting to structured data, you gain programmatic control over LLM-generated queries without trying to manipulate SQL strings.
