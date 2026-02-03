/**
 * HoneySQL TypeScript Port - PostgreSQL Operators
 *
 * Registers PostgreSQL-specific operators:
 * - JSON/JSONB operators
 * - Regex operators
 * - Array operators
 * - Full-text search operators
 *
 * Port of: https://github.com/seancorfield/honeysql/blob/develop/src/honey/sql/pg_ops.cljc
 */

import { registerOp } from "./sql.js";

// ============================================================================
// JSON/JSONB Operators
// See: https://www.postgresql.org/docs/current/functions-json.html
// ============================================================================

/**
 * -> operator: Get JSON object field as JSON
 *
 * @example
 * ```ts
 * // column -> 'key'
 * ["->", "data", "name"]
 * // column -> 0 (array index)
 * ["->", "data", 0]
 * ```
 */
export const jsonGet = "->";

/**
 * ->> operator: Get JSON object field as text
 *
 * @example
 * ```ts
 * // column ->> 'key'
 * ["->>", "data", "name"]
 * ```
 */
export const jsonGetText = "->>";

/**
 * #> operator: Get JSON object at path as JSON
 *
 * @example
 * ```ts
 * // column #> '{a,b}'
 * ["#>", "data", ["array", "a", "b"]]
 * ```
 */
export const jsonPath = "#>";

/**
 * #>> operator: Get JSON object at path as text
 */
export const jsonPathText = "#>>";

/**
 * @> operator: Does first JSON contain second?
 *
 * @example
 * ```ts
 * // data @> '{"key": "value"}'
 * ["@>", "data", ["cast", { key: "value" }, "jsonb"]]
 * ```
 */
export const jsonContains = "@>";

/**
 * <@ operator: Is first JSON contained in second?
 */
export const jsonContainedBy = "<@";

/**
 * ? operator: Does key/element exist?
 *
 * @example
 * ```ts
 * // data ? 'key'
 * ["?", "data", "key"]
 * ```
 */
export const jsonExists = "?";

/**
 * ?| operator: Do any keys/elements exist?
 */
export const jsonExistsAny = "?|";

/**
 * ?& operator: Do all keys/elements exist?
 */
export const jsonExistsAll = "?&";

/**
 * || operator: Concatenate JSON values
 */
export const jsonConcat = "||";

/**
 * #- operator: Delete at path
 */
export const jsonDeletePath = "#-";

/**
 * @? operator: Does JSON path return any item?
 */
export const jsonPathExists = "@?";

/**
 * @@ operator: JSON path predicate check / text search match
 */
export const jsonPathMatch = "@@";

// ============================================================================
// Regex Operators
// ============================================================================

/**
 * ~ operator: Case-sensitive regex match
 *
 * @example
 * ```ts
 * ["~", "name", "^John"]
 * ```
 */
export const regex = "~";

/**
 * ~* operator: Case-insensitive regex match
 */
export const iregex = "~*";

/**
 * !~ operator: Case-sensitive regex not match
 */
export const notRegex = "!~";

/**
 * !~* operator: Case-insensitive regex not match
 */
export const notIregex = "!~*";

// ============================================================================
// Array Operators
// ============================================================================

/**
 * && operator: Array overlap
 *
 * @example
 * ```ts
 * // tags && ARRAY['a', 'b']
 * ["&&", "tags", ["array", "a", "b"]]
 * ```
 */
export const arrayOverlap = "&&";

/**
 * @> operator: Array contains
 * (Same symbol as jsonContains, context determines meaning)
 */
export const arrayContains = "@>";

/**
 * <@ operator: Array is contained by
 */
export const arrayContainedBy = "<@";

// ============================================================================
// Range Operators
// ============================================================================

/**
 * <-> operator: Distance between values (used with GiST indexes)
 *
 * @example
 * ```ts
 * // point <-> point '(0,0)'
 * ["<->", "location", ["raw", "point '(0,0)'"]]
 * ```
 */
export const distance = "<->";

// ============================================================================
// Named Parameter Operator (for function calls)
// ============================================================================

/**
 * => operator: PostgreSQL named parameter in function calls
 *
 * @example
 * ```ts
 * // make_interval(secs => 10)
 * ["make_interval", ["=>", "secs", 10]]
 * ```
 */
export const namedParam = "=>";

// ============================================================================
// Register All Operators
// ============================================================================

// JSON operators
registerOp("->");
registerOp("->>");
registerOp("#>");
registerOp("#>>");
registerOp("@>");
registerOp("<@");
registerOp("?");
registerOp("?|");
registerOp("?&");
// || is already registered
registerOp("#-");
registerOp("@?");
registerOp("@@");

// Regex operators
registerOp("~");
registerOp("~*");
registerOp("!~");
registerOp("!~*");

// Array/Range operators
registerOp("&&");
registerOp("<->");

// Named param
registerOp("=>");

// ============================================================================
// Helper Functions for Common Patterns
// ============================================================================

import type { SqlExpr } from "./types.js";

/**
 * Create a JSONB contains expression.
 *
 * @example
 * ```ts
 * jsonbContains("data", { status: "active" })
 * // => ["@>", "data", ["cast", ["lift", { status: "active" }], "jsonb"]]
 * ```
 */
export function jsonbContains(column: SqlExpr, value: unknown): SqlExpr {
  return ["@>", column, ["cast", ["lift", value] as SqlExpr, "jsonb"]] as SqlExpr;
}

/**
 * Create a JSONB path extraction expression.
 *
 * @example
 * ```ts
 * jsonbPath("data", "user", "name")
 * // => ["#>>", "data", ["array", "user", "name"]]
 * ```
 */
export function jsonbPath(column: SqlExpr, ...path: string[]): SqlExpr {
  return ["#>>", column, ["array", ...path] as SqlExpr] as SqlExpr;
}

/**
 * Create an array overlap expression.
 *
 * @example
 * ```ts
 * arrayOverlaps("tags", ["typescript", "sql"])
 * // => ["&&", "tags", ["array", "typescript", "sql"]]
 * ```
 */
export function arrayOverlaps(column: SqlExpr, values: unknown[]): SqlExpr {
  return ["&&", column, ["array", ...(values as SqlExpr[])] as SqlExpr] as SqlExpr;
}

/**
 * Create a regex match expression.
 *
 * @example
 * ```ts
 * regexMatch("email", "^[a-z]+@")
 * // => ["~", "email", "^[a-z]+@"]
 * ```
 */
export function regexMatch(column: SqlExpr, pattern: string, caseInsensitive = false): SqlExpr {
  return [caseInsensitive ? "~*" : "~", column, pattern];
}

/**
 * Create a full-text search match expression.
 *
 * @example
 * ```ts
 * textSearch("search_vector", "hello & world")
 * // => ["@@", "search_vector", ["to_tsquery", "hello & world"]]
 * ```
 */
export function textSearch(column: SqlExpr, query: string): SqlExpr {
  return ["@@", column, ["to_tsquery", query]];
}
