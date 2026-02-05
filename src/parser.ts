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
        return `${ref.table.name}.${name}`;
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

      return [opMap[op] ?? op, left, right];
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
        over?: { partitionBy?: Expr[]; orderBy?: OrderByStatement[] };
      };

      // Use % prefix for function names (HoneySQL convention)
      let fnName = `%${call.function.name.toLowerCase()}`;

      // Handle DISTINCT in aggregate: COUNT(DISTINCT x)
      if (callAny.distinct) {
        fnName = `%${call.function.name.toLowerCase()}-distinct`;
      }

      const args = call.args.map(exprToClause);
      let fnCall: SqlExpr[] = [fnName, ...args];

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
      const typeDef = cast.to as { name?: string; kind?: string };
      const typeName = typeDef.name ?? typeDef.kind ?? "unknown";
      return ["cast", value, typeName];
    }

    case "list": {
      const list = expr as ExprList;
      return list.expressions.map(exprToClause);
    }

    case "member": {
      const mem = expr as ExprMember;
      const memAny = mem as unknown as { op: string };
      const obj = exprToClause(mem.operand);
      // member is a string literal, wrap as typed value
      const prop = { $: mem.member };
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
      return { $: (expr as ExprInteger).value };

    case "numeric":
      return { $: (expr as ExprNumeric).value };

    case "string":
      return { $: (expr as ExprString).value };

    case "boolean":
      return { $: (expr as ExprBool).value };

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
      const stmtAny = stmt as unknown as { lateral?: boolean };
      let subquery: SqlExpr = selectToClause(stmt.statement as SelectFromStatement);

      // Handle LATERAL subqueries
      if (stmtAny.lateral) {
        subquery = ["lateral", subquery];
      }

      if (stmt.alias) {
        return [subquery, stmt.alias];
      }

      return subquery;
    }

    // For joins and other complex froms, use the first part
    return { __raw: astToSql.from(f) };
  });
}

/**
 * Convert JOIN clauses.
 */
function joinsToClause(froms: From[] | undefined): [string, [SqlExpr, SqlExpr][]][] {
  if (!froms) return [];

  const joins: [string, [SqlExpr, SqlExpr][]][] = [];

  for (const f of froms) {
    if (f.type === "table" && (f as FromTable).join) {
      const table = f as FromTable;
      const joinInfo = table.join!;

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

      const tableName = nameToIdent(table.name);
      const tableExpr: SqlExpr = table.name.alias
        ? [tableName, table.name.alias]
        : tableName;

      const condition = exprToClause(joinInfo.on);

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
    const subqueries = stmt.from.filter((f) => f.type === "statement");

    const fromItems = [...fromToClause(baseTables) ?? [], ...fromToClause(subqueries) ?? []];
    if (fromItems.length > 0) {
      // Only unwrap if single item AND it's a simple identifier (not [table, alias])
      if (fromItems.length === 1 && typeof fromItems[0] === "string") {
        clause.from = fromItems[0];
      } else {
        clause.from = fromItems;
      }
    }

    // JOINs
    const joins = joinsToClause(joinTables);
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
    default:
      // For unsupported statements, return raw SQL
      return { raw: astToSql.statement(stmt) };
  }
}

/** CTE (WITH) statement */
type WithStatement = {
  type: "with";
  bind: Array<{
    alias: { name: string };
    statement: SelectFromStatement;
  }>;
  in: SelectFromStatement;
};

function withToClause(stmt: WithStatement): SqlClause {
  const clause: SqlClause = {};

  // Convert each CTE
  clause.with = stmt.bind.map((cte) => [
    cte.alias.name,
    selectToClause(cte.statement),
  ] as [string, SqlClause]);

  // Merge the main query
  const mainQuery = selectToClause(stmt.in);
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
export function fromSql(sql: string): SqlClause {
  const stmt = parseFirst(sql);
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
