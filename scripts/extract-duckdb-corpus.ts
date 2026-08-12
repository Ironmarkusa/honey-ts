/**
 * Regenerates test/fixtures/duckdb-corpus.json from DuckDB's sqllogictest suite.
 *
 *   git clone --filter=blob:none --sparse --depth 1 https://github.com/duckdb/duckdb
 *   cd duckdb && git sparse-checkout set test/sql && cd ..
 *   npx tsx scripts/extract-duckdb-corpus.ts ./duckdb
 *
 * sqllogictest files interleave directives with SQL:
 *
 *     statement ok
 *     CREATE TABLE t(i INTEGER)
 *
 *     query I
 *     SELECT * FROM t
 *     ----
 *     1
 *
 * so a statement is everything between a `query`/`statement ok` directive and
 * the next directive or result separator.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "test", "fixtures", "duckdb-corpus.json"
);

/** Longer statements are dropped: they bloat the fixture without adding coverage. */
const MAX_LENGTH = 300;

const DIRECTIVE =
  /^(query|statement|halt|loop|endloop|foreach|require|mode|load|hash-threshold|concurrentloop|restart|sleep|reconnect)/;

function findTestFiles(root: string): string[] {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".test")) files.push(full);
    }
  })(root);
  return files;
}

function main() {
  const repo = process.argv[2];
  if (!repo) {
    console.error("usage: tsx scripts/extract-duckdb-corpus.ts <path-to-duckdb-repo>");
    process.exit(1);
  }

  const files = findTestFiles(join(repo, "test", "sql"));
  const seen = new Set<string>();
  const statements: Array<{ sql: string; kind: string }> = [];

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^(query\s+[IRTB?]+|statement ok)/.test(lines[i]!)) continue;

      const buffer: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]!;
        if (line.startsWith("----") || DIRECTIVE.test(line)) break;
        buffer.push(line);
      }

      const sql = buffer.join("\n").trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
      // Skip templated statements and paths that only mean something in-harness.
      if (!sql || sql.includes("${") || sql.includes("__TEST_DIR__")) continue;
      if (sql.length > MAX_LENGTH || seen.has(sql)) continue;
      seen.add(sql);

      const kind = /^\s*(SELECT|WITH|FROM)\b/i.test(sql)
        ? "select"
        : /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
          ? "dml"
          : null;
      if (kind) statements.push({ sql, kind });
    }
  }

  writeFileSync(
    OUT,
    JSON.stringify({
      source: "github.com/duckdb/duckdb test/sql/**/*.test (sqllogictest)",
      duckdbVersion: "v1.5.5",
      statements,
    })
  );

  const selects = statements.filter((s) => s.kind === "select").length;
  console.log(`Wrote ${OUT}`);
  console.log(`  source files : ${files.length}`);
  console.log(`  statements   : ${statements.length} (${selects} select, ${statements.length - selects} dml)`);
}

main();
