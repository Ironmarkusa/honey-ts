/**
 * HoneySQL TypeScript REPL
 *
 * Run with: npx tsx repl.ts
 */

import * as readline from "node:readline";
import {
  format,
  select,
  from,
  where,
  merge,
  join,
  leftJoin,
  insertInto,
  values,
  update,
  set,
  deleteFrom,
  orderBy,
  limit,
  offset,
  groupBy,
  having,
  onConflict,
  doUpdateSet,
  doNothing,
  returning,
  with_,
  union,
  raw,
  param,
  lift,
} from "./src/index.js";

// Import PG operators
import "./src/pg-ops.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    HoneySQL TypeScript REPL                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Type JavaScript/TypeScript expressions to build SQL queries  ║
║  All helpers are available: select, from, where, merge, etc.  ║
║                                                               ║
║  Tips:                                                        ║
║  - Use :prefix for identifiers: ":users", ":id"               ║
║  - Use qualified names: "u.id", "schema/table"                ║
║  - Plain strings are values: "active", "hello@example.com"    ║
║                                                               ║
║  Type 'examples' for examples, 'quit' to exit                 ║
╚═══════════════════════════════════════════════════════════════╝
`);

const examples = `
Examples:
─────────

// Basic SELECT
format({ select: [":id", ":name"], from: ":users" })

// SELECT with WHERE
format({ select: ["*"], from: ":users", where: ["=", ":id", 1] })

// Complex WHERE
format({ select: ["*"], from: ":users", where: ["and", ["=", ":status", "active"], [">", ":age", 18]] })

// JOIN
format({ select: ["u.id", "o.total"], from: [[":users", ":u"]], join: [[[":orders", ":o"], ["=", "u.id", "o.user_id"]]] })

// INSERT
format({ "insert-into": ":users", values: [{ name: "Alice", email: "alice@example.com" }] })

// UPDATE
format({ update: ":users", set: { name: "Bob" }, where: ["=", ":id", 1] }, { checking: "none" })

// DELETE
format({ "delete-from": ":users", where: ["=", ":id", 1] }, { checking: "none" })

// UPSERT
format({ "insert-into": ":users", values: [{ id: 1, name: "Alice" }], "on-conflict": [":id"], "do-update-set": { fields: [":name"] } })

// Using helpers
format(merge(select(":id", ":name"), from(":users"), where(["=", ":active", true])))

// WITH (CTE)
format({ with: [[":active_users", { select: ["*"], from: ":users", where: ["=", ":active", true] }]], select: ["*"], from: ":active_users" })

// JSON operators (PostgreSQL)
format({ select: [["->", ":data", "name"]], from: ":users" })

// Inline values (no parameters)
format({ select: ["*"], from: ":users", where: ["=", ":id", 42] }, { inline: true })
`;

function prompt() {
  rl.question("\nhoney> ", async (input) => {
    const trimmed = input.trim();

    if (trimmed === "quit" || trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      return;
    }

    if (trimmed === "examples") {
      console.log(examples);
      prompt();
      return;
    }

    if (!trimmed) {
      prompt();
      return;
    }

    try {
      // Create a function with all helpers in scope
      const fn = new Function(
        "format", "select", "from", "where", "merge", "join", "leftJoin",
        "insertInto", "values", "update", "set", "deleteFrom", "orderBy",
        "limit", "offset", "groupBy", "having", "onConflict", "doUpdateSet",
        "doNothing", "returning", "with_", "union", "raw", "param", "lift",
        `return (${trimmed})`
      );
      const result = fn(
        format, select, from, where, merge, join, leftJoin,
        insertInto, values, update, set, deleteFrom, orderBy,
        limit, offset, groupBy, having, onConflict, doUpdateSet,
        doNothing, returning, with_, union, raw, param, lift
      );

      if (Array.isArray(result) && typeof result[0] === "string") {
        // Looks like a format result
        const [sql, ...params] = result;
        console.log("\n\x1b[36mSQL:\x1b[0m", sql);
        if (params.length > 0) {
          console.log("\x1b[33mParams:\x1b[0m", params);
        }
      } else {
        console.log("\n\x1b[32mResult:\x1b[0m", JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error("\n\x1b[31mError:\x1b[0m", (err as Error).message);
    }

    prompt();
  });
}

prompt();
