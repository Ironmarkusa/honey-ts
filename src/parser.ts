/**
 * HoneySQL TypeScript - SQL Parser
 *
 * Provides fromSql() to parse SQL strings into clause maps.
 * Combined with toSql(), enables round-trip: clause ↔ SQL
 */

import {
  parse,
  parseFirst,
  toSql as astToSql,
  type Statement,
  type SelectFromStatement,
  type InsertStatement,
  type UpdateStatement,
  type DeleteStatement,
  type CreateTableStatement,
  type Expr,
  type ExprRef,
  type ExprBinary,
  type ExprUnary,
  type ExprCall,
  type ExprCase,
  type ExprCast,
  type ExprList,
  type ExprMember,
  type ExprArrayIndex,
  type ExprTernary,
  type ExprParameter,
  type ExprInteger,
  type ExprNumeric,
  type ExprString,
  type ExprBool,
  type ExprNull,
  type SelectedColumn,
  type From,
  type FromTable,
  type FromStatement,
  type JoinClause,
  type OrderByStatement,
  type SetStatement,
  type QName,
  type Name,
} from "pgsql-ast-parser";
import { preprocessDuckDb, reviveSentinels } from "./duckdb-preprocess.js";
import {
  parseDuckDbStatement,
  type StatementParseContext,
} from "./duckdb-statements.js";
import type { DuckDBClause } from "./duckdb-types.js";

/** Options for fromSql. */
export interface FromSqlOptions {
  /**
   * Source dialect. `duckdb` enables a rewriting pass that lets DuckDB-only
   * syntax (list/struct literals, GROUP BY ALL, TRY_CAST, FROM-first, ...)
   * through the PostgreSQL parser. Defaults to postgres behaviour.
   */
  dialect?: "postgres" | "duckdb";
}

import { isClause } from "./types.js";
import type { SqlClause, SqlExpr } from "./types.js";

// ============================================================================
// AST → Clause Map Transformation
// ============================================================================

/**
 * Convert a pgsql-ast-parser expression to our SqlExpr format.
 */
function exprToClause(expr: Expr | null | undefined): SqlExpr {
  if (!expr) return null;

  switch (expr.type) {
    case "ref": {
      const ref = expr as ExprRef;
      const name = ref.name;
      if (ref.table) {
        // Use array for qualified identifiers to preserve dots in names
        const tableRef = ref.table as { schema?: string; name: string };
        if (tableRef.schema) {
          return { ident: [tableRef.schema, tableRef.name, name] };
        }
        return { ident: [ref.table.name, name] };
      }
      // Wrap identifiers containing dots to preserve them as single units
      if (name.includes(".")) {
        return { ident: [name] };
      }
      return name;
    }

    case "binary": {
      const bin = expr as ExprBinary;
      const op = bin.op.toLowerCase();
      const left = exprToClause(bin.left);
      const right = exprToClause(bin.right);

      // Map operators
      const opMap: Record<string, string> = {
        "=": "=",
        "<>": "<>",
        "!=": "<>",
        "<": "<",
        ">": ">",
        "<=": "<=",
        ">=": ">=",
        "and": "and",
        "or": "or",
        "+": "+",
        "-": "-",
        "*": "*",
        "/": "/",
        "||": "||",
        "like": "like",
        "ilike": "ilike",
        "in": "in",
        "not in": "not-in",
        "@>": "@>",
        "<@": "<@",
        "->": "->",
        "->>": "->>",
        "#>": "#>",
        "#>>": "#>>",
        "?": "?",
        "?|": "?|",
        "?&": "?&",
        "@@": "@@",
        "~": "~",
        "~*": "~*",
        "!~": "!~",
        "!~*": "!~*",
        "is": "is",
        "is not": "is-not",
      };

      const mapped = opMap[op] ?? op;
      // IN's RHS is grammatically a parenthesized list or a subquery — never a
      // bare scalar. pgsql-ast-parser reads `IN ('x')` as a parenthesized
      // scalar, which would round-trip to the invalid `IN 'x'`; keep list-ness.
      if ((mapped === "in" || mapped === "not-in") && !Array.isArray(right) && !isClause(right)) {
        return [mapped, left, [right]];
      }
      return [mapped, left, right];
    }

    case "unary": {
      const un = expr as ExprUnary;
      const op = un.op.toLowerCase();
      const operand = exprToClause(un.operand);

      if (op === "not") return ["not", operand];
      if (op === "-") return ["-", operand];
      if (op === "+") return ["+", operand];
      if (op === "is null") return ["is", operand, null];
      if (op === "is not null") return ["is-not", operand, null];
      if (op === "isnull") return ["is", operand, null];
      if (op === "notnull") return ["is-not", operand, null];
      if (op === "is true") return ["is", operand, true];
      if (op === "is not true") return ["is-not", operand, true];
      if (op === "is false") return ["is", operand, false];
      if (op === "is not false") return ["is-not", operand, false];
      return [op, operand];
    }

    case "call": {
      const call = expr as ExprCall;
      const callAny = call as unknown as {
        distinct?: string;
        filter?: Expr;
        orderBy?: OrderByStatement[];
        withinGroup?: OrderByStatement;
        over?: { partitionBy?: Expr[]; orderBy?: OrderByStatement[] };
      };

      // Use % prefix for function names (HoneySQL convention)
      let fnName = `%${call.function.name.toLowerCase()}`;

      // Handle DISTINCT in aggregate: COUNT(DISTINCT x). The AST field is
      // 'all' | 'distinct' — COUNT(ALL x) is the default behaviour, not
      // DISTINCT, so it must not grow a -distinct suffix.
      if (callAny.distinct === "distinct") {
        fnName = `%${call.function.name.toLowerCase()}-distinct`;
      }

      const args = call.args.map(exprToClause);
      let fnCall: SqlExpr[] = [fnName, ...args];

      // An ORDER BY item inside an aggregate: an expr, or [expr, direction]
      // where the direction may carry a NULLS placement ("desc",
      // "asc nulls last", "nulls first", ...) — the shape agg-order-by and
      // within-group emit.
      const aggOrderItem = (o: OrderByStatement): SqlExpr => {
        const item = exprToClause(o.by);
        const dir = [
          o.order?.toLowerCase(),
          o.nulls ? `nulls ${o.nulls.toLowerCase()}` : undefined,
        ].filter(Boolean).join(" ");
        return dir ? ([item, dir] as SqlExpr) : item;
      };

      // Handle aggregate ORDER BY inside the parens:
      // string_agg(x, ',' ORDER BY y)
      if (callAny.orderBy && callAny.orderBy.length > 0) {
        fnCall = ["agg-order-by", fnCall, callAny.orderBy.map(aggOrderItem)];
      }

      // Handle ordered-set aggregates:
      // percentile_cont(0.5) WITHIN GROUP (ORDER BY total)
      if (callAny.withinGroup) {
        fnCall = ["within-group", fnCall, [aggOrderItem(callAny.withinGroup)]];
      }

      // Handle FILTER clause: COUNT(*) FILTER (WHERE ...)
      if (callAny.filter) {
        fnCall = ["filter", fnCall, exprToClause(callAny.filter)];
      }

      // Handle window functions with OVER clause
      if (callAny.over) {
        const overSpec: SqlClause = {};
        if (callAny.over.partitionBy && callAny.over.partitionBy.length > 0) {
          overSpec["partition-by"] = callAny.over.partitionBy.map(exprToClause);
        }
        if (callAny.over.orderBy && callAny.over.orderBy.length > 0) {
          overSpec["order-by"] = callAny.over.orderBy.map((ob) => {
            const col = exprToClause(ob.by);
            const dir = ob.order?.toLowerCase() ?? "asc";
            return [col, dir];
          });
        }
        return ["over", fnCall, overSpec];
      }

      return fnCall;
    }

    case "case": {
      const caseExpr = expr as ExprCase;
      const parts: SqlExpr[] = ["case"];

      if (caseExpr.value) {
        // CASE expr WHEN ... form
        parts[0] = "case-expr";
        parts.push(exprToClause(caseExpr.value));
      }

      for (const when of caseExpr.whens) {
        parts.push(exprToClause(when.when));
        parts.push(exprToClause(when.value));
      }

      if (caseExpr.else) {
        parts.push("else");
        parts.push(exprToClause(caseExpr.else));
      }

      return parts;
    }

    case "cast": {
      const cast = expr as ExprCast;
      const value = exprToClause(cast.operand);
      return ["cast", value, typeDefToName(cast.to)];
    }

    case "list": {
      const list = expr as ExprList;
      return list.expressions.map(exprToClause);
    }

    case "member": {
      const mem = expr as ExprMember;
      const memAny = mem as unknown as { op: string };
      const obj = exprToClause(mem.operand);
      // member is a string literal, wrap as literal value
      const prop = { v: mem.member };
      return [memAny.op, obj, prop];
    }

    case "arrayIndex": {
      const idx = expr as ExprArrayIndex;
      const arr = exprToClause(idx.array);
      const index = exprToClause(idx.index);
      return ["at", arr, index];
    }

    case "ternary": {
      const tern = expr as ExprTernary;
      const op = tern.op.toLowerCase();
      if (op === "between") {
        return ["between", exprToClause(tern.value), exprToClause(tern.lo), exprToClause(tern.hi)];
      }
      if (op === "not between") {
        return ["not-between", exprToClause(tern.value), exprToClause(tern.lo), exprToClause(tern.hi)];
      }
      return [op, exprToClause(tern.value), exprToClause(tern.lo), exprToClause(tern.hi)];
    }

    case "parameter": {
      const param = expr as ExprParameter;
      return ["param", param.name];
    }

    case "integer":
      return { v: (expr as ExprInteger).value };

    case "numeric": {
      const value = (expr as ExprNumeric).value;
      // An integer-valued float literal (`100.0`) is indistinguishable from
      // `100` as a JS number, but the decimal point changes the SQL type
      // (DECIMAL vs INTEGER). Mark it so emission keeps the point.
      return Number.isInteger(value) ? { v: value, float: true } : { v: value };
    }

    case "string":
      return { v: (expr as ExprString).value };

    case "boolean":
      return (expr as ExprBool).value;

    case "null":
      return null;

    case "array": {
      const arr = expr as { type: "array"; expressions: Expr[] };
      return ["array", ...arr.expressions.map(exprToClause)];
    }

    case "select":
      return selectToClause(expr as SelectFromStatement);

    default:
      // For unknown types, try to convert back to SQL and use raw
      try {
        const sql = astToSql.expr(expr);
        return { __raw: sql };
      } catch {
        return { __raw: `/* unknown: ${expr.type} */` };
      }
  }
}

/**
 * Convert a column reference to identifier string.
 */
function nameToIdent(name: unknown): string {
  if (typeof name === "string") {
    return name;
  }
  if (name && typeof name === "object") {
    const n = name as Record<string, unknown>;
    if (typeof n.name === "string") {
      if (typeof n.schema === "string") {
        return `${n.schema}.${n.name}`;
      }
      return n.name;
    }
  }
  return String(name);
}

/**
 * Convert selected columns to clause format.
 */
function columnsToClause(columns: SelectedColumn[]): SqlExpr[] {
  return columns.map((col) => {
    if (col.expr.type === "ref" && (col.expr as ExprRef).name === "*") {
      if ((col.expr as ExprRef).table) {
        return `${(col.expr as ExprRef).table!.name}.*`;
      }
      return "*";
    }

    const expr = exprToClause(col.expr);

    if (col.alias) {
      return [expr, col.alias.name];
    }

    return expr;
  });
}

/**
 * Convert FROM clause to our format.
 */
function fromToClause(froms: From[] | undefined): SqlExpr[] | undefined {
  if (!froms || froms.length === 0) return undefined;

  return froms.map((f) => {
    if (f.type === "table") {
      const table = f as FromTable;
      const name = nameToIdent(table.name);

      if (table.name.alias) {
        return [name, table.name.alias];
      }

      return name;
    }

    if (f.type === "statement") {
      const stmt = f as FromStatement;
      const stmtAny = stmt as unknown as {
        lateral?: boolean;
        columnNames?: Array<{ name: string }>;
      };
      // Dispatch through statementToClause, not selectToClause: a derived table
      // can be a VALUES list rather than a SELECT, and forcing it through the
      // SELECT path silently produced an empty clause (emitting "FROM ()").
      let subquery: SqlExpr = statementToClause(stmt.statement as Statement);

      // Handle LATERAL subqueries
      if (stmtAny.lateral) {
        subquery = ["lateral", subquery];
      }

      if (stmt.alias) {
        // Column alias list: FROM (VALUES (1,2)) t(a, b)
        const columnNames = stmtAny.columnNames?.map((c) => c.name);
        if (columnNames?.length) {
          return [subquery, [stmt.alias, ...columnNames]];
        }
        return [subquery, stmt.alias];
      }

      return subquery;
    }

    // Table function call: FROM range(10) AS tbl(i), FROM read_parquet(...).
    // Previously fell through to the raw fallback, which silently dropped the
    // alias and column names.
    if (f.type === "call") {
      const call = f as unknown as {
        function: { name: string };
        args: Expr[];
        alias?: { name: string; columns?: Array<{ name: string }> };
      };
      const expr: SqlExpr = [`%${call.function.name}`, ...call.args.map(exprToClause)];
      if (call.alias) {
        const cols = call.alias.columns?.map((c) => c.name);
        if (cols?.length) return [expr, [call.alias.name, ...cols]];
        return [expr, call.alias.name];
      }
      return expr;
    }

    // For joins and other complex froms, use the first part
    return { __raw: astToSql.from(f) };
  });
}

/**
 * Render a parsed type definition back to a type-name string.
 *
 * Handles three shapes the old inline code got wrong:
 *  - array types: {kind: "array", arrayOf: {name: "int"}} -> "int[]"
 *    (previously collapsed to the meaningless "array");
 *  - quoted types: {name: '...""...', doubleQuoted: true} keeps the doubled
 *    quotes from the source text, which must be undoubled;
 *  - precision arguments: {name: "numeric", config: [7, 4]} -> "numeric(7,4)".
 */
function typeDefToName(to: unknown): string {
  const typeDef = to as {
    name?: string;
    kind?: string;
    config?: number[];
    arrayOf?: unknown;
    doubleQuoted?: boolean;
  };
  if (typeDef.kind === "array" && typeDef.arrayOf) {
    return `${typeDefToName(typeDef.arrayOf)}[]`;
  }
  let typeName = typeDef.name ?? typeDef.kind ?? "unknown";
  if (typeDef.doubleQuoted) {
    typeName = typeName.replace(/""/g, '"');
  }
  if (typeDef.config && typeDef.config.length > 0) {
    typeName = `${typeName}(${typeDef.config.join(",")})`;
  }
  return typeName;
}

/**
 * Convert JOIN clauses.
 */
function joinsToClause(froms: From[] | undefined): [string, [SqlExpr, SqlExpr][]][] {
  if (!froms) return [];

  const joins: [string, [SqlExpr, SqlExpr][]][] = [];

  for (const f of froms) {
    const joinInfo = (f as { join?: FromTable["join"] }).join;
    // Joins hang off table entries AND statement entries — `JOIN (SELECT ...)
    // s ON ...` used to be silently dropped into a comma cross-join because
    // only table-type entries were checked here.
    if (joinInfo && (f.type === "table" || f.type === "statement")) {
      const joinType = (joinInfo.type ?? "INNER JOIN").toUpperCase();
      const clauseKey =
        joinType.includes("LEFT")
          ? "left-join"
          : joinType.includes("RIGHT")
          ? "right-join"
          : joinType.includes("FULL")
          ? "full-join"
          : joinType.includes("CROSS")
          ? "cross-join"
          : "join";

      let tableExpr: SqlExpr;
      if (f.type === "table") {
        const table = f as FromTable;
        const tableName = nameToIdent(table.name);
        tableExpr = table.name.alias ? [tableName, table.name.alias] : tableName;
      } else {
        const stmt = f as FromStatement;
        const sub = statementToClause(stmt.statement as Statement);
        tableExpr = stmt.alias ? [sub, stmt.alias] : (sub as SqlExpr);
      }

      // JOIN ... USING (a, b) — previously dropped on the floor, silently
      // turning an equi-join into a bare INNER JOIN with no condition.
      const joinUsing = (joinInfo as unknown as { using?: Array<{ name: string }> }).using;
      const condition: SqlExpr = joinUsing?.length
        ? ["using", ...joinUsing.map((u) => u.name)]
        : exprToClause(joinInfo.on);

      // Find or create the join array for this type
      let joinArr = joins.find(([k]) => k === clauseKey);
      if (!joinArr) {
        joinArr = [clauseKey, []];
        joins.push(joinArr);
      }
      joinArr[1].push([tableExpr, condition]);
    }
  }

  return joins;
}

/**
 * Convert ORDER BY to clause format.
 */
function orderByToClause(orderBy: OrderByStatement[] | undefined): SqlExpr[] | undefined {
  if (!orderBy || orderBy.length === 0) return undefined;

  return orderBy.map((o) => {
    const expr = exprToClause(o.by);
    const dir = o.order?.toLowerCase() ?? "asc";
    return [expr, dir];
  });
}

/**
 * Convert a SELECT statement to clause map.
 */
function selectToClause(stmt: SelectFromStatement): SqlClause {
  const clause: SqlClause = {};

  // SELECT columns
  if (stmt.columns) {
    const distinct = stmt.distinct as unknown;
    if (Array.isArray(distinct) && distinct.length > 0) {
      // DISTINCT ON (expr, ...)
      const onExprs = distinct.map(exprToClause);
      const cols = columnsToClause(stmt.columns);
      clause["select-distinct-on"] = [onExprs, ...(Array.isArray(cols) ? cols : [cols])];
    } else if (distinct) {
      clause["select-distinct"] = columnsToClause(stmt.columns);
    } else {
      clause.select = columnsToClause(stmt.columns);
    }
  }

  // FROM - separate base tables from joins
  if (stmt.from) {
    const baseTables = stmt.from.filter(
      (f) => f.type === "table" && !(f as FromTable).join
    );
    const joinTables = stmt.from.filter(
      (f) => f.type === "table" && (f as FromTable).join
    );
    // Joined statements belong to joinsToClause, not the FROM list.
    const subqueries = stmt.from.filter(
      (f) => f.type === "statement" && !(f as { join?: unknown }).join
    );
    // Table function calls: FROM range(10), FROM read_parquet('x'). These were
    // silently dropped before — the filters above only passed tables and
    // subqueries.
    const calls = stmt.from.filter((f) => (f as { type: string }).type === "call");

    const fromItems = [
      ...(fromToClause(baseTables) ?? []),
      ...(fromToClause(subqueries) ?? []),
      ...(fromToClause(calls) ?? []),
    ];
    if (fromItems.length > 0) {
      // Only unwrap if single item AND it's a simple identifier (not [table, alias])
      if (fromItems.length === 1 && typeof fromItems[0] === "string") {
        clause.from = fromItems[0];
      } else {
        clause.from = fromItems;
      }
    }

    // JOINs — both joined tables and joined subqueries.
    const joinedStatements = stmt.from.filter(
      (f) => f.type === "statement" && (f as { join?: unknown }).join
    );
    const joins = joinsToClause([...joinTables, ...joinedStatements]);
    for (const [key, pairs] of joins) {
      (clause as Record<string, unknown>)[key] = pairs;
    }
  }

  // WHERE
  if (stmt.where) {
    clause.where = exprToClause(stmt.where);
  }

  // GROUP BY
  if (stmt.groupBy) {
    clause["group-by"] = stmt.groupBy.map(exprToClause);
  }

  // HAVING
  if (stmt.having) {
    clause.having = exprToClause(stmt.having);
  }

  // ORDER BY
  if (stmt.orderBy) {
    clause["order-by"] = orderByToClause(stmt.orderBy);
  }

  // LIMIT
  if (stmt.limit) {
    clause.limit = exprToClause(stmt.limit.limit);
    if (stmt.limit.offset) {
      clause.offset = exprToClause(stmt.limit.offset);
    }
  }

  return clause;
}

/**
 * Convert an INSERT statement to clause map.
 */
function insertToClause(stmt: InsertStatement): SqlClause {
  const clause: SqlClause = {};

  clause["insert-into"] = nameToIdent(stmt.into.name);

  // Columns
  if (stmt.columns) {
    clause.columns = stmt.columns.map((c) => (c as { name: string }).name);
  }

  // VALUES - from the insert subquery
  if (stmt.insert) {
    const insertData = stmt.insert as { type: string; values?: Expr[][] };
    if (insertData.type === "values" && insertData.values) {
      clause.values = insertData.values.map((row) => row.map(exprToClause)) as SqlExpr[][];
    } else if (insertData.type === "select") {
      // INSERT ... SELECT - store as nested query
      const selectClause = selectToClause(stmt.insert as SelectFromStatement);
      clause.values = selectClause as unknown as SqlExpr[][];
    }
  }

  // ON CONFLICT
  if (stmt.onConflict) {
    const onConflict = stmt.onConflict as unknown as Record<string, unknown>;

    if (onConflict.on) {
      const onItems = onConflict.on as unknown as {
        type?: string;
        exprs?: Expr[];
        constraint?: { constraint: string };
        column?: string;
      };

      if (onItems.type === "on expr" && onItems.exprs) {
        // ON CONFLICT (col1, col2, ...)
        clause["on-conflict"] = onItems.exprs.map(exprToClause);
      } else if (onItems.constraint) {
        clause["on-conflict"] = [["on-constraint", onItems.constraint.constraint] as SqlExpr];
      } else if (Array.isArray(onItems)) {
        clause["on-conflict"] = (onItems as Array<{ column?: string }>).map((c) =>
          String(c.column ?? "unknown")
        );
      }
    }

    if (onConflict.do === "do nothing") {
      clause["do-nothing"] = true;
    } else if (typeof onConflict.do === "object" && onConflict.do !== null) {
      const doAction = onConflict.do as { type?: string; sets?: SetStatement[] };
      if (doAction.sets) {
        const sets: Record<string, SqlExpr> = {};
        for (const s of doAction.sets) {
          sets[(s.column as { name: string }).name] = exprToClause(s.value);
        }
        clause["do-update-set"] = sets;
      }
    }
  }

  // RETURNING
  if (stmt.returning) {
    clause.returning = columnsToClause(stmt.returning);
  }

  return clause;
}

/**
 * Convert an UPDATE statement to clause map.
 */
function updateToClause(stmt: UpdateStatement): SqlClause {
  const clause: SqlClause = {};

  clause.update = nameToIdent((stmt.table as { name: unknown }).name);

  // SET
  if (stmt.sets) {
    const sets: Record<string, SqlExpr> = {};
    for (const s of stmt.sets) {
      sets[(s.column as { name: string }).name] = exprToClause(s.value);
    }
    clause.set = sets;
  }

  // FROM
  if (stmt.from) {
    const fromArr = Array.isArray(stmt.from) ? stmt.from : [stmt.from];
    clause.from = fromToClause(fromArr as From[]);
  }

  // WHERE
  if (stmt.where) {
    clause.where = exprToClause(stmt.where);
  }

  // RETURNING
  if (stmt.returning) {
    clause.returning = columnsToClause(stmt.returning);
  }

  return clause;
}

/**
 * Convert a DELETE statement to clause map.
 */
function deleteToClause(stmt: DeleteStatement): SqlClause {
  const clause: SqlClause = {};

  clause["delete-from"] = nameToIdent((stmt.from as { name: unknown }).name);

  // WHERE
  if (stmt.where) {
    clause.where = exprToClause(stmt.where);
  }

  // RETURNING
  if (stmt.returning) {
    clause.returning = columnsToClause(stmt.returning);
  }

  return clause;
}

/**
 * Convert any statement to clause map.
 */
function statementToClause(stmt: Statement): SqlClause {
  switch (stmt.type) {
    case "select":
      return selectToClause(stmt as SelectFromStatement);
    case "insert":
      return insertToClause(stmt as InsertStatement);
    case "update":
      return updateToClause(stmt as UpdateStatement);
    case "delete":
      return deleteToClause(stmt as DeleteStatement);
    case "with":
      return withToClause(stmt as WithStatement);
    case "values":
      // Standalone VALUES list, e.g. a derived table `FROM (VALUES (1,2)) t`.
      return {
        values: (stmt as unknown as { values: Expr[][] }).values.map((row) =>
          row.map(exprToClause)
        ),
      };
    case "union":
    case "union all": {
      // pgsql-ast-parser nests chains to the RIGHT (A UNION (B UNION C)), but
      // SQL set operations are LEFT-associative — (A UNION B) UNION C — and
      // for mixed chains the difference changes results. Flatten the right
      // spine and rebuild left-associative, keeping each operator's text
      // order. EXCEPT/INTERSECT arrive as UNION with a __honey_setop marker
      // in the right side's select list (pgsql has no production for them);
      // rebuilding binary here puts every marker on its own node's right
      // side, where reviveSentinels renames that node's key locally.
      const sides: SqlClause[] = [];
      const ops: string[] = [];
      let node: Statement = stmt;
      for (;;) {
        const setOp = node as unknown as { type: string; left: Statement; right: Statement };
        if (setOp.type !== "union" && setOp.type !== "union all") break;
        sides.push(statementToClause(setOp.left));
        ops.push(setOp.type === "union all" ? "union-all" : "union");
        node = setOp.right;
      }
      sides.push(statementToClause(node));

      let acc: SqlClause = sides[0]!;
      for (let i = 0; i < ops.length; i++) {
        acc = { [ops[i]!]: [acc, sides[i + 1]!] } as SqlClause;
      }
      return acc;
    }
    default:
      // For unsupported statements, return raw SQL
      return { raw: astToSql.statement(stmt) };
  }
}

/**
 * CTE (WITH) statement.
 *
 * Both the CTE bodies and the outer statement may be data-modifying — DuckDB
 * and PostgreSQL both accept `WITH d AS (DELETE FROM t RETURNING i) SELECT ...`
 * and `WITH x AS (...) UPDATE ...` — so neither is typed as a SELECT.
 */
type WithStatement = {
  type: "with";
  bind: Array<{
    alias: { name: string };
    statement: Statement;
  }>;
  in: Statement;
};

function withToClause(stmt: WithStatement): SqlClause {
  const clause: SqlClause = {};

  // Convert each CTE. Dispatching through statementToClause rather than
  // selectToClause is what makes data-modifying CTEs work.
  clause.with = stmt.bind.map((cte) => [
    cte.alias.name,
    statementToClause(cte.statement),
  ] as [string, SqlClause]);

  // Merge the main query
  const mainQuery = statementToClause(stmt.in);
  return { ...clause, ...mainQuery };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse a SQL string into a clause map.
 *
 * @param sql - SQL string to parse
 * @returns Clause map representation
 *
 * @example
 * ```ts
 * const clause = fromSql('SELECT id, name FROM users WHERE active = true');
 * // => { select: [":id", ":name"], from: ":users", where: ["=", ":active", true] }
 * ```
 */
/**
 * Callbacks handed to the DuckDB statement mini-parser and sentinel revival —
 * both re-enter fromSql for nested statements and expressions.
 */
const duckDbStatementCtx: StatementParseContext = {
  parseSub: (sql) => fromSql(sql, { dialect: "duckdb" }),
  parseExpr: (sql) => {
    const clause = fromSql(`SELECT ${sql}`, { dialect: "duckdb" });
    return (clause.select as SqlExpr[])[0]!;
  },
  parseSelectItem: (sql) => {
    const clause = fromSql(`SELECT ${sql}`, { dialect: "duckdb" });
    return (clause.select as SqlExpr[])[0]!;
  },
};

/**
 * Wrap the underlying parser's error into something readable. nearley's
 * default message is a wall of fifty expected-token names; the position and a
 * source snippet are what a human actually needs. The original error is kept
 * as `cause`.
 */
function parseError(sql: string, dialect: string, e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  const posMatch = /line (\d+) col (\d+)/.exec(message);
  let where = "";
  if (posMatch) {
    const line = Number(posMatch[1]);
    const col = Number(posMatch[2]);
    const source = sql.split("\n")[line - 1] ?? "";
    const start = Math.max(0, col - 31);
    const snippet = source.slice(start, col + 29);
    const caret = " ".repeat(col - 1 - start) + "^";
    where = ` at line ${line}, column ${col}:\n  ${snippet}\n  ${caret}`;
  }
  const err = new Error(
    `fromSql could not parse this statement (dialect: ${dialect})${where}`
  );
  (err as Error & { cause?: unknown }).cause = e;
  return err;
}

export function fromSql(
  sql: string,
  options: FromSqlOptions & { dialect: "duckdb" }
): DuckDBClause;
export function fromSql(sql: string, options?: FromSqlOptions): SqlClause;
export function fromSql(sql: string, options: FromSqlOptions = {}): SqlClause {
  if (options.dialect === "duckdb") {
    // Statement forms with no PostgreSQL analogue (PIVOT, DESCRIBE, SHOW, ...)
    // never reach the PostgreSQL parser at all.
    const dispatched = parseDuckDbStatement(sql, duckDbStatementCtx);
    if (dispatched) return dispatched as DuckDBClause;

    let stmt: Statement;
    try {
      stmt = parseFirst(preprocessDuckDb(sql));
    } catch (e) {
      throw parseError(sql, "duckdb", e);
    }
    return reviveSentinels(statementToClause(stmt), {
      parseStatement: (raw) => {
        const parsed = parseDuckDbStatement(raw, duckDbStatementCtx);
        return parsed ?? fromSql(raw, { dialect: "duckdb" });
      },
    }) as DuckDBClause;
  }
  let stmt: Statement;
  try {
    stmt = parseFirst(sql);
  } catch (e) {
    throw parseError(sql, "postgres", e);
  }
  return statementToClause(stmt);
}

/**
 * Parse multiple SQL statements.
 *
 * @param sql - SQL string containing one or more statements
 * @returns Array of clause maps
 */
export function fromSqlMulti(sql: string): SqlClause[] {
  const stmts = parse(sql);
  return stmts.map(statementToClause);
}

/**
 * Normalize SQL by parsing and reformatting.
 * Useful for comparing SQL strings.
 *
 * @param sql - SQL string to normalize
 * @returns Normalized SQL string
 */
export function normalizeSql(sql: string): string {
  const stmt = parseFirst(sql);
  return astToSql.statement(stmt);
}
