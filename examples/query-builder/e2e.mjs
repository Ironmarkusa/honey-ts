/**
 * Headless smoke test for the query-builder demo.
 *
 *   npm run demo          # in one terminal
 *   node examples/query-builder/e2e.mjs   # in another
 *
 * Screenshots land in $SHOTS_DIR (default: os tmpdir).
 */
import { chromium } from "playwright";
import { tmpdir } from "node:os";

const shots = process.env.SHOTS_DIR ?? tmpdir();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const step = (name, ok, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);

await page.goto("http://localhost:4321/");
await page.waitForTimeout(800); // let datastar + tailwind boot

// 1. Sample button fills textarea + parses (tests data-on:click, $sql assignment, @post)
await page.click("text=analytics join");
await page.waitForTimeout(600);
const sqlVal = await page.inputValue("textarea");
step("sample click fills textarea via $sql", sqlVal.includes("SELECT u.plan"));
const builderText = await page.textContent("#builder");
step("parse rendered builder", /where/i.test(builderText), builderText.slice(0, 80).replace(/\s+/g, " "));
const out1 = await page.textContent("#output");
step("output shows SQL", out1.includes("SELECT"), out1.slice(0, 100).replace(/\s+/g, " "));
await page.screenshot({ path: `${shots}/1-parsed.png`, fullPage: true });

// 2. Edit a predicate value → SQL updates live (tests data-on:change on inputs)
const valueInputs = page.locator("#builder input[data-on\\:change]");
const n = await valueInputs.count();
step("editable inputs present", n > 0, `${n} inputs`);
// find the input whose value is 't1' (tenant) to make the change visible
let tenantInput = null;
for (let i = 0; i < n; i++) {
  const v = await valueInputs.nth(i).inputValue();
  if (v === "t1") { tenantInput = valueInputs.nth(i); break; }
}
if (tenantInput) {
  await tenantInput.fill("acme-corp");
  await tenantInput.dispatchEvent("change");
  await page.waitForTimeout(600);
  const out2 = await page.textContent("#output");
  step("edited value re-emits SQL", out2.includes("acme-corp") || out2.includes("?"), out2.slice(0, 140).replace(/\s+/g, " "));
} else {
  step("edited value re-emits SQL", false, "no t1 input found");
}
await page.screenshot({ path: `${shots}/2-edited.png`, fullPage: true });

// 3. Toggle AND→OR (tests data-on:click on rendered fragments)
const toggle = page.locator("#builder button", { hasText: /^AND$/i }).first();
if (await toggle.count()) {
  await toggle.click();
  await page.waitForTimeout(600);
  const out3 = await page.textContent("#output");
  step("AND→OR toggle", /\bOR\b/.test(out3), out3.slice(0, 140).replace(/\s+/g, " "));
} else {
  step("AND→OR toggle", false, "no AND button found");
}

// 4. Dialect switch re-renders (tests header buttons + /render)
await page.click("header >> text=duckdb");
await page.waitForTimeout(600);
const duckActive = await page.locator("header button", { hasText: "duckdb" }).getAttribute("class");
step("duckdb toggle styled active", duckActive.includes("amber"), duckActive.split(" ").filter(c => c.includes("amber")).join(","));
await page.screenshot({ path: `${shots}/3-duckdb.png`, fullPage: true });

// 5. duckdb-only sample parses under duckdb front end
await page.click("text=duckdb-only");
await page.waitForTimeout(800);
const out5 = await page.textContent("#output");
step("duckdb-only sample (comprehension+QUALIFY) parses", out5.includes("QUALIFY") || out5.includes("list_"), out5.slice(0, 160).replace(/\s+/g, " "));
await page.screenshot({ path: `${shots}/4-duckdb-sample.png`, fullPage: true });

// 6. Remove a condition (tests /remove + AND-healing)
await page.click("text=nested logic");
await page.waitForTimeout(600);
const removes = page.locator("#builder button[title='Remove']");
const beforeOut = await page.textContent("#output");
if (await removes.count()) {
  await removes.first().click();
  await page.waitForTimeout(600);
  const afterOut = await page.textContent("#output");
  step("remove condition changes SQL", afterOut !== beforeOut, afterOut.slice(0, 120).replace(/\s+/g, " "));
} else {
  step("remove condition changes SQL", false, "no remove buttons");
}
await page.screenshot({ path: `${shots}/5-removed.png`, fullPage: true });

// 7. Operator dropdown reshapes the node by arity (single → none → list → range)
await page.click("text=nested logic");
await page.waitForTimeout(600);
const opSels = page.locator("#builder select[data-on\\:change*='set-op']");
await opSels.nth(0).selectOption("is"); // status = 'a'  →  status IS NULL
await page.waitForTimeout(600);
let outOp = await page.textContent("#output");
step("op → IS NULL (none arity)", /IS NULL/i.test(outOp), outOp.slice(0, 140).replace(/\s+/g, " "));

await page.locator("#builder select[data-on\\:change*='set-op']").nth(0).selectOption("in");
await page.waitForTimeout(600);
await page.click("#builder button[title='Add value']");
await page.waitForTimeout(600);
outOp = await page.textContent("#output");
step("op → IN + add item (list arity)", /IN \(/i.test(outOp), outOp.slice(0, 160).replace(/\s+/g, " "));

await page.locator("#builder select[data-on\\:change*='set-op']").nth(1).selectOption("between");
await page.waitForTimeout(600);
outOp = await page.textContent("#output");
step("op → BETWEEN (range arity)", /BETWEEN/i.test(outOp), outOp.slice(0, 160).replace(/\s+/g, " "));
await page.screenshot({ path: `${shots}/6-reshaped.png`, fullPage: true });

// 8. Edit a nested function argument in SELECT (sum(o.total) → sum(o.subtotal))
await page.click("text=analytics join");
await page.waitForTimeout(600);
const builderInputs = page.locator("#builder input[data-on\\:change*='/edit']");
const bn = await builderInputs.count();
let argInput = null;
for (let i = 0; i < bn; i++) {
  if ((await builderInputs.nth(i).inputValue()) === "o.total") { argInput = builderInputs.nth(i); break; }
}
if (argInput) {
  await argInput.fill("o.subtotal");
  await argInput.dispatchEvent("change");
  await page.waitForTimeout(600);
  const outFn = await page.textContent("#output");
  step("nested fn arg edit re-emits", outFn.includes("o.subtotal"), outFn.slice(0, 160).replace(/\s+/g, " "));
} else {
  step("nested fn arg edit re-emits", false, "no o.total input found");
}
await page.screenshot({ path: `${shots}/7-fn-arg-edit.png`, fullPage: true });

step("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
await browser.close();
