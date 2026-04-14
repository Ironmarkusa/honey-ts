import { describe, it } from "node:test";
import assert from "node:assert";
import {
  col,
  op,
  fn,
  dateRange,
  and,
  or,
  not,
  anyOf,
  allOf,
  inScope,
  any,
  none,
  identString,
  identParts,
} from "./matchers.js";

describe("identString / identParts", () => {
  it("converts string identifiers", () => {
    assert.strictEqual(identString("foo"), "foo");
    assert.strictEqual(identString("a.b.c"), "a.b.c");
    assert.deepStrictEqual(identParts("a.b.c"), ["a", "b", "c"]);
  });

  it("converts qualified {ident:[...]} identifiers", () => {
    assert.strictEqual(identString({ ident: ["a", "b"] }), "a.b");
    assert.deepStrictEqual(identParts({ ident: ["a", "b"] }), ["a", "b"]);
  });

  it("returns null for non-identifiers", () => {
    assert.strictEqual(identString({ v: 1 }), null);
    assert.strictEqual(identString(42), null);
    assert.strictEqual(identString(["=", "a", 1]), null);
    assert.strictEqual(identParts({ $: "x" }), null);
  });
});

describe("col matcher", () => {
  it("matches bare column names", () => {
    const m = col("email");
    assert.strictEqual(m("email"), true);
    assert.strictEqual(m("users.email"), true);
    assert.strictEqual(m({ ident: ["u", "email"] }), true);
    assert.strictEqual(m("id"), false);
  });

  it("matches qualified column names strictly", () => {
    const m = col("users.email");
    assert.strictEqual(m("users.email"), true);
    assert.strictEqual(m({ ident: ["users", "email"] }), true);
    assert.strictEqual(m("u.email"), false);
    assert.strictEqual(m("email"), false);
  });

  it("does not match non-identifiers", () => {
    const m = col("email");
    assert.strictEqual(m(42), false);
    assert.strictEqual(m({ v: "email" }), false);
    assert.strictEqual(m(["=", "email", 1]), false);
  });
});

describe("op matcher", () => {
  it("matches array expressions by operator", () => {
    const m = op("=");
    assert.strictEqual(m(["=", "x", { v: 1 }]), true);
    assert.strictEqual(m(["<", "x", { v: 1 }]), false);
  });

  it("matches logical operators", () => {
    assert.strictEqual(op("and")(["and", ["=", "a", 1], ["=", "b", 2]]), true);
    assert.strictEqual(op("or")(["or", ["=", "a", 1]]), true);
    assert.strictEqual(op("between")(["between", "x", 1, 10]), true);
  });

  it("does not match non-array nodes", () => {
    assert.strictEqual(op("=")("="), false);
    assert.strictEqual(op("=")({ v: "=" }), false);
  });
});

describe("fn matcher", () => {
  it("matches function calls with or without leading %", () => {
    const m1 = fn("count");
    const m2 = fn("%count");
    assert.strictEqual(m1(["%count", "*"]), true);
    assert.strictEqual(m2(["%count", "*"]), true);
    assert.strictEqual(m1(["%sum", "amount"]), false);
  });
});

describe("dateRange matcher", () => {
  it("matches strict range ops with date-looking values when unconstrained", () => {
    const m = dateRange();
    assert.strictEqual(m([">=", "date", { v: "2024-01-01" }]), true);
    assert.strictEqual(m(["<", "created_at", { v: "2024-02-01" }]), true);
    assert.strictEqual(m([">", "d", { v: "2024-01-01" }]), true);
    assert.strictEqual(m(["<=", "d", { v: "2024-01-01" }]), true);
    assert.strictEqual(m(["between", "d", { v: "2024-01-01" }, { v: "2024-12-31" }]), true);
  });

  it("matches DATE-cast literals (pgsql parser output)", () => {
    const m = dateRange();
    assert.strictEqual(m([">=", "d", ["cast", { v: "2024-01-01" }, "date"]]), true);
  });

  it("does not match numeric range when unconstrained (spend > 100)", () => {
    assert.strictEqual(dateRange()([">", "spend", { v: 100 }]), false);
  });

  it("does not match equality (ambiguous with non-date)", () => {
    assert.strictEqual(dateRange()(["=", "status", { v: "active" }]), false);
  });

  it("constrained dateRange trusts the caller and matches any value", () => {
    // With explicit column, we trust the caller to know the type
    assert.strictEqual(dateRange("spend")([">", "spend", { v: 100 }]), true);
  });

  it("does not match AND/OR or non-range ops", () => {
    assert.strictEqual(dateRange()(["and", ["=", "a", 1]]), false);
    assert.strictEqual(dateRange()(["in", "status", [{ v: "a" }]]), false);
    assert.strictEqual(dateRange()(["like", "name", { v: "a%" }]), false);
  });

  it("requires left side to be a column ident", () => {
    // value-to-value comparisons shouldn't match
    assert.strictEqual(dateRange()(["<", { v: 1 }, { v: 2 }]), false);
  });

  it("constrains to specific column when given", () => {
    const m = dateRange("created_at");
    assert.strictEqual(m([">=", "created_at", { v: "2024-01-01" }]), true);
    assert.strictEqual(m([">=", "t.created_at", { v: "2024-01-01" }]), true);
    assert.strictEqual(m([">=", "updated_at", { v: "2024-01-01" }]), false);
  });
});

describe("combinators", () => {
  it("and requires all matchers", () => {
    const m = and(op("="), (node) =>
      Array.isArray(node) && node[1] === "status"
    );
    assert.strictEqual(m(["=", "status", { v: "a" }]), true);
    assert.strictEqual(m(["=", "name", { v: "a" }]), false);
    assert.strictEqual(m(["<", "status", { v: "a" }]), false);
  });

  it("or matches any", () => {
    const m = or(op("="), op(">"));
    assert.strictEqual(m(["=", "a", 1]), true);
    assert.strictEqual(m([">", "a", 1]), true);
    assert.strictEqual(m(["<", "a", 1]), false);
  });

  it("not inverts", () => {
    const m = not(op("and"));
    assert.strictEqual(m(["=", "a", 1]), true);
    assert.strictEqual(m(["and", ["=", "a", 1]]), false);
  });

  it("allOf / anyOf are aliases for and / or", () => {
    assert.strictEqual(allOf(any, any)(["=", "a", 1]), true);
    assert.strictEqual(anyOf(none, any)(["=", "a", 1]), true);
  });

  it("inScope filters by context scope", () => {
    const m = inScope((s) => s.startsWith("cte:"));
    assert.strictEqual(m(["=", "a", 1], { scope: "cte:foo", path: "" }), true);
    assert.strictEqual(m(["=", "a", 1], { scope: "root", path: "" }), false);
    // no ctx → always false
    assert.strictEqual(m(["=", "a", 1]), false);
  });

  it("any and none are constants", () => {
    assert.strictEqual(any("x"), true);
    assert.strictEqual(none("x"), false);
  });
});
