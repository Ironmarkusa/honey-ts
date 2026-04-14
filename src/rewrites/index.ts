/**
 * Public barrel for the rewrites layer.
 *
 * Usage:
 * ```ts
 * import { find, rewrite, modify, matchers, apply, rewriteDateRange } from "honey-ts";
 *
 * const result = apply(
 *   clause,
 *   (c) => rewrite.replaceTable(c, "users", "members"),
 *   (c) => rewriteDateRange(c, { column: "date", from, to }),
 *   (c) => modify.addWhere(c, ["=", "tenant_id", { $: tenantId }]),
 * );
 * ```
 */

export * as matchers from "./matchers.js";
export * as find from "./find.js";
export * as rewrite from "./rewrite.js";
export * as modify from "./modify.js";

export { apply, applyWith } from "./apply.js";
export type { ClauseTransform, ApplyOptions } from "./apply.js";

export {
  rewriteDateRange,
  describeDatePredicates,
} from "./date-range.js";
export type {
  DatePredicate,
  RangeStrategy,
  RewriteDateRangeSpec,
} from "./date-range.js";

// Re-export matcher/hit types that appear in function signatures
export type { Matcher, MatchContext } from "./matchers.js";
export type {
  Hit,
  TableHit,
  JoinHit,
  SelectHit,
} from "./find.js";
export type { Replacement } from "./rewrite.js";
export type { AddWhereOptions, AddOrderByOptions } from "./modify.js";
