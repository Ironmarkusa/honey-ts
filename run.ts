#!/usr/bin/env npx tsx
/**
 * Convert between SQL and clause maps.
 *
 * Usage:
 *   echo '{"select": [":id"], "from": ":users"}' | npx tsx run.ts
 *   echo '{"select": [":id"], "from": ":users"}' | npx tsx run.ts --toSql
 *   echo 'SELECT id FROM users' | npx tsx run.ts --fromSql
 */

import { format, fromSql } from "./src/index.ts";
import "./src/pg-ops.ts";

const args = process.argv.slice(2);
const mode = args.includes("--fromSql") ? "fromSql" : "toSql";

const input = await new Promise<string>((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => data += chunk);
  process.stdin.on("end", () => resolve(data));
});

const trimmed = input.trim();

try {
  if (mode === "fromSql") {
    const clause = fromSql(trimmed);
    console.log(JSON.stringify(clause, null, 2));
  } else {
    const clause = JSON.parse(trimmed);
    const [sql, ...params] = format(clause);

    console.log("\x1b[36mSQL:\x1b[0m");
    console.log(sql);

    if (params.length > 0) {
      console.log("\n\x1b[33mParams:\x1b[0m");
      console.log(JSON.stringify(params, null, 2));
    }
  }
} catch (err) {
  console.error("\x1b[31mError:\x1b[0m", (err as Error).message);
  process.exit(1);
}
