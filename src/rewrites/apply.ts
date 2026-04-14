/**
 * Compose clause transforms left-to-right.
 *
 * Each transform is a partial application of a rewrite helper —
 * `(clause) => newClause`. Use `apply` as the single point that wires the
 * order of rewrites for a clause, making it easy to read and test.
 *
 * @example
 * ```ts
 * const out = apply(
 *   clause,
 *   (c) => injectWhere(c, ["=", "tenant_id", { $: tenantId }]),
 *   (c) => rewriteDateRange(c, { column: "date", from, to }),
 *   (c) => addWhere(c, ["=", "region", { $: region }]),
 * );
 * ```
 */

import type { SqlClause } from "../types.js";

export type ClauseTransform = (clause: SqlClause) => SqlClause;

export interface ApplyOptions {
  /**
   * Optional per-step validator. Called with `(result, index, transform)`.
   * Throwing aborts the pipeline; returning a new clause replaces the step
   * result; returning `void` keeps it.
   */
  validate?: (
    result: SqlClause,
    index: number,
    transform: ClauseTransform
  ) => void | SqlClause;
}

/**
 * Apply transforms left-to-right. Returns the final clause.
 * Use `applyWith(opts, clause, ...transforms)` for validation hooks.
 */
export function apply(
  clause: SqlClause,
  ...transforms: ClauseTransform[]
): SqlClause {
  let next = clause;
  for (const t of transforms) next = t(next);
  return next;
}

/**
 * Variant of `apply` that takes options (validator) as the first argument.
 */
export function applyWith(
  opts: ApplyOptions,
  clause: SqlClause,
  ...transforms: ClauseTransform[]
): SqlClause {
  let next = clause;
  transforms.forEach((t, i) => {
    next = t(next);
    if (opts.validate) {
      const maybe = opts.validate(next, i, t);
      if (maybe !== undefined) next = maybe;
    }
  });
  return next;
}
