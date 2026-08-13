/**
 * Strong types for DuckDB-specific constructs.
 *
 * The clause-map DSL is plain arrays and objects, which keeps it serializable
 * and diffable — but a bare `SqlExpr[]` says nothing about which shapes the
 * DuckDB dialect understands. This module gives every DuckDB construct:
 *
 *   - a precise tuple type (`DuckDBListExpr`, `DuckDBLambdaExpr`, ...),
 *   - a runtime guard (`isDuckDBList`, ...) usable during clause-map walks,
 *   - a typed constructor (`list()`, `lambda()`, ...) so UIs build these
 *     without hand-assembling arrays.
 *
 * Everything here formats ONLY under `{dialect: "duckdb"}` — the emitters in
 * sql.ts throw on any other dialect, and these types are the compile-time face
 * of that same boundary. Where PostgreSQL and DuckDB read the same text
 * differently (`->` is the JSON operator in PG, a lambda arrow in DuckDB), the
 * dialect argument decides which reading applies; the types make the chosen
 * reading explicit in the clause map so no later consumer has to guess.
 */

import type { SqlExpr, SqlIdent, SqlClause } from "./types.js";

// ===========================================================================
// Expression constructs
// ===========================================================================

/** `["list", 1, 2, 3]` — a DuckDB list literal `[1, 2, 3]`. */
export type DuckDBListExpr = ["list", ...SqlExpr[]];

/** One `key: value` entry of a struct literal. */
export type DuckDBStructEntry = [key: string, value: SqlExpr];

/** `["struct", ["a", 1], ["b", "x"]]` — a struct literal `{'a': 1, 'b': 'x'}`. */
export type DuckDBStructExpr = ["struct", ...DuckDBStructEntry[]];

/**
 * `["lambda", "x", body]` or `["lambda", ["x","y"], body]` — a lambda
 * `x -> body` / `(x, y) -> body`.
 *
 * In PostgreSQL the same arrow text is the JSON `->` operator; under
 * `{dialect: "duckdb"}` an arrow whose left side is a bare parameter list in a
 * lambda-taking argument position parses to this node instead.
 */
export type DuckDBLambdaExpr = ["lambda", string | string[], SqlExpr];

/** Spec for a star with modifiers. */
export interface DuckDBStarSpec {
  /** Qualify the star: `t.*`. */
  table?: string;
  /** `EXCLUDE (a, b)` — a column may not also appear in `replace`. */
  exclude?: SqlIdent[];
  /** `REPLACE (expr AS name)` pairs. */
  replace?: Array<[SqlExpr, string]>;
  /**
   * Structural bridge to SqlClause's index signature, so a DuckDBStarExpr is
   * assignable to SqlExpr without a cast. Never populated.
   */
  [extra: string]: unknown;
}

/** `["star", {exclude: ["id"]}]` — `* EXCLUDE ("id")`. */
export type DuckDBStarExpr = ["star", DuckDBStarSpec];

/** `["slice", x, from, to]` — `x[from:to]`; `null` bounds are open. */
export type DuckDBSliceExpr = [
  "slice",
  SqlExpr,
  SqlExpr | null,
  SqlExpr | null,
];

/** `["named-arg", "bin_count", value]` — `bin_count := value`. */
export type DuckDBNamedArgExpr = ["named-arg", string, SqlExpr];

/** `["try-cast", x, "INT"]` — `TRY_CAST(x AS INT)`; NULL on failure. */
export type DuckDBTryCastExpr = ["try-cast", SqlExpr, SqlExpr | string];

/** An ORDER BY item inside an aggregate call: an expr or [expr, direction]. */
export type DuckDBOrderItem = SqlExpr | [SqlExpr, "asc" | "desc"];

/**
 * `["agg-order-by", ["%list", "v"], [["v", "desc"]]]` —
 * `LIST(v ORDER BY v DESC)`.
 */
export type DuckDBAggOrderByExpr = [
  "agg-order-by",
  SqlExpr[],
  DuckDBOrderItem[],
];

/** One `key: value` entry of a MAP literal (keys are expressions). */
export type DuckDBMapEntry = [key: SqlExpr, value: SqlExpr];

/** `["map", [k, v], ...]` — `MAP {'k': v, ...}`. */
export type DuckDBMapExpr = ["map", ...DuckDBMapEntry[]];

/** `["field", expr, "name"]` — struct field access `(expr)."name"`. */
export type DuckDBFieldExpr = ["field", SqlExpr, string];

/** `["export-state", call]` — `agg(...) EXPORT_STATE`. */
export type DuckDBExportStateExpr = ["export-state", SqlExpr];

/** `["//", a, b]` — integer division `a // b`. DuckDB-only operator. */
export type DuckDBIntDivExpr = ["//", SqlExpr, SqlExpr];

/** `["collate", expr, "NOCASE"]` — `expr COLLATE NOCASE` (both dialects). */
export type DuckDBCollateExpr = ["collate", SqlExpr, string];

/** `["ignore-nulls", x]` / `["respect-nulls", x]` — aggregate null modifiers. */
export type DuckDBNullsModifierExpr = ["ignore-nulls" | "respect-nulls", SqlExpr];

/** `["grouping-sets", [a, b], [a], []]` — `GROUPING SETS ((a,b),(a),())`. */
export type DuckDBGroupingSetsExpr = ["grouping-sets", ...SqlExpr[][]];

/**
 * A window frame on an over-spec: `{frame: {...}}`. `raw` (set when parsed
 * from SQL) round-trips verbatim; the structured fields build one
 * programmatically. Bounds are raw SQL bound text ("1 PRECEDING",
 * "CURRENT ROW", "UNBOUNDED FOLLOWING").
 */
export interface DuckDBWindowFrame {
  raw?: string;
  units?: "rows" | "range" | "groups";
  start?: string;
  end?: string;
  exclude?: "current-row" | "ties" | "group" | "no-others";
  [extra: string]: unknown;
}

/** Structured `USING SAMPLE` spec; `raw` (set when parsed) wins on emit. */
export interface DuckDBSampleSpec {
  raw?: string;
  value?: number;
  unit?: "%" | "rows";
  method?: "reservoir" | "bernoulli" | "system" | string;
  seed?: number;
  [extra: string]: unknown;
}

/** PIVOT/UNPIVOT clause payload; `style` discriminates the two syntaxes. */
export interface DuckDBPivotSpec {
  style: "duckdb" | "standard";
  source: SqlExpr | SqlClause;
  /** duckdb style: ON expressions (each may be an IN filter). */
  on?: SqlExpr[];
  /** duckdb style: USING aggregates (aliased select items allowed). */
  using?: SqlExpr[];
  "group-by"?: SqlExpr[];
  /** standard style: aggregate list / FOR column / IN values. */
  aggs?: SqlExpr[];
  for?: SqlExpr;
  in?: SqlExpr[];
  /** unpivot: INTO NAME/VALUE. */
  "into-name"?: string;
  "into-value"?: SqlExpr[];
  value?: SqlExpr;
  "include-nulls"?: boolean;
  [extra: string]: unknown;
}

/** Union of every DuckDB-only expression construct. */
export type DuckDBExpr =
  | DuckDBListExpr
  | DuckDBStructExpr
  | DuckDBLambdaExpr
  | DuckDBStarExpr
  | DuckDBSliceExpr
  | DuckDBNamedArgExpr
  | DuckDBTryCastExpr
  | DuckDBAggOrderByExpr
  | DuckDBMapExpr
  | DuckDBFieldExpr
  | DuckDBExportStateExpr
  | DuckDBIntDivExpr
  | DuckDBCollateExpr
  | DuckDBNullsModifierExpr
  | DuckDBGroupingSetsExpr;

// ===========================================================================
// Clause extensions
// ===========================================================================

/**
 * A clause map that may use DuckDB-only clause keys. `fromSql` returns this
 * shape when called with `{dialect: "duckdb"}`, and `format` accepts it only
 * under that dialect.
 */
export interface DuckDBClause extends SqlClause {
  /** `QUALIFY expr` — filters window-function results; emitted after HAVING. */
  qualify?: SqlExpr;
  /** `USING SAMPLE ...` — emitted after WHERE. */
  sample?: DuckDBSampleSpec;
  /** `DESCRIBE <table or statement>`. */
  describe?: string | SqlClause;
  /** `SUMMARIZE <table or statement>`. */
  summarize?: string | SqlClause;
  /** `SHOW <raw command tail>`. */
  show?: string;
  /** `PIVOT ...` (either syntax; see DuckDBPivotSpec.style). */
  pivot?: DuckDBPivotSpec;
  /** `UNPIVOT ...`. */
  unpivot?: DuckDBPivotSpec;
  /** `INSERT INTO ... BY NAME`. */
  "by-name"?: boolean;
  /** `INSERT OR REPLACE INTO` — same shape as insert-into. */
  "insert-or-replace-into"?: SqlExpr;
  /** `INSERT OR IGNORE INTO` — same shape as insert-into. */
  "insert-or-ignore-into"?: SqlExpr;
  /** DuckDB join variants — same [table, condition][] shape as join. */
  "asof-join"?: Array<[SqlExpr, SqlExpr]>;
  "asof-left-join"?: Array<[SqlExpr, SqlExpr]>;
  "semi-join"?: Array<[SqlExpr, SqlExpr]>;
  "anti-join"?: Array<[SqlExpr, SqlExpr]>;
  /** POSITIONAL JOIN takes no condition — pair it with null. */
  "positional-join"?: Array<[SqlExpr, SqlExpr | null]>;
}

// ===========================================================================
// Guards
// ===========================================================================

function headIs(e: unknown, name: string): e is unknown[] {
  return Array.isArray(e) && typeof e[0] === "string" &&
    e[0].toLowerCase() === name;
}

export function isDuckDBList(e: unknown): e is DuckDBListExpr {
  return headIs(e, "list");
}

export function isDuckDBStruct(e: unknown): e is DuckDBStructExpr {
  return (
    headIs(e, "struct") &&
    e.slice(1).every(
      (p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string"
    )
  );
}

export function isDuckDBLambda(e: unknown): e is DuckDBLambdaExpr {
  return (
    headIs(e, "lambda") &&
    e.length === 3 &&
    (typeof e[1] === "string" ||
      (Array.isArray(e[1]) && e[1].every((p) => typeof p === "string")))
  );
}

export function isDuckDBStar(e: unknown): e is DuckDBStarExpr {
  return (
    headIs(e, "star") &&
    e.length === 2 &&
    typeof e[1] === "object" &&
    e[1] !== null &&
    !Array.isArray(e[1])
  );
}

export function isDuckDBSlice(e: unknown): e is DuckDBSliceExpr {
  return headIs(e, "slice") && e.length === 4;
}

export function isDuckDBNamedArg(e: unknown): e is DuckDBNamedArgExpr {
  return headIs(e, "named-arg") && e.length === 3 && typeof e[1] === "string";
}

export function isDuckDBTryCast(e: unknown): e is DuckDBTryCastExpr {
  return headIs(e, "try-cast") && e.length === 3;
}

export function isDuckDBAggOrderBy(e: unknown): e is DuckDBAggOrderByExpr {
  return headIs(e, "agg-order-by") && e.length === 3 && Array.isArray(e[1]);
}

export function isDuckDBMap(e: unknown): e is DuckDBMapExpr {
  return (
    headIs(e, "map") &&
    e.slice(1).every((p) => Array.isArray(p) && p.length === 2)
  );
}

export function isDuckDBField(e: unknown): e is DuckDBFieldExpr {
  return headIs(e, "field") && e.length === 3 && typeof e[2] === "string";
}

export function isDuckDBExportState(e: unknown): e is DuckDBExportStateExpr {
  return headIs(e, "export-state") && e.length === 2;
}

export function isDuckDBIntDiv(e: unknown): e is DuckDBIntDivExpr {
  return Array.isArray(e) && e[0] === "//" && e.length === 3;
}

export function isDuckDBCollate(e: unknown): e is DuckDBCollateExpr {
  return headIs(e, "collate") && e.length === 3 && typeof e[2] === "string";
}

export function isDuckDBGroupingSets(e: unknown): e is DuckDBGroupingSetsExpr {
  return headIs(e, "grouping-sets") && e.slice(1).every(Array.isArray);
}

/** True for any DuckDB-only expression construct. */
export function isDuckDBExpr(e: unknown): e is DuckDBExpr {
  return (
    isDuckDBList(e) ||
    isDuckDBStruct(e) ||
    isDuckDBLambda(e) ||
    isDuckDBStar(e) ||
    isDuckDBSlice(e) ||
    isDuckDBNamedArg(e) ||
    isDuckDBTryCast(e) ||
    isDuckDBAggOrderBy(e) ||
    isDuckDBMap(e) ||
    isDuckDBField(e) ||
    isDuckDBExportState(e) ||
    isDuckDBIntDiv(e) ||
    isDuckDBCollate(e) ||
    isDuckDBGroupingSets(e)
  );
}

// ===========================================================================
// Constructors
// ===========================================================================

/** `list(1, 2, 3)` -> `[1, 2, 3]`. Values are inlined literals unless lifted. */
export function list(...items: SqlExpr[]): DuckDBListExpr {
  return ["list", ...items];
}

/** `struct({a: 1, b: "x"})` -> `{'a': 1, 'b': 'x'}`. */
export function struct(entries: Record<string, SqlExpr>): DuckDBStructExpr {
  return [
    "struct",
    ...Object.entries(entries).map(
      ([k, v]) => [k, v] as DuckDBStructEntry
    ),
  ];
}

/** `lambda("x", ["+", "x", {v: 1}])` -> `x -> x + 1`. */
export function lambda(
  params: string | string[],
  body: SqlExpr
): DuckDBLambdaExpr {
  return ["lambda", params, body];
}

/** `star({exclude: ["id"]})` -> `* EXCLUDE ("id")`. */
export function star(spec: DuckDBStarSpec = {}): DuckDBStarExpr {
  return ["star", spec];
}

/** `slice("a", {v: 1}, {v: 2})` -> `a[1:2]`; pass null for an open bound. */
export function slice(
  x: SqlExpr,
  from: SqlExpr | null = null,
  to: SqlExpr | null = null
): DuckDBSliceExpr {
  return ["slice", x, from, to];
}

/** `namedArg("bin_count", {v: 10})` -> `bin_count := 10`. */
export function namedArg(name: string, value: SqlExpr): DuckDBNamedArgExpr {
  return ["named-arg", name, value];
}

/** `tryCast("a", "INT")` -> `TRY_CAST(a AS INT)`. */
export function tryCast(x: SqlExpr, type: string): DuckDBTryCastExpr {
  return ["try-cast", x, type];
}

/** `aggOrderBy(["%list", "v"], [["v", "desc"]])` -> `LIST(v ORDER BY v DESC)`. */
export function aggOrderBy(
  call: SqlExpr[],
  orderBy: DuckDBOrderItem[]
): DuckDBAggOrderByExpr {
  return ["agg-order-by", call, orderBy];
}

/** `map([[{v:'a'}, {v:1}]])` -> `MAP {'a': 1}`. */
export function map(entries: DuckDBMapEntry[]): DuckDBMapExpr {
  return ["map", ...entries];
}

/** `field("s", "a")` -> `("s")."a"`. */
export function field(x: SqlExpr, name: string): DuckDBFieldExpr {
  return ["field", x, name];
}

/** `exportState(["%sum", "a"])` -> `SUM(a) EXPORT_STATE`. */
export function exportState(call: SqlExpr): DuckDBExportStateExpr {
  return ["export-state", call];
}

/** `intDiv("a", {v: 2})` -> `a // 2`. */
export function intDiv(a: SqlExpr, b: SqlExpr): DuckDBIntDivExpr {
  return ["//", a, b];
}

/** `collate("x", "NOCASE")` -> `x COLLATE NOCASE`. */
export function collate(x: SqlExpr, collation: string): DuckDBCollateExpr {
  return ["collate", x, collation];
}

/** `groupingSets([["a"], []])` -> `GROUPING SETS ((a), ())`. */
export function groupingSets(sets: SqlExpr[][]): DuckDBGroupingSetsExpr {
  return ["grouping-sets", ...sets];
}
