/**
 * Validates SQL against a real DuckDB instance.
 *
 * Test-only: this module depends on @duckdb/node-api, which is a devDependency,
 * and is deliberately not re-exported from index.ts. Importing it from library
 * code would make DuckDB a runtime dependency of honey-ts.
 *
 * We validate with PREPARE rather than by executing, because the corpus refers
 * to thousands of tables that do not exist here. PREPARE runs the parser and
 * then the binder, so a "Parser Error" means the SQL is genuinely malformed
 * while a Binder/Catalog error only means the table is missing — which is
 * exactly the distinction a syntax-level oracle needs.
 */

export interface SyntaxCheck {
  valid: boolean;
  /** Parser error message, when the statement is malformed. */
  error?: string;
}

interface Conn {
  run(sql: string): Promise<unknown>;
}

let connPromise: Promise<Conn> | null = null;

async function connect(): Promise<Conn> {
  if (!connPromise) {
    connPromise = (async () => {
      const { DuckDBInstance } = await import("@duckdb/node-api");
      const instance = await DuckDBInstance.create(":memory:");
      return (await instance.connect()) as unknown as Conn;
    })();
  }
  return connPromise;
}

/** The DuckDB version backing the oracle. */
export async function duckdbVersion(): Promise<string> {
  const conn = await connect();
  const result = (await conn.run("SELECT version() AS v")) as {
    getRowObjectsJson(): Promise<Array<{ v: string }>>;
  };
  return (await result.getRowObjectsJson())[0]!.v;
}

/**
 * Check that DuckDB's parser accepts a statement. Missing tables and type
 * mismatches are not failures — only parse errors are.
 */
export async function checkSyntax(sql: string): Promise<SyntaxCheck> {
  const conn = await connect();
  try {
    await conn.run(`PREPARE _honey_check AS ${sql}`);
    await conn.run("DEALLOCATE _honey_check");
    return { valid: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/^Parser Error|syntax error/i.test(message)) {
      return { valid: false, error: message.split("\n")[0] ?? message };
    }
    // Binder/Catalog/Conversion errors: parsed fine, just unresolvable here.
    return { valid: true };
  }
}

/** Check many statements, returning only the ones DuckDB's parser rejects. */
export async function findSyntaxErrors(
  statements: string[]
): Promise<Array<{ sql: string; error: string }>> {
  const failures: Array<{ sql: string; error: string }> = [];
  for (const sql of statements) {
    const check = await checkSyntax(sql);
    if (!check.valid) failures.push({ sql, error: check.error ?? "unknown" });
  }
  return failures;
}
