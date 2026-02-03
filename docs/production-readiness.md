# Production Readiness

## Current Status

**honey-ts is ready for production use** with the following caveats:

1. **Focused scope**: Designed for LLM SQL integration, not as a general-purpose ORM
2. **Parser limitations**: Some advanced PostgreSQL syntax not supported
3. **PostgreSQL only**: Other databases not tested

## Testing

### Test Coverage

- **108 unit tests** covering core functionality
- **~5,500 generated SQL statements** via property-based testing
- **Round-trip validation**: `toSql(fromSql(sql)) === normalize(sql)`

### Test Categories

| Category | Tests | Description |
|----------|-------|-------------|
| Basic formatting | ~20 | SELECT, INSERT, UPDATE, DELETE |
| Parser round-trips | ~35 | Edge cases: CTEs, window functions, LATERAL, etc. |
| Property-based | ~50+ | Randomly generated valid clause maps |
| Stress tests | 3 | 1000 basic + 500 advanced + 2000 mixed statements |

### Running Tests

```bash
npm test
```

All tests use Node.js built-in test runner with `fast-check` for property-based testing.

## Security

### Parameterization

**SQL injection is prevented** by default:

```typescript
const [sql, ...params] = format({
  select: ["*"],
  from: "users",
  where: ["=", "name", { $: userInput }]
});
// sql: "SELECT * FROM users WHERE name = $1"
// params: [userInput]  // Safe!
```

Values wrapped in `{$: value}` become numbered parameters. The `inline: true` option should only be used for debugging.

### Input Validation

honey-ts validates:
- Identifiers don't contain suspicious characters (`;`)
- Empty `IN` clauses rejected in strict mode
- Unknown clause keys throw errors

It does **not** validate:
- Table/column existence
- User authorization
- Business logic

You must implement application-level security:

```typescript
// You must implement these checks
validateAllowedTables(clause);
validateUserPermissions(clause, currentUser);
injectTenantFilter(clause, tenantId);
```

### Tenant Isolation

Use `injectWhere()` to inject tenant filters:

```typescript
const secured = injectWhere(clause, ["=", "tenant_id", { $: tenantId }]);
```

This recursively adds the filter to:
- Main query
- CTEs (WITH clauses)
- Subqueries in FROM
- Subqueries in WHERE (IN, EXISTS)
- Scalar subqueries in SELECT
- UNION/INTERSECT/EXCEPT

## Known Limitations

### Parser Limitations

The SQL parser (`pgsql-ast-parser`) doesn't support every PostgreSQL feature:

| Feature | Status | Notes |
|---------|--------|-------|
| Basic SELECT/INSERT/UPDATE/DELETE | ✅ | Fully supported |
| JOINs (all types) | ✅ | INNER, LEFT, RIGHT, FULL, CROSS |
| Subqueries | ✅ | FROM, WHERE, SELECT |
| CTEs (WITH) | ✅ | Including RECURSIVE |
| Window functions | ✅ | OVER (PARTITION BY ... ORDER BY ...) |
| LATERAL | ✅ | Supported |
| ON CONFLICT | ✅ | DO NOTHING, DO UPDATE SET |
| UNION/INTERSECT/EXCEPT | ✅ | Basic support |
| DISTINCT ON | ✅ | PostgreSQL-specific |
| ARRAY constructors | ✅ | ARRAY[1, 2, 3] |
| JSON operators | ✅ | ->, ->>, @>, etc. |
| CASE expressions | ✅ | Both forms |
| BETWEEN | ✅ | Including NOT BETWEEN |
| LIKE/ILIKE | ✅ | Pattern matching |
| Window frames | ⚠️ | ROWS BETWEEN not preserved in round-trip |
| GROUPING SETS | ⚠️ | Basic CUBE/ROLLUP only |
| DELETE USING | ❌ | Not supported |
| MERGE | ❌ | Not supported |
| CREATE/ALTER/DROP | ⚠️ | Basic support, not comprehensive |

### Round-Trip Fidelity

Round-tripping preserves **semantics** but not always **syntax**:

```typescript
// Input SQL
"SELECT id FROM users WHERE x = 1 AND y = 2"

// After round-trip might become
"SELECT id FROM users WHERE (x = 1) AND (y = 2)"
```

Differences that are acceptable:
- Extra parentheses
- Whitespace changes
- Keyword capitalization
- `ASC` being omitted (it's the default)

### TypeScript Types

Type inference is limited. Clause maps are typed but not fully discriminated:

```typescript
const clause: SqlClause = { select: ["*"], from: "users" };
// TypeScript doesn't know this is a SELECT query
```

## Performance

### Parsing

SQL parsing is fast but not free:
- Simple queries: <1ms
- Complex queries with subqueries: ~5ms
- Extremely complex queries: ~20ms

For hot paths, consider caching parsed clauses.

### Formatting

Formatting is consistently fast:
- Simple queries: <0.5ms
- Complex queries: <2ms

### Memory

Clause maps are plain objects—memory usage is minimal.

## Recommendations

### Do

- Use for LLM-generated SQL that needs security transforms
- Use `injectWhere()` for tenant isolation
- Validate tables/columns before executing
- Use parameterization (default behavior)
- Add application-level authorization checks

### Don't

- Use for performance-critical paths without benchmarking
- Rely solely on honey-ts for security (add your own validation)
- Use `inline: true` in production
- Expect perfect round-trip fidelity for edge-case SQL

## Monitoring

Consider logging:

```typescript
const clause = fromSql(llmSql);
const [sql, ...params] = format(clause);

logger.info("Executing query", {
  originalSql: llmSql,
  parsedClause: clause,
  finalSql: sql,
  paramCount: params.length,
});
```

## Migration Path

If you later need features honey-ts doesn't support:

1. **Raw SQL fallback**: Use `raw()` for unsupported constructs
2. **Hybrid approach**: Use honey-ts for most queries, raw SQL for edge cases
3. **Fork**: The codebase is small (~2000 LOC) and MIT licensed

## Version Stability

honey-ts follows semantic versioning:

- **Patch** (0.1.x): Bug fixes, parser improvements
- **Minor** (0.x.0): New features, non-breaking changes
- **Major** (x.0.0): Breaking API changes

The core API (`format`, `fromSql`, `injectWhere`) is stable. Builder helpers may evolve.

## Getting Help

1. Check [examples](examples.md) for common patterns
2. Review [API reference](api-reference.md) for function details
3. Open an issue on GitHub for bugs or feature requests
