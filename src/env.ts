/**
 * The environment — a frozen, precomputed facade over the pure core.
 *
 * Configure the world once (dialect, schema, function catalog, format
 * defaults); every method is pure delegation over the free functions, plus
 * memoization that immutability makes safe: results are cached per document
 * in WeakMaps, so a UI re-validating on every render pays once per edit, not
 * once per frame.
 *
 * ```ts
 * import { createEnv } from 'honey-ts';
 * import { DUCKDB_FUNCTIONS_BY_NAME } from 'honey-ts/duckdb-ops';
 *
 * const env = createEnv({
 *   dialect: "duckdb",
 *   schema,                             // from schemaFromDuckDb(...)
 *   catalog: DUCKDB_FUNCTIONS_BY_NAME,  // one import, composition root only
 * });
 *
 * const clause = env.parse("SELECT plan, sum(total) FROM orders GROUP BY plan");
 * env.validate(clause);          // memoized
 * env.typeOf(clause, ["%sum", "total"]);  // { type: "numeric(10,2)", ... }
 * env.operatorsFor("text");      // dialect-filtered — never suggests what emit rejects
 * env.emittable(clause);         // ["postgres", "duckdb"] — document portability
 * const [sql, ...params] = env.emit(clause);
 * ```
 *
 * Rules that keep this from becoming a god object:
 *  - the config is frozen — schema or dialect changes mean a NEW env;
 *  - zero logic lives here — every method delegates to an exported free
 *    function, which remains the fully-supported primitive layer;
 *  - the env never holds document state; documents pass through.
 */

import type { SqlClause, SqlExpr, FormatOptions, FormatResult } from "./types.js";
import type { DatabaseSchema, OperatorInfo, FunctionInfo, QueryBuilder } from "./builder.js";
import type { DuckDBClause } from "./duckdb-types.js";
import { format, getDialect } from "./sql.js";
import { fromSql } from "./parser.js";
import { createQueryBuilder } from "./builder.js";
import { createInferrer, baseType, type Inferrer, type InferredType } from "./infer.js";
import { validateQuery, type ValidationOutcome, type ValidateOptions } from "./validate.js";
import { guardSql, type GuardConfig, type GuardResult } from "./guard.js";

// ============================================================================
// Config
// ============================================================================

/** A function-catalog entry, structurally satisfied by DuckDBFunction. */
export interface CatalogFunction extends FunctionInfo {
  functionType?: string;
  overloads?: Array<{ args: Array<{ name: string; type: string }>; returnType: string }>;
}

export interface EnvConfig {
  /** Target dialect. Default "postgres". */
  dialect?: "postgres" | "duckdb";
  /** Database schema, for inference / validation / suggestions. */
  schema?: DatabaseSchema;
  /**
   * Function catalog for the dialect — pass DUCKDB_FUNCTIONS_BY_NAME from
   * 'honey-ts/duckdb-ops'. Powers catalog-aware type inference and
   * `functionsFor` suggestions. This is the one dialect-specific import an
   * app makes, and only at its composition root.
   */
  catalog?: ReadonlyMap<string, CatalogFunction>;
  /** Format defaults merged into every emit (quoted, numbered, pretty, ...). */
  format?: Omit<FormatOptions, "dialect">;
  /** Validation defaults (strictTypes, ...). */
  validate?: Omit<ValidateOptions, "dialect" | "catalog">;
}

// ============================================================================
// Env
// ============================================================================

export interface Env<TClause extends SqlClause = SqlClause> {
  /** The frozen configuration this env was built with. */
  readonly config: Readonly<EnvConfig>;

  /** Parse SQL in this env's dialect. */
  parse(sql: string): TClause;
  /** Emit SQL in this env's dialect, with the env's format defaults. */
  emit(clause: SqlClause, overrides?: Omit<FormatOptions, "dialect">): FormatResult;

  /** Validate against the env's schema. Memoized per document. */
  validate(clause: SqlClause): ValidationOutcome;
  /** A type inferrer scoped to this clause. Memoized per document. */
  inferrer(clause: SqlClause): Inferrer;
  /** Infer one expression's type within a clause's scope. */
  typeOf(clause: SqlClause, expr: SqlExpr): InferredType | null;

  /**
   * Operator suggestions for a column type, filtered to operators this env's
   * dialect can actually emit — the UI can never suggest what format() would
   * reject.
   */
  operatorsFor(type: string): OperatorInfo[];
  /**
   * Function suggestions for a column type: catalog-driven when a catalog is
   * configured, the builder's common list otherwise.
   */
  functionsFor(type: string): FunctionInfo[];

  /**
   * Which dialects can emit this document. Answered by actually attempting
   * emission — the emitters' dialect gates ARE the capability model, so this
   * can never drift from reality. Memoized per document.
   */
  emittable(clause: SqlClause): Array<"postgres" | "duckdb">;

  /** Allow-list guard, delegating to guardSql. */
  guard(clause: SqlClause, config: GuardConfig): GuardResult;

  /** The schema-aware builder for this env's schema (lazy). */
  readonly builder: QueryBuilder;
}

const EMPTY_SCHEMA: DatabaseSchema = { tables: [] };

export function createEnv(
  config: EnvConfig & { dialect: "duckdb" }
): Env<DuckDBClause>;
export function createEnv(config?: EnvConfig): Env;
export function createEnv(config: EnvConfig = {}): Env {
  const dialect = config.dialect ?? "postgres";
  const schema = config.schema ?? EMPTY_SCHEMA;
  const frozen: Readonly<EnvConfig> = Object.freeze({ ...config, dialect });

  // Fail fast on typos, not on first emit.
  const dialectConfig = getDialect(dialect);
  if (!dialectConfig) {
    throw new Error(`createEnv: unknown dialect '${dialect}'`);
  }

  const catalogLookup = config.catalog
    ? (name: string) => config.catalog!.get(name)?.returnType
    : undefined;

  // --- memo tables (per env; safe because documents are immutable) --------
  const validateMemo = new WeakMap<SqlClause, ValidationOutcome>();
  const inferrerMemo = new WeakMap<SqlClause, Inferrer>();
  const emittableMemo = new WeakMap<SqlClause, Array<"postgres" | "duckdb">>();

  // --- suggestion indexes (precomputed once) ------------------------------
  let builderInstance: QueryBuilder | null = null;
  const getBuilder = () => (builderInstance ??= createQueryBuilder(schema));

  /** Catalog functions grouped by the type family of their first argument. */
  let fnIndex: Map<string, FunctionInfo[]> | null = null;
  const buildFnIndex = (): Map<string, FunctionInfo[]> => {
    const index = new Map<string, FunctionInfo[]>();
    const add = (key: string, fn: FunctionInfo) => {
      const list = index.get(key) ?? [];
      if (!list.some((f) => f.name === fn.name)) {
        list.push(fn);
        index.set(key, list);
      }
    };
    for (const fn of config.catalog?.values() ?? []) {
      if (fn.functionType && fn.functionType !== "scalar" && fn.functionType !== "aggregate") {
        continue;
      }
      // Operator-functions ("+", "||", "~~") live in the catalog too; a
      // function picker wants functions, not operator spellings.
      const bare = fn.name.replace(/^%/, "");
      if (!/^[a-z_][a-z0-9_]*$/.test(bare)) continue;
      const overloads = fn.overloads?.length
        ? fn.overloads
        : [{ args: fn.args, returnType: fn.returnType }];
      for (const o of overloads) {
        const first = o.args[0]?.type;
        if (!first) {
          add("*", fn);
          continue;
        }
        if (first === "ANY" || first.startsWith("ANY")) add("*", fn);
        else add(baseType(first.toLowerCase()), fn);
      }
    }
    // Deterministic order within each bucket.
    for (const list of index.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return index;
  };

  const env: Env = {
    config: frozen,

    parse(sql) {
      return dialect === "duckdb" ? fromSql(sql, { dialect: "duckdb" }) : fromSql(sql);
    },

    emit(clause, overrides) {
      return format(clause, { ...config.format, ...overrides, dialect });
    },

    validate(clause) {
      const hit = validateMemo.get(clause);
      if (hit) return hit;
      const result = validateQuery(clause, schema, {
        ...config.validate,
        dialect,
        ...(catalogLookup ? { catalog: catalogLookup } : {}),
      });
      validateMemo.set(clause, result);
      return result;
    },

    inferrer(clause) {
      const hit = inferrerMemo.get(clause);
      if (hit) return hit;
      const inf = createInferrer(schema, clause, {
        dialect,
        ...(catalogLookup ? { catalog: catalogLookup } : {}),
      });
      inferrerMemo.set(clause, inf);
      return inf;
    },

    typeOf(clause, expr) {
      return env.inferrer(clause).typeOf(expr);
    },

    operatorsFor(type) {
      const all = getBuilder().getOperatorsForType(type);
      const unsupported = dialectConfig.unsupportedOps;
      if (!unsupported) return all;
      return all.filter((op) => !unsupported.has(op.op));
    },

    functionsFor(type) {
      if (!config.catalog) return getBuilder().getFunctionsForType(type);
      fnIndex ??= buildFnIndex();
      const family = baseType(type.toLowerCase());
      // Family aliases mirror normalizeType's canon loosely. Type-specific
      // buckets come FIRST — a picker for a timestamp column should lead with
      // date functions, not generic ANY-typed utilities.
      const keys: string[] = [family];
      if (family === "text") keys.push("varchar");
      if (family === "varchar") keys.push("text");
      if (["smallint", "integer", "bigint", "numeric", "double", "decimal"].includes(family)) {
        for (const k of ["smallint", "integer", "bigint", "numeric", "double", "decimal", "hugeint"]) {
          if (!keys.includes(k)) keys.push(k);
        }
      }
      keys.push("*");
      const out: FunctionInfo[] = [];
      const seen = new Set<string>();
      for (const key of keys) {
        for (const fn of fnIndex.get(key) ?? []) {
          if (!seen.has(fn.name)) {
            seen.add(fn.name);
            out.push(fn);
          }
        }
      }
      return out;
    },

    emittable(clause) {
      const hit = emittableMemo.get(clause);
      if (hit) return hit;
      const out: Array<"postgres" | "duckdb"> = [];
      for (const d of ["postgres", "duckdb"] as const) {
        try {
          format(clause, { dialect: d });
          out.push(d);
        } catch {
          /* this dialect cannot emit the document */
        }
      }
      emittableMemo.set(clause, out);
      return out;
    },

    guard(clause, guardConfig) {
      return guardSql(clause, guardConfig);
    },

    get builder() {
      return getBuilder();
    },
  };

  return env;
}
