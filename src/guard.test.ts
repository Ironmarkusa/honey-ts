/**
 * Tests for SQL guard functionality.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { guardSql, getOperation, collectTables, isTautology } from "./guard.js";
import { fromSql } from "./parser.js";
import type { GuardConfig } from "./guard.js";

describe("guardSql", () => {
  const defaultConfig: GuardConfig = {
    allowedTables: ["users", "orders", "staging.*"],
    allowedOperations: ["select"],
  };

  describe("operation checks", () => {
    it("allows permitted operations", () => {
      const clause = fromSql("SELECT * FROM users");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.violations, []);
    });

    it("blocks INSERT when only SELECT allowed", () => {
      const clause = fromSql("INSERT INTO users (name) VALUES ('Alice')");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("INSERT")));
    });

    it("blocks UPDATE when only SELECT allowed", () => {
      const clause = fromSql("UPDATE users SET name = 'Bob' WHERE id = 1");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("UPDATE")));
    });

    it("blocks DELETE when only SELECT allowed", () => {
      const clause = fromSql("DELETE FROM users WHERE id = 1");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("DELETE")));
    });

    it("allows INSERT when configured", () => {
      const config: GuardConfig = {
        ...defaultConfig,
        allowedOperations: ["select", "insert"],
      };
      const clause = fromSql("INSERT INTO users (name) VALUES ('Alice')");
      const result = guardSql(clause, config);
      assert.strictEqual(result.ok, true);
    });
  });

  describe("table checks", () => {
    it("allows tables in allow-list", () => {
      const clause = fromSql("SELECT * FROM users JOIN orders ON users.id = orders.user_id");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, true);
    });

    it("blocks tables not in allow-list", () => {
      const clause = fromSql("SELECT * FROM secrets");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("secrets")));
    });

    it("allows schema wildcard matches", () => {
      const clause = fromSql("SELECT * FROM staging.imports");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, true);
    });

    it("blocks non-matching schema", () => {
      const clause = fromSql("SELECT * FROM production.users");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("production.users")));
    });

    it("checks tables in subqueries", () => {
      const clause = fromSql("SELECT * FROM users WHERE id IN (SELECT user_id FROM secrets)");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("secrets")));
    });

    it("checks tables in JOINs", () => {
      const clause = fromSql("SELECT * FROM users JOIN secrets ON users.id = secrets.user_id");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("secrets")));
    });

    it("checks tables in CTEs", () => {
      const clause = fromSql("WITH s AS (SELECT * FROM secrets) SELECT * FROM s");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("secrets")));
    });
  });

  describe("WHERE requirements", () => {
    it("requires WHERE for DELETE when configured", () => {
      const config: GuardConfig = {
        allowedTables: ["users"],
        allowedOperations: ["delete"],
        requireWhere: ["delete"],
      };
      const clause = fromSql("DELETE FROM users");
      const result = guardSql(clause, config);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("DELETE requires WHERE")));
    });

    it("allows DELETE with WHERE when configured", () => {
      const config: GuardConfig = {
        allowedTables: ["users"],
        allowedOperations: ["delete"],
        requireWhere: ["delete"],
      };
      const clause = fromSql("DELETE FROM users WHERE id = 1");
      const result = guardSql(clause, config);
      assert.strictEqual(result.ok, true);
    });

    it("requires WHERE for UPDATE when configured", () => {
      const config: GuardConfig = {
        allowedTables: ["users"],
        allowedOperations: ["update"],
        requireWhere: ["update"],
      };
      const clause = fromSql("UPDATE users SET name = 'Bob'");
      const result = guardSql(clause, config);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("UPDATE requires WHERE")));
    });
  });

  describe("tautology detection", () => {
    it("detects WHERE 1=1", () => {
      const clause = fromSql("SELECT * FROM users WHERE 1 = 1");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("tautology")));
    });

    it("detects WHERE true", () => {
      const clause = fromSql("SELECT * FROM users WHERE true");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("tautology")));
    });

    it("allows legitimate WHERE clauses", () => {
      const clause = fromSql("SELECT * FROM users WHERE id = 1");
      const result = guardSql(clause, defaultConfig);
      assert.strictEqual(result.ok, true);
    });
  });

  describe("LIMIT requirements", () => {
    it("requires LIMIT when requireLimit is true", () => {
      const config: GuardConfig = {
        ...defaultConfig,
        requireLimit: true,
      };
      const clause = fromSql("SELECT * FROM users");
      const result = guardSql(clause, config);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("LIMIT")));
    });

    it("allows query without LIMIT when requireLimit is false", () => {
      const config: GuardConfig = {
        ...defaultConfig,
        requireLimit: false,
        maxRows: 1000,
      };
      const clause = fromSql("SELECT * FROM users");
      const result = guardSql(clause, config);
      assert.strictEqual(result.ok, true);
    });

    it("allows query with LIMIT under max", () => {
      const config: GuardConfig = {
        ...defaultConfig,
        maxRows: 1000,
      };
      const clause = fromSql("SELECT * FROM users LIMIT 100");
      const result = guardSql(clause, config);
      assert.strictEqual(result.ok, true);
    });

    it("blocks LIMIT exceeding max", () => {
      const config: GuardConfig = {
        ...defaultConfig,
        maxRows: 100,
      };
      const clause = fromSql("SELECT * FROM users LIMIT 500");
      const result = guardSql(clause, config);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some(v => v.includes("exceeds")));
    });

    it("can require LIMIT and enforce maxRows together", () => {
      const config: GuardConfig = {
        ...defaultConfig,
        requireLimit: true,
        maxRows: 100,
      };
      // No LIMIT - fails
      let result = guardSql(fromSql("SELECT * FROM users"), config);
      assert.strictEqual(result.ok, false);

      // LIMIT too high - fails
      result = guardSql(fromSql("SELECT * FROM users LIMIT 500"), config);
      assert.strictEqual(result.ok, false);

      // LIMIT ok - passes
      result = guardSql(fromSql("SELECT * FROM users LIMIT 50"), config);
      assert.strictEqual(result.ok, true);
    });
  });

  describe("multiple violations", () => {
    it("reports all violations", () => {
      const config: GuardConfig = {
        allowedTables: ["users"],
        allowedOperations: ["select"],
        maxRows: 100,
      };
      const clause = fromSql("DELETE FROM secrets WHERE 1 = 1");
      const result = guardSql(clause, config);
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.length >= 2);
    });
  });
});

describe("getOperation", () => {
  it("identifies SELECT", () => {
    assert.strictEqual(getOperation(fromSql("SELECT * FROM users")), "select");
  });

  it("identifies SELECT DISTINCT", () => {
    assert.strictEqual(getOperation(fromSql("SELECT DISTINCT name FROM users")), "select");
  });

  it("identifies INSERT", () => {
    assert.strictEqual(getOperation(fromSql("INSERT INTO users (name) VALUES ('x')")), "insert");
  });

  it("identifies UPDATE", () => {
    assert.strictEqual(getOperation(fromSql("UPDATE users SET name = 'x'")), "update");
  });

  it("identifies DELETE", () => {
    assert.strictEqual(getOperation(fromSql("DELETE FROM users")), "delete");
  });

  it("identifies UNION as select (from clause)", () => {
    // fromSql returns raw for UNION, so test with clause directly
    assert.strictEqual(getOperation({ union: [{ select: ["*"], from: "a" }, { select: ["*"], from: "b" }] }), "select");
  });
});

describe("collectTables", () => {
  it("collects FROM table", () => {
    const tables = collectTables(fromSql("SELECT * FROM users"));
    assert.ok(tables.includes("users"));
  });

  it("collects JOIN tables", () => {
    const tables = collectTables(fromSql("SELECT * FROM users JOIN orders ON users.id = orders.user_id"));
    assert.ok(tables.includes("users"));
    assert.ok(tables.includes("orders"));
  });

  it("collects INSERT target", () => {
    const tables = collectTables(fromSql("INSERT INTO users (name) VALUES ('x')"));
    assert.ok(tables.includes("users"));
  });

  it("collects UPDATE target", () => {
    const tables = collectTables(fromSql("UPDATE users SET name = 'x'"));
    assert.ok(tables.includes("users"));
  });

  it("collects DELETE target", () => {
    const tables = collectTables(fromSql("DELETE FROM users"));
    assert.ok(tables.includes("users"));
  });

  it("collects subquery tables", () => {
    const tables = collectTables(fromSql("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)"));
    assert.ok(tables.includes("users"));
    assert.ok(tables.includes("orders"));
  });

  it("deduplicates tables", () => {
    const tables = collectTables(fromSql("SELECT * FROM users u1 JOIN users u2 ON u1.id = u2.manager_id"));
    const usersCount = tables.filter(t => t === "users").length;
    assert.strictEqual(usersCount, 1);
  });
});

describe("isTautology", () => {
  it("detects true literal", () => {
    assert.strictEqual(isTautology(true), true);
  });

  it("detects {$: true}", () => {
    assert.strictEqual(isTautology({ $: true }), true);
  });

  it("detects 1=1", () => {
    assert.strictEqual(isTautology(["=", { $: 1 }, { $: 1 }]), true);
  });

  it("detects col=col", () => {
    assert.strictEqual(isTautology(["=", "id", "id"]), true);
  });

  it("detects tautology in OR", () => {
    assert.strictEqual(isTautology(["or", ["=", "id", { $: 1 }], true]), true);
  });

  it("rejects valid conditions", () => {
    assert.strictEqual(isTautology(["=", "id", { $: 1 }]), false);
  });

  it("rejects different values", () => {
    assert.strictEqual(isTautology(["=", { $: 1 }, { $: 2 }]), false);
  });
});
