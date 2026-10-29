import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { appUrl, CHROME_EXECUTABLE } from "../support/audit-config.mjs";

const baseUrl = process.env.AUDIT_BASE_URL || "https://opgtime-test.vercel.app";
const artifactDir = path.resolve("output/playwright", `sanity-${Date.now()}`);
fs.mkdirSync(artifactDir, { recursive: true });
const credentials = {
  admin: ["admin@dev.local", process.env.SEED_ADMIN_PASSWORD || "Admin-dev-password-2026!"],
  hr: ["hr@dev.local", process.env.SEED_HR_PASSWORD || "Hr-dev-password-2026!"],
  manager: ["manager@dev.local", process.env.SEED_USER_PASSWORD || "User-dev-password-2026!"],
  user: ["user@dev.local", process.env.SEED_USER_PASSWORD || "User-dev-password-2026!"],
  readonly: ["readonly@dev.local", process.env.SEED_READONLY_PASSWORD || "Readonly-dev-password-2026!"],
};
const results = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_EXECUTABLE || CHROME_EXECUTABLE,
  timeout: 15000,
  args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"],
});

const text = (page) => page.locator("body").innerText();
const todayInTenant = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date()).replaceAll("/", "-");
const displayedDate = (iso) => new Intl.DateTimeFormat("en", { dateStyle: "medium" })
  .format(new Date(`${iso}T00:00:00`));

async function api(page, resource, query = "") {
  return page.evaluate(async ({ resource, query }) => {
    const response = await fetch(`/api/v1/${resource}${query ? `?${query}` : ""}`, { credentials: "include" });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { resource, query });
}

async function login(page, persona) {
  const [email, password] = credentials[persona];
  await page.goto(`${baseUrl}/#/app/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (persona === "admin") {
    await page.getByRole("heading", { name: "Platform overview" }).waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "Enter organization" }).first().click();
  }
  await page.getByRole("heading", { name: "Make your time count." }).waitFor({ timeout: 30000 });
}

async function run(name, persona, viewport, fn, options = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const consoleErrors = [];
  const requestFailures = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`));
  try {
    await login(page, persona);
    await fn(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflow, false, "unexpected horizontal overflow");
    const unexpectedConsoleErrors = options.allowExpectedNetworkErrors
      ? consoleErrors.filter((error) => !error.includes("401") && !error.includes("403"))
      : consoleErrors;
    const unexpectedRequestFailures = options.allowExpectedNetworkErrors
      ? requestFailures.filter((failure) => !failure.includes("/auth/logout"))
      : requestFailures;
    assert.equal(unexpectedConsoleErrors.length, 0, `browser console errors: ${unexpectedConsoleErrors.join(" | ")}`);
    assert.equal(unexpectedRequestFailures.length, 0, `failed requests: ${unexpectedRequestFailures.join(" | ")}`);
    await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
    results.push({ name, persona, viewport, status: "PASS" });
  } catch (error) {
    await page.screenshot({ path: path.join(artifactDir, `${name}-FAIL.png`), fullPage: true }).catch(() => {});
    results.push({ name, persona, viewport, status: "FAIL", error: error.message.split("\n")[0], consoleErrors, requestFailures });
  } finally {
    await context.close();
  }
}

const desktop = { width: 1280, height: 800 };
await run("invalid-login", "user", desktop, async (page) => {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  await page.getByLabel("Email").fill("unknown@dev.local");
  await page.getByLabel("Password").fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").waitFor();
}, { allowExpectedNetworkErrors: true });

await run("user-personal-data", "user", desktop, async (page) => {
  const employee = (await api(page, "employees")).body[0];
  const resources = await Promise.all(["leave-balances", "leave-requests", "leave-ledger-entries", "attendance-summaries", "attendance-adjustments"].map((resource) => api(page, resource)));
  for (const result of resources) {
    assert.equal(result.status, 200);
    assert.ok(result.body.every((row) => row.employee_id === employee.employee_id), "personal API response contains another employee");
  }
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await page.getByRole("heading", { name: "Leave" }).waitFor();
  const balanceRows = (await api(page, "leave-balances")).body;
  const leaveTypes = (await api(page, "leave-types")).body;
  const renderedAllowanceNames = await page.locator("main p.text-sm.font-bold.text-primary").allTextContents();
  assert.deepEqual([...renderedAllowanceNames].sort(), balanceRows.map((balance) => leaveTypes.find((row) => row.leave_type_id === balance.leave_type_id).name).sort(), "rendered allowance cards do not match personal balances");
  assert.equal(new Set(balanceRows.map((row) => `${row.leave_type_id}:${row.period}`)).size, balanceRows.length, "duplicate current allowance records");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByLabel("Search leave").fill("NO_MATCH_SANITY_CHECK");
  await page.getByText("No leave matches").waitFor();
  await page.getByLabel("Search leave").fill("");
  await page.getByRole("button", { name: "Attendance", exact: true }).click();
  await page.getByRole("heading", { name: "Attendance" }).waitFor();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByLabel("Search attendance").fill("NO_MATCH_SANITY_CHECK");
  await page.getByText("No attendance matches").waitFor();
  await page.getByLabel("Search attendance").fill("");
  const crossTenant = await page.evaluate(async () => (await fetch("/api/v1/employees", { headers: { "x-tenant-id": "harbor" }, credentials: "include" })).status);
  assert.equal(crossTenant, 403);
}, { allowExpectedNetworkErrors: true });

await run("user-clock-refresh-recent", "user", desktop, async (page) => {
  const clock = page.getByRole("button", { name: /Clock (in|out)/i });
  if ((await clock.textContent()).toLowerCase().includes("out")) {
    await clock.click();
    await page.getByRole("button", { name: "Clock in", exact: true }).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Make your time count." }).waitFor();
  }
  await page.getByRole("button", { name: "Clock in", exact: true }).click();
  await page.getByRole("button", { name: /Clock out/ }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Make your time count." }).waitFor();
  await page.getByRole("button", { name: /Clock out/ }).click();
  await page.getByRole("button", { name: "Clock in", exact: true }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Make your time count." }).waitFor();
  const summaries = (await api(page, "attendance-summaries")).body;
  assert.ok(summaries.some((row) => row.local_date === todayInTenant()), "clocked-out day was not persisted as a summary");
  await page.getByText("Recent attendance").waitFor();
  assert.match(await text(page), new RegExp(displayedDate(todayInTenant()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "latest attendance is not shown on dashboard");
  await page.getByLabel("Current local date and time").waitFor();
  const firstClock = await page.getByLabel("Current local date and time").locator("time").getAttribute("datetime");
  await page.waitForTimeout(1200);
  const secondClock = await page.getByLabel("Current local date and time").locator("time").getAttribute("datetime");
  assert.notEqual(firstClock, secondClock, "local navbar clock did not advance");
});

await run("hr-personal-and-team-boundaries", "hr", desktop, async (page) => {
  const employees = (await api(page, "employees")).body;
  const employee = employees.find((row) => row.employee_id === "ns-alex") || employees[0];
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await page.getByRole("heading", { name: "Leave" }).waitFor();
  const balances = (await api(page, "leave-balances")).body;
  assert.ok(balances.some((row) => row.employee_id !== employee.employee_id), "HR test data does not include tenant-wide balances");
  const leaveOptions = (await api(page, "hr/my-leave-options")).body;
  const renderedAllowanceNames = await page.locator("main p.text-sm.font-bold.text-primary").allTextContents();
  assert.deepEqual([...renderedAllowanceNames].sort(), leaveOptions.map((option) => option.name).sort(), "HR personal Leave does not match the signed-in employee's job mappings");
  await page.getByRole("button", { name: "Attendance", exact: true }).click();
  await page.getByRole("heading", { name: "Attendance" }).waitFor();
  const summaries = (await api(page, "attendance-summaries")).body;
  const personal = summaries.filter((row) => row.employee_id === employee.employee_id);
  const other = summaries.filter((row) => row.employee_id !== employee.employee_id);
  assert.ok(other.length, "HR test data does not include tenant-wide attendance");
  for (const row of other) {
    const marker = `${row.worked_mins} of ${row.scheduled_mins} minutes`;
    if (!personal.some((item) => `${item.worked_mins} of ${item.scheduled_mins} minutes` === marker)) assert.equal((await text(page)).includes(marker), false, "HR personal Attendance renders another employee's summary");
  }
  await page.getByRole("button", { name: "Team", exact: true }).last().click();
  await page.getByRole("heading", { name: "Team dashboard" }).waitFor();
  await page.locator("header").getByRole("button", { name: "Organization", exact: true }).click();
  await page.getByRole("heading", { name: "Organization overview" }).waitFor();
});

await run("manager-and-readonly-permissions", "manager", desktop, async (page) => {
  assert.equal(await page.getByRole("button", { name: "Organization", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Team", exact: true }).last().click();
  await page.getByRole("heading", { name: "Team dashboard" }).waitFor();
  await page.getByRole("button", { name: "Who’s in", exact: true }).click().catch(async () => page.getByRole("button", { name: /Who/ }).click());
  await page.getByRole("heading", { name: "Who’s in" }).waitFor();
});

await run("readonly-no-mutations", "readonly", desktop, async (page) => {
  assert.equal(await page.getByRole("button", { name: /Clock (in|out)/i }).count(), 0);
  await page.getByRole("button", { name: "Attendance", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Request correction" }).count(), 0);
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Request leave" }).count(), 0);
});

await run("admin-tenant-and-cross-tenant", "admin", desktop, async (page) => {
  await page.getByRole("button", { name: "Exit organization" }).click();
  await page.getByRole("heading", { name: "Platform overview" }).waitFor();
}, { allowExpectedNetworkErrors: true });

for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  await run(`responsive-${viewport.width}`, "user", viewport, async (page) => {
    const clock = page.getByLabel("Current local date and time");
    assert.equal(await clock.count(), 1, "navbar must contain exactly one local clock");
    assert.equal(await clock.isVisible(), true, "navbar clock is hidden at this viewport");
    if (viewport.width < 1024) {
      await page.getByLabel("Open navigation").click();
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await page.getByRole("heading", { name: "Leave" }).waitFor();
    }
  });
}

await fs.promises.writeFile(path.join(artifactDir, "results.json"), JSON.stringify({ baseUrl, results }, null, 2));
for (const result of results) console.log(`${result.status} | ${result.persona} | ${result.name}${result.error ? ` | ${result.error}` : ""}`);
console.log(`ARTIFACTS ${artifactDir}`);
console.log(`TOTAL ${results.length} | PASSED ${results.filter((result) => result.status === "PASS").length} | FAILED ${results.filter((result) => result.status === "FAIL").length}`);
await browser.close();
if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
