/**
 * Deep, schema-aware query validation — errors a query-builder UI can render
 * next to the thing that's wrong, not just "invalid SQL".
 *
 * ```ts
 * const result = validateQuery(clause, schema, { dialect: "duckdb" });
 * // {
 * //   valid: false,
 * //   problems: [{
 * //     severity: "error", code: "unknown-column", scope: "root.where",
 * //     message: `Column "emial" does not exist on table "users"`,
 * //     hint: `Did you mean "email"?`
 * //   }]
 * // }
 * ```
 *
 * Checks: table existence, column resolution (with did-you-mean hints and
 * ambiguity detection), GROUP BY completeness, aggregate nesting, comparison
 * type compatibility, and ORDER BY ordinal range.
 */

import type { SqlClause, SqlExpr } from "./types.js";
import { isClause, isRaw } from "./types.js";
import type { DatabaseSchema, TableSchema } from "./builder.js";
import { walkClauseTree } from "./rewrites/walk.js";
import { identString } from "./rewrites/matchers.js";
import { CTE_KEYS, JOIN_KEYS, SET_OP_KEYS } from "./traversal.js";
import { createInferrer, typesComparable, type InferrerOptions } from "./infer.js";

// ============================================================================
// Result shape
// ============================================================================

export type ProblemSeverity = "error" | "warning";

export interface Problem {
  severity: ProblemSeverity;
  /** Stable machine code: "unknown-table", "unknown-column", ... */
  code: string;
  /** Where in the clause tree: "root.where", "root.join[0]", "root.with:cte.select". */
  scope: string;
  message: string;
  hint?: string | undefined;
}

export interface ValidationOutcome {
  valid: boolean;
  problems: Problem[];
}

export interface ValidateOptions extends InferrerOptions {
  /**
   * Treat comparison-type mismatches as errors instead of warnings.
   * Default false: engines coerce more than schemas admit.
   */
  strictTypes?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

const AGGREGATES = new Set([
  "count", "sum", "avg", "min", "max", "median", "mode",
  "string_agg", "array_agg", "list", "bool_and", "bool_or",
  "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp",
  "first", "last", "any_value", "arg_min", "arg_max", "corr",
  "approx_count_distinct", "approx_quantile", "quantile_cont", "quantile_disc",
  "bit_and", "bit_or", "bit_xor", "product", "skewness", "kurtosis",
]);

function fnName(head: string): string {
  const lower = head.toLowerCase().replace(/^%/, "");
  return (lower.endsWith("-distinct") ? lower.slice(0, -9) : lower).replace(/-/g, "_");
}

function isAggregateCall(expr: SqlExpr): boolean {
  return (
    Array.isArray(expr) &&
    typeof expr[0] === "string" &&
    AGGREGATES.has(fnName(expr[0]))
  );
}

/** Levenshtein distance for did-you-mean hints. */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length]![b.length]!;
}

function didYouMean(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Math.max(2, Math.floor(name.length / 3));
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d <= bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best ? `Did you mean "${best}"?` : undefined;
}

/** Canonical string for structural GROUP BY comparison. */
function exprKey(expr: SqlExpr): string {
  const ident = identString(expr);
  if (ident !== null) return `ident:${ident}`;
  return JSON.stringify(expr);
}

/** All bare column references inside an expression, skipping aggregate bodies. */
function nonAggregatedRefs(expr: SqlExpr, out: SqlExpr[]): void {
  if (typeof expr === "string" || (typeof expr === "object" && expr !== null && "ident" in expr)) {
    const s = identString(expr as SqlExpr);
    if (s !== null && !s.startsWith("%")) out.push(expr as SqlExpr);
    return;
  }
  if (Array.isArray(expr)) {
    if (isAggregateCall(expr)) return; // columns inside aggregates are fine
    const head = typeof expr[0] === "string" ? expr[0].toLowerCase() : null;
    // CAST's last argument is a type name, not a column.
    if (head === "cast" || head === "try-cast") {
      nonAggregatedRefs(expr[1] as SqlExpr, out);
      return;
    }
    for (const child of expr.slice(1)) {
      // CASE's "else" marker is syntax, not a column.
      if ((head === "case" || head === "case-expr") && child === "else") continue;
      nonAggregatedRefs(child as SqlExpr, out);
    }
    return;
  }
  // wrappers/values: nothing to collect
}

/**
 * Output column names of a CTE body; null = opaque (star select, or a shape
 * the aliases can't be derived from).
 */
function cteColumns(body: SqlClause): string[] | null {
  // WITH x (a, b) AS (...) — the parser encodes explicit column aliases as a
  // [clause, ["__honey_ctecols", ...names]] derived-table wrapper.
  const fromItems = body.from === undefined ? [] : Array.isArray(body.from) ? body.from : [body.from];
  for (const f of fromItems) {
    if (Array.isArray(f) && Array.isArray(f[1]) && f[1][0] === "__honey_ctecols") {
      return (f[1] as string[]).slice(1);
    }
  }
  for (const key of SET_OP_KEYS) {
    const branches = body[key];
    if (Array.isArray(branches) && branches.length > 0) {
      return cteColumns(branches[0] as SqlClause);
    }
  }
  const items = body.select ?? body["select-distinct"];
  if (items === undefined) return null;
  const list = Array.isArray(items) ? items : [items];
  const out: string[] = [];
  for (const item of list) {
    // [expr, alias] — including a plain-string expr, provided the head isn't
    // a prefix operator reading as [op, arg].
    if (
      Array.isArray(item) &&
      item.length === 2 &&
      typeof item[1] === "string" &&
      !(typeof item[0] === "string" && (item[0].startsWith("%") || ["not", "exists", "any", "all", "-", "+", "cast", "array"].includes(item[0].toLowerCase())))
    ) {
      out.push(item[1]);
      continue;
    }
    const s = identString(item as SqlExpr);
    if (s === null || s === "*" || s.endsWith(".*")) return null;
    const dot = s.lastIndexOf(".");
    out.push(dot === -1 ? s : s.slice(dot + 1));
  }
  return out;
}

/**
 * Virtual TableSchema rows for every CTE in the document, so references to
 * CTE names resolve like tables. Column types are "unknown", which the
 * comparison checks deliberately skip. CTEs whose output columns can't be
 * derived (star selects) are also returned in `opaque` — scopes reading from
 * one skip column validation rather than reporting noise.
 */
function collectCteSchemas(clause: SqlClause): { tables: TableSchema[]; opaque: Set<string> } {
  const tables: TableSchema[] = [];
  const opaque = new Set<string>();
  walkClauseTree(clause, (c) => {
    for (const key of CTE_KEYS) {
      const entries = c[key];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const body = entry[1];
        if (!isClause(body)) continue;
        const cols = cteColumns(body as SqlClause);
        if (cols === null) {
          opaque.add(entry[0]);
          tables.push({ name: entry[0], schema: "", columns: [] });
        } else {
          tables.push({
            name: entry[0],
            schema: "",
            columns: cols.map((name) => ({ name, type: "unknown", nullable: true })),
          });
        }
      }
    }
  });
  return { tables, opaque };
}

function containsAggregate(expr: SqlExpr): boolean {
  if (!Array.isArray(expr)) return false;
  if (isAggregateCall(expr)) return true;
  return expr.some((e) => containsAggregate(e as SqlExpr));
}

/** Aggregate nested inside another aggregate's arguments. */
function findNestedAggregate(expr: SqlExpr, inAggregate = false): boolean {
  if (!Array.isArray(expr)) return false;
  const isAgg = isAggregateCall(expr);
  if (isAgg && inAggregate) return true;
  // OVER windows re-allow aggregation of window results; keep it simple and
  // only flag direct textual nesting.
  return expr
    .slice(1)
    .some((e) => findNestedAggregate(e as SqlExpr, inAggregate || isAgg));
}

// ============================================================================
// Validator
// ============================================================================

export function validateQuery(
  clause: SqlClause,
  schema: DatabaseSchema,
  options: ValidateOptions = {}
): ValidationOutcome {
  const problems: Problem[] = [];

  // CTE names resolve like tables (with "unknown"-typed columns), so a
  // `FROM my_cte` outer scope validates instead of reporting unknown-table.
  const { tables: cteTables, opaque: opaqueCtes } = collectCteSchemas(clause);
  const effSchema: DatabaseSchema =
    cteTables.length > 0 ? { tables: [...schema.tables, ...cteTables] } : schema;

  const tableNames = new Set<string>();
  for (const t of effSchema.tables) {
    tableNames.add(t.name);
    if (t.schema) tableNames.add(`${t.schema}.${t.name}`);
  }

  // For cross-table did-you-mean hints when the typo'd column exists on a
  // table that isn't in the query's scope.
  const allColumns: Array<{ name: string; table: string }> = [];
  for (const t of effSchema.tables) {
    for (const col of t.columns) allColumns.push({ name: col.name, table: t.name });
  }

  // Ancestor scopes for correlated-subquery resolution: the walk is
  // parent-first and scope labels are hierarchical, so a stack of
  // (scope, inferrer) pairs reconstructs the lexical chain.
  const ancestry: Array<{ scope: string; infer: ReturnType<typeof createInferrer> }> = [];

  walkClauseTree(clause, (c, scope) => {
    const infer = createInferrer(effSchema, c, options);
    while (
      ancestry.length &&
      !(scope !== ancestry[ancestry.length - 1]!.scope &&
        scope.startsWith(ancestry[ancestry.length - 1]!.scope))
    ) {
      ancestry.pop();
    }
    const parents = ancestry.slice();
    ancestry.push({ scope, infer });

    /** Resolve in this scope, then walk outward — correlated refs are legal.
     *  A CTE body is NOT correlated: it cannot see the enclosing query's
     *  columns, so the outward walk stops at a `with:` boundary. */
    const resolveCorrelated = (s: string): boolean => {
      if (infer.resolveColumn(s)) return true;
      for (let i = parents.length - 1; i >= 0; i--) {
        const relative = scope.slice(parents[i]!.scope.length);
        if (relative.includes("with:")) break;
        if (parents[i]!.infer.resolveColumn(s)) return true;
      }
      return false;
    };

    // Columns already reported unresolved in this scope — downstream checks
    // (GROUP BY completeness, types) skip them instead of cascading noise.
    const unresolved = new Set<string>();

    // --- tables ----------------------------------------------------------
    const tableRefs: Array<{ name: string; where: string }> = [];
    const collectTable = (item: SqlExpr, where: string) => {
      if (typeof item === "string") tableRefs.push({ name: item, where });
      else if (
        Array.isArray(item) &&
        typeof item[0] === "string" &&
        typeof item[1] === "string"
      ) {
        tableRefs.push({ name: item[0], where });
      }
    };
    const fromItems = c.from === undefined ? [] : Array.isArray(c.from) ? c.from : [c.from];
    for (const item of fromItems) collectTable(item as SqlExpr, `${scope}.from`);
    for (const key of JOIN_KEYS) {
      const pairs = c[key] as [SqlExpr, SqlExpr][] | undefined;
      if (pairs) for (const [t] of pairs) collectTable(t, `${scope}.${key}`);
    }
    for (const { name, where } of tableRefs) {
      if (!tableNames.has(name)) {
        problems.push({
          severity: "error",
          code: "unknown-table",
          scope: where,
          message: `Table "${name}" does not exist in the schema`,
          hint: didYouMean(name, [...tableNames]),
        });
      }
    }

    // --- columns ---------------------------------------------------------
    const scopeColumnNames = (): string[] => {
      const out: string[] = [];
      for (const { name } of tableRefs) {
        const t = effSchema.tables.find(
          (x) => x.name === name || `${x.schema}.${x.name}` === name
        );
        if (t) out.push(...t.columns.map((col) => col.name));
      }
      return out;
    };

    const checkRef = (ref: SqlExpr, where: string) => {
      const s = identString(ref);
      if (s === null || s === "*" || s.endsWith(".*")) return;
      if (resolveCorrelated(s)) return;
      unresolved.add(exprKey(ref));
      // Unresolvable — is the qualifier the problem, or the column?
      const dot = s.lastIndexOf(".");
      const colName = dot === -1 ? s : s.slice(dot + 1);
      // Hint from in-scope columns first; fall back to the whole schema and
      // say which table the near-miss lives on.
      let hint = didYouMean(colName, scopeColumnNames());
      if (!hint) {
        const near = didYouMean(colName, allColumns.map((x) => x.name));
        if (near) {
          const match = /"([^"]+)"/.exec(near)?.[1];
          const owner = allColumns.find((x) => x.name === match)?.table;
          hint = owner ? `Did you mean "${match}" (on table "${owner}")?` : near;
        }
      }
      problems.push({
        severity: "error",
        code: "unknown-column",
        scope: where,
        message: `Column "${s}" cannot be resolved against the tables in scope`,
        hint,
      });
    };

    const walkRefs = (expr: SqlExpr, where: string) => {
      if (expr === null || expr === undefined) return;
      if (typeof expr === "string" || (typeof expr === "object" && !Array.isArray(expr) && "ident" in (expr as object))) {
        checkRef(expr, where);
        return;
      }
      if (Array.isArray(expr)) {
        const head = typeof expr[0] === "string" ? expr[0].toLowerCase() : null;
        // CAST's last argument is a type name, not a column.
        if (head === "cast" || head === "try-cast") {
          walkRefs(expr[1] as SqlExpr, where);
          return;
        }
        // Skip head (operator/function name); check args.
        const start = typeof expr[0] === "string" ? 1 : 0;
        for (let i = start; i < expr.length; i++) {
          const child = expr[i] as SqlExpr;
          if (isClause(child) || isRaw(child)) continue; // subqueries walked separately
          // CASE's "else" marker is syntax, not a column.
          if ((head === "case" || head === "case-expr") && child === "else") continue;
          // [expr, alias] select items: don't treat the alias as a column.
          if (
            i === 1 &&
            start === 0 &&
            expr.length === 2 &&
            typeof child === "string"
          ) {
            continue;
          }
          walkRefs(child, where);
        }
      }
    };

    // Only validate refs when the scope actually has tables — a bare
    // `SELECT 1` or a VALUES clause has nothing to resolve against. Scopes
    // reading from an opaque CTE (underivable output columns) also skip:
    // every complaint would be noise.
    if (
      tableRefs.length > 0 &&
      tableRefs.every((t) => tableNames.has(t.name)) &&
      !tableRefs.some((t) => opaqueCtes.has(t.name))
    ) {
      const selectItems = c.select === undefined ? [] : Array.isArray(c.select) ? c.select : [c.select];
      for (const item of selectItems) {
        const target =
          Array.isArray(item) && item.length === 2 && typeof item[1] === "string" &&
          !(typeof item[0] === "string")
            ? (item[0] as SqlExpr)
            : (item as SqlExpr);
        walkRefs(target, `${scope}.select`);
      }
      if (c.where !== undefined) walkRefs(c.where as SqlExpr, `${scope}.where`);
      if (c.having !== undefined) walkRefs(c.having as SqlExpr, `${scope}.having`);
      if (c.qualify !== undefined) walkRefs(c.qualify as SqlExpr, `${scope}.qualify`);
      // GROUP BY may name a select item by alias — not an unknown column.
      const selectAliases = new Set<string>();
      for (const item of selectItems) {
        if (
          Array.isArray(item) && item.length === 2 && typeof item[1] === "string" &&
          !(typeof item[0] === "string")
        ) {
          selectAliases.add(item[1]);
        }
      }
      const groupItems = c["group-by"] === undefined ? [] : Array.isArray(c["group-by"]) ? c["group-by"] : [c["group-by"]];
      for (const g of groupItems) {
        if (typeof g === "string" && selectAliases.has(g)) continue;
        walkRefs(g as SqlExpr, `${scope}.group-by`);
      }
    }

    // --- GROUP BY completeness ------------------------------------------
    const selectItems = c.select === undefined ? [] : Array.isArray(c.select) ? c.select : [c.select];
    const groupItems = c["group-by"] === undefined ? [] : Array.isArray(c["group-by"]) ? c["group-by"] : [c["group-by"]];
    const anyAggregate = selectItems.some((i) => containsAggregate(i as SqlExpr));

    if ((groupItems.length > 0 || anyAggregate) && selectItems.length > 0) {
      const isGroupByAll = groupItems.some(
        (g) => isRaw(g) && (g as { __raw: unknown }).__raw === "ALL"
      );
      if (!isGroupByAll) {
        const targetOf = (item: SqlExpr): SqlExpr => {
          const aliased =
            Array.isArray(item) && item.length === 2 && typeof item[1] === "string" &&
            !(typeof item[0] === "string");
          return aliased ? ((item as SqlExpr[])[0] as SqlExpr) : item;
        };
        const aliasOf = (item: SqlExpr): string | null =>
          Array.isArray(item) && item.length === 2 && typeof item[1] === "string" &&
          !(typeof item[0] === "string")
            ? (item[1] as string)
            : null;
        // GROUP BY 2 names a select item by position; GROUP BY channel may
        // name one by alias. Resolve both to the item's expression so the
        // completeness check compares like with like.
        const resolveGroupItem = (g: SqlExpr): SqlExpr => {
          const n =
            typeof g === "number"
              ? g
              : g !== null && typeof g === "object" && !Array.isArray(g) && "v" in g &&
                (g as { float?: boolean }).float !== true
                ? Number((g as { v: unknown }).v)
                : NaN;
          if (Number.isInteger(n) && n >= 1 && n <= selectItems.length) {
            return targetOf(selectItems[n - 1] as SqlExpr);
          }
          if (typeof g === "string") {
            const named = selectItems.find((item) => aliasOf(item as SqlExpr) === g);
            if (named) return targetOf(named as SqlExpr);
          }
          return g;
        };
        const groupKeys = new Set(groupItems.map((g) => exprKey(resolveGroupItem(g as SqlExpr))));
        for (const item of selectItems) {
          const aliased =
            Array.isArray(item) && item.length === 2 && typeof item[1] === "string" &&
            !(typeof item[0] === "string");
          const target = aliased ? ((item as SqlExpr[])[0] as SqlExpr) : (item as SqlExpr);
          if (typeof target === "string" && (target === "*" || target.endsWith(".*"))) {
            if (groupItems.length > 0) {
              problems.push({
                severity: "warning",
                code: "star-with-group-by",
                scope: `${scope}.select`,
                message: "SELECT * with GROUP BY usually fails — every column must be grouped",
              });
            }
            continue;
          }
          // The whole expression matches a group-by entry? Fine.
          if (groupKeys.has(exprKey(target))) continue;
          const bare: SqlExpr[] = [];
          nonAggregatedRefs(target, bare);
          for (const ref of bare) {
            // Already reported as unknown — a grouped-ness complaint about a
            // column that doesn't exist is cascading noise.
            if (unresolved.has(exprKey(ref))) continue;
            if (!groupKeys.has(exprKey(ref))) {
              const name = identString(ref);
              problems.push({
                severity: "error",
                code: "ungrouped-column",
                scope: `${scope}.select`,
                message: `Column "${name}" must appear in GROUP BY or be inside an aggregate`,
              });
            }
          }
        }
      }
    }

    // --- aggregate nesting ----------------------------------------------
    for (const item of selectItems) {
      if (findNestedAggregate(item as SqlExpr)) {
        problems.push({
          severity: "error",
          code: "nested-aggregate",
          scope: `${scope}.select`,
          message: "Aggregate functions cannot be nested",
        });
      }
    }
    if (c.where !== undefined && containsAggregate(c.where as SqlExpr)) {
      problems.push({
        severity: "error",
        code: "aggregate-in-where",
        scope: `${scope}.where`,
        message: "Aggregates are not allowed in WHERE — use HAVING (or QUALIFY for window results)",
      });
    }

    // --- comparison type compatibility ----------------------------------
    const checkComparisons = (expr: SqlExpr, where: string) => {
      if (!Array.isArray(expr)) return;
      const op = typeof expr[0] === "string" ? expr[0].toLowerCase() : null;
      if (op && ["=", "<>", "!=", "<", "<=", ">", ">="].includes(op) && expr.length === 3) {
        const l = infer.typeOf(expr[1] as SqlExpr);
        const r = infer.typeOf(expr[2] as SqlExpr);
        if (l && r && l.type !== "unknown" && r.type !== "unknown" && !typesComparable(l.type, r.type)) {
          problems.push({
            severity: options.strictTypes ? "error" : "warning",
            code: "type-mismatch",
            scope: where,
            message: `Comparing ${l.type} with ${r.type} relies on implicit casting`,
            hint: "Add an explicit cast if this is intentional",
          });
        }
      }
      for (const child of expr) {
        if (Array.isArray(child)) checkComparisons(child as SqlExpr, where);
      }
    };
    if (c.where !== undefined) checkComparisons(c.where as SqlExpr, `${scope}.where`);
    if (c.having !== undefined) checkComparisons(c.having as SqlExpr, `${scope}.having`);

    // --- ORDER BY ordinals ----------------------------------------------
    const orderItems = c["order-by"] === undefined ? [] : Array.isArray(c["order-by"]) ? c["order-by"] : [c["order-by"]];
    for (const o of orderItems) {
      const target = Array.isArray(o) && o.length === 2 ? o[0] : o;
      const n =
        typeof target === "number" ? target
        : target && typeof target === "object" && "v" in (target as object)
          ? Number((target as { v: unknown }).v)
          : null;
      if (n !== null && Number.isInteger(n) && selectItems.length > 0 && (n < 1 || n > selectItems.length)) {
        problems.push({
          severity: "error",
          code: "order-by-ordinal",
          scope: `${scope}.order-by`,
          message: `ORDER BY ${n} is out of range — the select list has ${selectItems.length} item(s)`,
        });
      }
    }
  });

  return {
    valid: !problems.some((p) => p.severity === "error"),
    problems,
  };
}
