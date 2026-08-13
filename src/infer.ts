/**
 * Expression type inference — given a schema and a clause, what type does any
 * expression produce?
 *
 * This is what lets a query-builder UI offer the right operators on a
 * *computed* column, validate comparisons, and label output columns — not
 * just raw schema columns.
 *
 * ```ts
 * const infer = createInferrer(schema, clause);
 * infer.typeOf(["%date_trunc", {v:"month"}, "s.created_at"]);
 * // { type: "timestamp", nullable: false }
 * ```
 *
 * Types are normalized to lowercase canonical names ("integer", "text",
 * "timestamp", "numeric(10,2)", "integer[]", ...). `null` means "unknown" —
 * inference is best-effort and honest about its limits; callers should treat
 * unknown as "offer everything", never as an error.
 *
 * Function return types come from two sources: DuckDB's own generated catalog
 * (799 functions) when the dialect is duckdb, and a curated table of common
 * SQL/PostgreSQL functions otherwise. Both support arg-dependent returns
 * (min/max/coalesce return their argument's type).
 */

import type { SqlClause, SqlExpr } from "./types.js";
import { isClause, isRaw, isParam, isLift, isLiteral } from "./types.js";
import type { DatabaseSchema, TableSchema, ColumnSchema } from "./builder.js";
import { extractTableAliases } from "./analyze.js";

// ============================================================================
// Type names
// ============================================================================

/** An inferred SQL type. */
export interface InferredType {
  /** Canonical lowercase type name, precision preserved: "numeric(10,2)". */
  type: string;
  /** Whether the expression can be NULL (best-effort). */
  nullable: boolean;
}

const TYPE_ALIASES = new Map<string, string>([
  ["varchar", "text"], ["character varying", "text"], ["char", "text"],
  ["character", "text"], ["bpchar", "text"], ["string", "text"],
  ["int", "integer"], ["int4", "integer"], ["int8", "bigint"],
  ["int2", "smallint"], ["serial", "integer"], ["bigserial", "bigint"],
  ["hugeint", "bigint"],
  ["float", "double"], ["float4", "double"], ["float8", "double"],
  ["real", "double"], ["double precision", "double"],
  ["decimal", "numeric"], ["dec", "numeric"],
  ["bool", "boolean"],
  ["timestamp without time zone", "timestamp"],
  ["timestamp with time zone", "timestamptz"],
  ["time without time zone", "time"],
  ["datetime", "timestamp"],
  ["ubigint", "bigint"], ["uinteger", "bigint"], ["usmallint", "integer"],
  ["utinyint", "smallint"], ["tinyint", "smallint"],
]);

/** Normalize a raw SQL type name to its canonical form. */
export function normalizeType(raw: string): string {
  const lower = raw.trim().toLowerCase();
  // Preserve precision arguments while normalizing the base name. Base names
  // can carry digits (int8, float4), hence [a-z0-9_ ] with a lazy match.
  const m = /^([a-z][a-z0-9_ ]*?)\s*(\(.*\))?(\[\s*\d*\s*\])*$/.exec(lower);
  if (!m) return lower;
  const base = TYPE_ALIASES.get(m[1]!.trim()) ?? m[1]!.trim();
  const arraySuffix = lower.match(/(\[\s*\d*\s*\])+$/)?.[0]?.replace(/\s|\d/g, "") ?? "";
  // varchar(50) → text (length is decorative once normalized to text)
  if (base === "text") return base + arraySuffix;
  return base + (m[2] ?? "") + arraySuffix;
}

/** Strip precision for family comparisons: numeric(10,2) → numeric. */
export function baseType(type: string): string {
  return type.replace(/\(.*\)/, "").replace(/\[\]/g, "").trim();
}

const NUMERIC_TYPES = new Set(["smallint", "integer", "bigint", "numeric", "double"]);
const TEMPORAL_TYPES = new Set(["date", "time", "timetz", "timestamp", "timestamptz", "interval"]);

/** Is this type usable in arithmetic/comparison with that one? */
export function typesComparable(a: string, b: string): boolean {
  const ba = baseType(a);
  const bb = baseType(b);
  if (ba === bb) return true;
  if (NUMERIC_TYPES.has(ba) && NUMERIC_TYPES.has(bb)) return true;
  if (TEMPORAL_TYPES.has(ba) && TEMPORAL_TYPES.has(bb)) return true;
  // text compares with anything via implicit casts in both engines — but
  // that's exactly the accident a builder wants to flag, so: not comparable.
  return false;
}

/**
 * Numeric promotion: integer + double → double. Returns the FULL type of the
 * winning side so precision survives: integer + numeric(10,2) → numeric(10,2).
 */
function promoteNumeric(a: string, b: string): string {
  const order = ["smallint", "integer", "bigint", "numeric", "double"];
  const ia = order.indexOf(baseType(a));
  const ib = order.indexOf(baseType(b));
  if (ia === -1 || ib === -1) return "numeric";
  return ia >= ib ? a : b;
}

// ============================================================================
// Function return types (common SQL / PostgreSQL)
// ============================================================================

/** Return-type spec: a type name, or a rule keyed on argument types. */
type FnReturn =
  | string
  | "same-as-arg" // type of first argument
  | "same-as-args" // promoted type across all arguments (coalesce, greatest)
  | "numeric-promotion"; // sum/avg-style numeric widening

const COMMON_FUNCTIONS = new Map<string, FnReturn>([
  // Aggregates
  ["count", "bigint"],
  ["sum", "numeric-promotion"],
  ["avg", "numeric"],
  ["min", "same-as-arg"], ["max", "same-as-arg"],
  ["first", "same-as-arg"], ["last", "same-as-arg"], ["any_value", "same-as-arg"],
  ["string_agg", "text"], ["array_agg", "same-as-arg"],
  ["bool_and", "boolean"], ["bool_or", "boolean"],
  ["stddev", "double"], ["stddev_pop", "double"], ["stddev_samp", "double"],
  ["variance", "double"], ["var_pop", "double"], ["var_samp", "double"],
  ["corr", "double"], ["median", "same-as-arg"],
  // Strings
  ["lower", "text"], ["upper", "text"], ["trim", "text"], ["ltrim", "text"],
  ["rtrim", "text"], ["concat", "text"], ["replace", "text"], ["substring", "text"],
  ["substr", "text"], ["left", "text"], ["right", "text"], ["repeat", "text"],
  ["reverse", "text"], ["split_part", "text"], ["to_char", "text"],
  ["regexp_replace", "text"], ["format", "text"], ["initcap", "text"],
  ["lpad", "text"], ["rpad", "text"], ["md5", "text"],
  ["length", "integer"], ["char_length", "integer"], ["strpos", "integer"],
  ["position", "integer"], ["ascii", "integer"],
  ["like_escape", "boolean"], ["regexp_matches", "boolean"], ["starts_with", "boolean"],
  // Numbers
  ["abs", "same-as-arg"], ["round", "same-as-arg"], ["floor", "numeric"],
  ["ceil", "numeric"], ["ceiling", "numeric"], ["trunc", "numeric"],
  ["mod", "same-as-arg"], ["power", "double"], ["sqrt", "double"],
  ["exp", "double"], ["ln", "double"], ["log", "double"], ["random", "double"],
  ["sign", "integer"], ["greatest", "same-as-args"], ["least", "same-as-args"],
  // Temporal
  ["now", "timestamptz"], ["current_timestamp", "timestamptz"],
  ["current_date", "date"], ["current_time", "timetz"],
  ["date_trunc", "timestamp"], ["date_part", "double"], ["extract", "double"],
  ["age", "interval"], ["to_date", "date"], ["to_timestamp", "timestamptz"],
  ["make_date", "date"], ["make_interval", "interval"], ["justify_days", "interval"],
  ["date_add", "timestamp"], ["date_sub", "timestamp"], ["date_diff", "bigint"],
  // Null handling / conditionals
  ["coalesce", "same-as-args"], ["nullif", "same-as-arg"],
  ["ifnull", "same-as-args"], ["if", "same-as-args"],
  // JSON
  ["jsonb_build_object", "jsonb"], ["json_build_object", "json"],
  ["jsonb_agg", "jsonb"], ["json_agg", "json"], ["to_jsonb", "jsonb"],
  ["to_json", "json"], ["jsonb_array_length", "integer"],
  ["json_extract", "json"], ["json_extract_string", "text"],
  ["json_exists", "boolean"], ["json_contains", "boolean"],
  // Misc
  ["gen_random_uuid", "uuid"], ["uuid", "uuid"], ["version", "text"],
  ["row_number", "bigint"], ["rank", "bigint"], ["dense_rank", "bigint"],
  ["ntile", "bigint"], ["percent_rank", "double"], ["cume_dist", "double"],
  ["lag", "same-as-arg"], ["lead", "same-as-arg"],
  ["first_value", "same-as-arg"], ["last_value", "same-as-arg"],
  ["nth_value", "same-as-arg"],
]);

/** Boolean-producing operators. */
const BOOLEAN_OPS = new Set([
  "=", "<>", "!=", "<", "<=", ">", ">=", "and", "or", "not", "xor",
  "like", "not-like", "ilike", "not-ilike", "similar-to", "not-similar-to",
  "regexp", "~", "~*", "!~", "!~*", "in", "not-in", "between", "not-between",
  "is", "is-not", "exists", "is-distinct-from", "is-not-distinct-from",
  "@>", "<@", "&&", "?",
]);

const ARITHMETIC_OPS = new Set(["+", "-", "*", "/", "%"]);

// ============================================================================
// Inferrer
// ============================================================================

export interface InferrerOptions {
  /** Dialect for catalog-based function lookup. Default "postgres". */
  dialect?: "postgres" | "duckdb";
  /**
   * DuckDB function catalog lookup, injected to keep the 500KB generated
   * catalog out of the core bundle:
   *
   * ```ts
   * import { DUCKDB_FUNCTIONS_BY_NAME } from 'honey-ts/duckdb-ops';
   * createInferrer(schema, clause, { dialect: "duckdb",
   *   catalog: (name) => DUCKDB_FUNCTIONS_BY_NAME.get(name)?.returnType });
   * ```
   */
  catalog?: (fnName: string) => string | undefined;
}

export interface Inferrer {
  /** Infer the type of an expression in this clause's scope. */
  typeOf(expr: SqlExpr): InferredType | null;
  /** Resolve a column reference to its schema column, if any. */
  resolveColumn(ref: string): { table: TableSchema; column: ColumnSchema } | null;
}

/**
 * Create a type inferrer scoped to one clause (its FROM/JOIN aliases resolve
 * column references).
 */
export function createInferrer(
  schema: DatabaseSchema,
  clause: SqlClause,
  options: InferrerOptions = {}
): Inferrer {
  const aliasToTable = extractTableAliases(clause); // alias → table name
  const tablesByName = new Map<string, TableSchema>();
  for (const t of schema.tables) {
    tablesByName.set(t.name, t);
    tablesByName.set(`${t.schema}.${t.name}`, t);
  }

  /** Tables in scope for unqualified column resolution. */
  const scopeTables: TableSchema[] = [];
  for (const tableName of new Set(aliasToTable.values())) {
    const t = tablesByName.get(tableName);
    if (t) scopeTables.push(t);
  }

  function resolveColumn(
    ref: string
  ): { table: TableSchema; column: ColumnSchema } | null {
    const dot = ref.lastIndexOf(".");
    if (dot !== -1) {
      const qualifier = ref.slice(0, dot);
      const colName = ref.slice(dot + 1);
      const tableName = aliasToTable.get(qualifier) ?? qualifier;
      const table = tablesByName.get(tableName);
      const column = table?.columns.find((c) => c.name === colName);
      return table && column ? { table, column } : null;
    }
    // Unqualified: first in-scope table with this column wins.
    for (const table of scopeTables) {
      const column = table.columns.find((c) => c.name === ref);
      if (column) return { table, column };
    }
    return null;
  }

  function fnReturn(name: string, args: SqlExpr[]): InferredType | null {
    const lower = name.toLowerCase().replace(/^%/, "");
    // DISTINCT-suffixed aggregate names: count-distinct → count.
    const clean = lower.endsWith("-distinct") ? lower.slice(0, -9) : lower;

    const argTypes = () => args.map((a) => typeOf(a));

    const spec = COMMON_FUNCTIONS.get(clean);
    if (spec !== undefined) {
      if (spec === "same-as-arg") {
        return typeOf(args[0]!) ?? null;
      }
      if (spec === "same-as-args") {
        const known = argTypes().filter((t): t is InferredType => t !== null);
        if (known.length === 0) return null;
        return { type: known[0]!.type, nullable: known.every((t) => t.nullable) };
      }
      if (spec === "numeric-promotion") {
        const t = typeOf(args[0]!);
        if (!t) return { type: "numeric", nullable: true };
        const b = baseType(t.type);
        // sum(int) widens: integer→bigint, bigint→numeric, else keep.
        const widened = b === "smallint" || b === "integer" ? "bigint"
          : b === "bigint" ? "numeric"
          : t.type;
        return { type: widened, nullable: true };
      }
      return { type: spec, nullable: true };
    }

    // Dialect catalog (DuckDB): injected lookup.
    const fromCatalog = options.catalog?.(clean.replace(/-/g, "_"));
    if (fromCatalog && fromCatalog !== "ANY" && !fromCatalog.includes("ANY")) {
      return { type: normalizeType(fromCatalog), nullable: true };
    }
    return null;
  }

  /** Type of a raw JavaScript value (the payload of {$}/{v} wrappers). */
  function jsValueType(v: unknown): InferredType {
    if (v === null || v === undefined) return { type: "unknown", nullable: true };
    if (typeof v === "boolean") return { type: "boolean", nullable: false };
    if (typeof v === "number") {
      return { type: Number.isInteger(v) ? "integer" : "double", nullable: false };
    }
    if (typeof v === "string") return { type: "text", nullable: false };
    if (v instanceof Date) return { type: "timestamp", nullable: false };
    if (Array.isArray(v)) return { type: "unknown[]", nullable: false };
    return { type: "json", nullable: false };
  }

  function typeOf(expr: SqlExpr): InferredType | null {
    if (expr === null || expr === undefined) return { type: "unknown", nullable: true };
    if (typeof expr === "boolean") return { type: "boolean", nullable: false };
    if (typeof expr === "number") {
      return { type: Number.isInteger(expr) ? "integer" : "double", nullable: false };
    }
    if (expr instanceof Date) return { type: "timestamp", nullable: false };

    // Identifier string
    if (typeof expr === "string") {
      const resolved = resolveColumn(expr);
      if (resolved) {
        return { type: normalizeType(resolved.column.type), nullable: resolved.column.nullable };
      }
      return null;
    }

    if (Array.isArray(expr)) {
      const head = expr[0];
      if (typeof head !== "string") return null;
      const op = head.toLowerCase();

      if (BOOLEAN_OPS.has(op)) return { type: "boolean", nullable: false };

      if (op === "cast" || op === "try-cast") {
        const target = expr[2];
        if (typeof target === "string") {
          return { type: normalizeType(target), nullable: op === "try-cast" };
        }
        return null;
      }

      if (ARITHMETIC_OPS.has(op) && expr.length === 3) {
        const l = typeOf(expr[1] as SqlExpr);
        const r = typeOf(expr[2] as SqlExpr);
        if (!l || !r) return null;
        const bl = baseType(l.type);
        const br = baseType(r.type);
        // date/timestamp ± interval / integer
        if (TEMPORAL_TYPES.has(bl)) return { type: l.type, nullable: l.nullable || r.nullable };
        if (TEMPORAL_TYPES.has(br)) return { type: r.type, nullable: l.nullable || r.nullable };
        if (op === "/" ) {
          // Integer division differs by dialect; numeric is the honest answer.
          if (options.dialect === "duckdb") return { type: "double", nullable: l.nullable || r.nullable };
          return { type: promoteNumeric(l.type, r.type), nullable: l.nullable || r.nullable };
        }
        return { type: promoteNumeric(l.type, r.type), nullable: l.nullable || r.nullable };
      }

      if (op === "//") return { type: "bigint", nullable: true };
      if (op === "||") {
        const l = typeOf(expr[1] as SqlExpr);
        if (l && l.type.endsWith("[]")) return l; // list concat
        return { type: "text", nullable: false };
      }

      if (op === "case" || op === "case-expr") {
        // Type of the first resolvable THEN/ELSE branch.
        for (let i = op === "case" ? 2 : 3; i < expr.length; i += 2) {
          const t = typeOf(expr[i] as SqlExpr);
          if (t) return { ...t, nullable: true };
        }
        const last = typeOf(expr[expr.length - 1] as SqlExpr);
        return last ? { ...last, nullable: true } : null;
      }

      if (op === "over") return typeOf(expr[1] as SqlExpr);
      if (op === "agg-order-by") return typeOf(expr[1] as SqlExpr);
      if (op === "filter") return typeOf(expr[1] as SqlExpr);
      if (op === "collate") return typeOf(expr[1] as SqlExpr);
      if (op === "field") return null; // struct member — schema doesn't know
      if (op === "list") {
        const first = expr.length > 1 ? typeOf(expr[1] as SqlExpr) : null;
        return { type: `${first?.type ?? "unknown"}[]`, nullable: false };
      }
      if (op === "struct" || op === "map") return { type: op, nullable: false };
      if (op === "at" || op === "slice") {
        const base = typeOf(expr[1] as SqlExpr);
        if (op === "slice") return base;
        if (base?.type.endsWith("[]")) {
          return { type: base.type.slice(0, -2), nullable: true };
        }
        return null;
      }
      if (op === "interval") return { type: "interval", nullable: false };
      if (op === "array") return { type: "unknown[]", nullable: false };

      // Function call (%name or bare unknown head treated as fn)
      return fnReturn(head, expr.slice(1) as SqlExpr[]);
    }

    // Wrapper objects. Values inside {$}/{v} are DATA — a string there is a
    // string constant, never a column reference.
    if (isRaw(expr)) return null;
    if (isParam(expr) || isLift(expr)) return { type: "unknown", nullable: true };
    if (isLiteral(expr)) return jsValueType((expr as { v: unknown }).v);
    if (typeof expr === "object" && "$" in (expr as object)) {
      return jsValueType((expr as { $: unknown }).$);
    }
    if (typeof expr === "object" && "ident" in expr) {
      const parts = (expr as { ident: string[] }).ident;
      return typeOf(parts.join("."));
    }
    // Typed value {text: x} → the key is the cast type
    if (isClause(expr)) {
      // Scalar subquery: type of its single select item. Alias detection must
      // not misread a function call — ["%count", "*"] is a call, not
      // ["%count" aliased "*"].
      const select = (expr as SqlClause).select;
      if (Array.isArray(select) && select.length === 1) {
        const item = select[0];
        const isAliased =
          Array.isArray(item) &&
          item.length === 2 &&
          typeof item[1] === "string" &&
          item[1] !== "*" &&
          !item[1].startsWith("%") &&
          !(typeof item[0] === "string" && item[0].startsWith("%"));
        const target = isAliased ? ((item as SqlExpr[])[0] as SqlExpr) : (item as SqlExpr);
        const t = typeOf(target);
        return t ? { ...t, nullable: true } : null;
      }
      return null;
    }
    if (typeof expr === "symbol") return null;
    const keys = Object.keys(expr as object);
    if (keys.length === 1) {
      return { type: normalizeType(keys[0]!), nullable: true };
    }
    return null;
  }

  return { typeOf, resolveColumn };
}
