/**
 * Generates src/duckdb-ops.generated.ts from DuckDB's own catalog.
 *
 * DuckDB ships its function catalog and keyword list as queryable table
 * functions, so the function metadata honey-ts exposes to UIs is generated from
 * the engine rather than hand-maintained. Regenerate after a DuckDB version
 * bump and review the diff:
 *
 *   npx tsx scripts/gen-duckdb-ops.ts
 *
 * @duckdb/node-api is a devDependency — nothing here ships in the package.
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "duckdb-ops.generated.ts");

/** Function types worth exposing in a query-building UI. */
const EXPOSED_TYPES = ["scalar", "aggregate", "macro"] as const;

interface RawFn {
  function_name: string;
  function_type: string;
  description: string | null;
  return_type: string | null;
  parameters: string[] | null;
  parameter_types: string[] | null;
  varargs: string | null;
  categories: string[] | null;
  examples: string[] | null;
}

interface Overload {
  args: Array<{ name: string; type: string }>;
  returnType: string;
  varargs: string | null;
}

async function main() {
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  const q = async <T>(sql: string): Promise<T[]> =>
    (await (await conn.run(sql)).getRowObjectsJson()) as T[];

  const version = (await q<{ v: string }>("SELECT version() AS v"))[0]!.v;

  // --- functions -----------------------------------------------------------
  const rows = await q<RawFn>(`
    SELECT function_name, function_type, description, return_type,
           parameters, parameter_types, varargs, categories, examples
    FROM duckdb_functions()
    WHERE internal = true
      AND function_type IN (${EXPOSED_TYPES.map((t) => `'${t}'`).join(", ")})
      -- __internal_* helpers are engine plumbing, not user-callable SQL
      AND function_name NOT LIKE '\\_\\_%' ESCAPE '\\'
    ORDER BY function_name
  `);

  // Collapse the overload rows (2,950 of them) into one entry per function name.
  const byName = new Map<string, {
    name: string;
    type: string;
    description: string;
    categories: string[];
    examples: string[];
    overloads: Overload[];
  }>();

  for (const r of rows) {
    let entry = byName.get(r.function_name);
    if (!entry) {
      entry = {
        name: r.function_name,
        type: r.function_type,
        description: r.description ?? "",
        categories: r.categories ?? [],
        examples: [],
        overloads: [],
      };
      byName.set(r.function_name, entry);
    }
    // First non-empty description/category set wins; overloads usually repeat them.
    if (!entry.description && r.description) entry.description = r.description;
    if (!entry.categories.length && r.categories) entry.categories = r.categories;
    for (const ex of r.examples ?? []) {
      if (!entry.examples.includes(ex)) entry.examples.push(ex);
    }

    // Both arrays can contain SQL NULLs for unnamed/untyped positions.
    const types = r.parameter_types ?? [];
    const names = r.parameters ?? [];
    const overload: Overload = {
      args: types.map((t, i) => ({
        name: names[i] ?? `arg${i + 1}`,
        type: t ?? "ANY",
      })),
      returnType: r.return_type ?? "ANY",
      varargs: r.varargs ?? null,
    };
    // Deduplicate structurally identical overloads.
    const key = JSON.stringify(overload);
    if (!entry.overloads.some((o) => JSON.stringify(o) === key)) {
      entry.overloads.push(overload);
    }
  }

  // --- keywords ------------------------------------------------------------
  const keywords = await q<{ keyword_name: string; keyword_category: string }>(
    `SELECT keyword_name, keyword_category FROM duckdb_keywords() ORDER BY keyword_name`
  );
  const reserved = keywords
    .filter((k) => k.keyword_category === "reserved")
    .map((k) => k.keyword_name);
  const allKeywords = keywords.map((k) => k.keyword_name);

  // --- emit ----------------------------------------------------------------
  const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const aggregates = entries.filter((e) => e.type === "aggregate").map((e) => e.name);

  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * GENERATED FILE — DO NOT EDIT BY HAND.");
  lines.push(" *");
  lines.push(` * Source: DuckDB ${version} duckdb_functions() and duckdb_keywords().`);
  lines.push(" * Regenerate with: npx tsx scripts/gen-duckdb-ops.ts");
  lines.push(" */");
  lines.push("");
  lines.push('import type { FunctionInfo } from "./builder.js";');
  lines.push("");
  lines.push(`/** DuckDB version this catalog was generated from. */`);
  lines.push(`export const DUCKDB_VERSION = ${JSON.stringify(version)};`);
  lines.push("");
  lines.push("/** A single call signature for a DuckDB function. */");
  lines.push("export interface DuckDBOverload {");
  lines.push("  args: Array<{ name: string; type: string }>;");
  lines.push("  returnType: string;");
  lines.push("  /** Type of trailing variadic arguments, if the function takes any. */");
  lines.push("  varargs: string | null;");
  lines.push("}");
  lines.push("");
  lines.push("export interface DuckDBFunction extends FunctionInfo {");
  lines.push('  /** "scalar" | "aggregate" | "macro" */');
  lines.push("  functionType: string;");
  lines.push("  categories: string[];");
  lines.push("  /** Canonical usage examples shipped in the DuckDB catalog. */");
  lines.push("  examples: string[];");
  lines.push("  /** Every signature; `args` on FunctionInfo is the first one. */");
  lines.push("  overloads: DuckDBOverload[];");
  lines.push("}");
  lines.push("");
  lines.push("export const DUCKDB_FUNCTIONS: DuckDBFunction[] = [");
  for (const e of entries) {
    const first = e.overloads[0] ?? { args: [], returnType: "ANY", varargs: null };
    const info = {
      name: `%${e.name}`,
      label: e.name.toUpperCase(),
      description: e.description,
      returnType: first.returnType,
      args: first.args,
      functionType: e.type,
      categories: e.categories,
      examples: e.examples,
      overloads: e.overloads,
    };
    lines.push(`  ${JSON.stringify(info)},`);
  }
  lines.push("];");
  lines.push("");
  lines.push("/** Function name (without the leading %) -> catalog entry. */");
  lines.push("export const DUCKDB_FUNCTIONS_BY_NAME: ReadonlyMap<string, DuckDBFunction> =");
  lines.push("  new Map(DUCKDB_FUNCTIONS.map((f) => [f.name.slice(1), f]));");
  lines.push("");
  lines.push("/** Aggregate function names, for UIs that group them separately. */");
  lines.push(`export const DUCKDB_AGGREGATES: readonly string[] = ${JSON.stringify(aggregates)};`);
  lines.push("");
  lines.push("/** Reserved words — always require quoting when used as identifiers. */");
  lines.push(`export const DUCKDB_RESERVED_KEYWORDS: ReadonlySet<string> = new Set(${JSON.stringify(reserved)});`);
  lines.push("");
  lines.push("/** Every keyword DuckDB recognises, reserved or not. */");
  lines.push(`export const DUCKDB_KEYWORDS: ReadonlySet<string> = new Set(${JSON.stringify(allKeywords)});`);
  lines.push("");

  writeFileSync(OUT, lines.join("\n"));

  console.log(`Wrote ${OUT}`);
  console.log(`  DuckDB version : ${version}`);
  console.log(`  functions      : ${entries.length} (${aggregates.length} aggregate)`);
  console.log(`  overloads      : ${entries.reduce((n, e) => n + e.overloads.length, 0)}`);
  console.log(`  with docs      : ${entries.filter((e) => e.description).length}`);
  console.log(`  examples       : ${entries.reduce((n, e) => n + e.examples.length, 0)}`);
  console.log(`  keywords       : ${allKeywords.length} (${reserved.length} reserved)`);
}

main();
