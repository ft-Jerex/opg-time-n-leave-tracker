import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { CHROME_EXECUTABLE } from "../support/audit-config.mjs";

const baseUrl = process.env.AUDIT_BASE_URL || "https://opgtime-test.vercel.app";
const artifactDir = path.resolve("output/playwright", `time-leave-overtime-${Date.now()}`);
fs.mkdirSync(artifactDir, { recursive: true });
const credentials = {
  hr: ["hr@dev.local", process.env.SEED_HR_PASSWORD || "Hr-dev-password-2026!"],
  manager: ["manager@dev.local", process.env.SEED_USER_PASSWORD || "User-dev-password-2026!"],
  user: ["user@dev.local", process.env.SEED_USER_PASSWORD || "User-dev-password-2026!"],
};
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || CHROME_EXECUTABLE, headless: true, timeout: 15000, args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"] });
const results = [];
const workingDate = (offset) => {
  const date = new Date(Date.UTC(2090, 0, 1 + (Date.now() % 40) + offset));
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};
const testDates = { leave: workingDate(0), managerOvertime: workingDate(3), hrOvertime: workingDate(6), attendance: workingDate(9) };

async function api(page, resource, options = {}) {
  return page.evaluate(async ({ resource, options }) => {
    const csrf = decodeURIComponent(document.cookie.split("; ").find((item) => item.startsWith("tlt_csrf="))?.split("=").slice(1).join("=") || "");
    const response = await fetch(`/api/v1/${resource}`, {
      credentials: "include",
      method: options.method || "GET",
      headers: { "content-type": "application/json", ...(options.method && options.method !== "GET" ? { "x-csrf-token": csrf } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { resource, options });
}

async function login(persona, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(`${baseUrl}/?e2e=${Date.now()}#/app/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  const [email, password] = credentials[persona];
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Make your time count." }).waitFor();
  return { context, page };
}

async function save(page, name) {
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
}

async function submitLeave(page, reason, dateValue) {
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await page.getByRole("heading", { name: "Leave" }).waitFor();
  await page.getByRole("button", { name: "Request leave", exact: true }).click();
  await page.getByLabel("Leave type").selectOption("ns-annual");
  await page.getByLabel("From").fill(dateValue);
  await page.getByLabel("To").fill(dateValue);
  await page.getByLabel("Leave duration").selectOption("custom_hours");
  await page.getByLabel("Partial start").fill("07:00");
  await page.getByLabel("Partial end").fill("10:00");
  await page.getByLabel("Reason").fill(reason);
  await page.getByRole("button", { name: "Submit request", exact: true }).click();
  try { await page.getByText(reason, { exact: false }).waitFor(); } catch (error) {
    await page.screenshot({ path: path.join(artifactDir, "employee-custom-partial-leave-FAIL.png"), fullPage: true });
    console.error(await page.locator("body").innerText());
    throw error;
  }
}

async function submitOvertime(page, reason, dateValue) {
  await page.getByRole("button", { name: "Attendance", exact: true }).click();
  await page.getByRole("heading", { name: "Attendance" }).waitFor();
  await page.getByRole("button", { name: "Request overtime", exact: true }).click();
  await page.getByRole("textbox", { name: "Date", exact: true }).fill(dateValue);
  await page.getByLabel("Start time").fill("18:00");
  await page.getByLabel("End time").fill("20:00");
  await page.getByLabel("Reason").fill(reason);
  await page.getByRole("button", { name: "Submit for approval", exact: true }).click();
  await page.getByText(reason, { exact: false }).waitFor();
}

async function approveReason(page, reason) {
  await page.getByRole("button", { name: "Team", exact: true }).last().click();
  await page.getByRole("button", { name: "Approvals", exact: true }).last().click();
  await page.getByRole("heading", { name: "Approvals" }).waitFor();
  const card = page.getByText(reason, { exact: true }).locator("xpath=ancestor::div[.//button[normalize-space()='Approve']][1]");
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByText(reason, { exact: true }).waitFor({ state: "detached" });
}

const user = await login("user");
try {
  const leaveReason = `Browser custom leave ${Date.now()}`;
  await submitLeave(user.page, leaveReason, testDates.leave);
  const leaveRows = await api(user.page, "leave-requests");
  const leave = leaveRows.body.find((row) => row.reason === leaveReason);
  assert.equal(leaveRows.status, 200);
  assert.equal(leave.partial_start_time.slice(0, 5), "07:00");
  assert.equal(leave.partial_end_time.slice(0, 5), "10:00");
  assert.equal(leave.partial_minutes, 180);
  await save(user.page, "employee-custom-partial-leave");
  results.push({ scenario: "employee-custom-partial-leave", status: "PASS", request_id: leave.request_id });

  const manager = await login("manager");
  try {
    await approveReason(manager.page, leaveReason);
    const approvedLeave = await api(manager.page, "leave-requests");
    assert.equal(approvedLeave.body.find((row) => row.request_id === leave.request_id).status, "approved");
    results.push({ scenario: "manager-approves-custom-leave", status: "PASS" });
  } finally { await manager.context.close(); }

  await user.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await user.page.getByRole("button", { name: "Leave", exact: true }).click();
  await user.page.getByRole("heading", { name: "Leave" }).waitFor();
  const approvedRequest = user.page.getByText(leaveReason, { exact: true }).locator("xpath=ancestor::div[.//button[normalize-space()='Cancel leave']][1]");
  user.page.once("dialog", (dialog) => dialog.accept());
  await approvedRequest.getByRole("button", { name: "Cancel leave", exact: true }).click();
  const cancelledLeave = await api(user.page, "leave-requests");
  assert.equal(cancelledLeave.body.find((row) => row.request_id === leave.request_id).status, "cancelled");
  results.push({ scenario: "employee-cancels-approved-leave", status: "PASS" });

  const overtimeReason = `Browser manager overtime ${Date.now()}`;
  await submitOvertime(user.page, overtimeReason, testDates.managerOvertime);
  const overtimeRows = await api(user.page, "overtime-requests");
  const overtime = overtimeRows.body.find((row) => row.reason === overtimeReason);
  assert.equal(overtime.status, "pending");
  assert.equal(overtime.requested_mins, 120);
  const manager2 = await login("manager");
  try {
    await approveReason(manager2.page, overtimeReason);
    const approved = await api(manager2.page, "overtime-requests");
    assert.equal(approved.body.find((row) => row.overtime_request_id === overtime.overtime_request_id).status, "approved");
    results.push({ scenario: "manager-approves-overtime", status: "PASS" });
  } finally { await manager2.context.close(); }

  const hrReason = `Browser HR-approved overtime ${Date.now()}`;
  await submitOvertime(user.page, hrReason, testDates.hrOvertime);
  const hr = await login("hr");
  try {
    await approveReason(hr.page, hrReason);
    const approved = await api(hr.page, "overtime-requests");
    assert.equal(approved.body.find((row) => row.reason === hrReason).status, "approved");
    await hr.page.getByRole("button", { name: "Organization", exact: true }).last().click();
    await hr.page.getByRole("button", { name: "Overrides", exact: true }).click();
    await hr.page.getByRole("heading", { name: "Override controls" }).waitFor();
    await hr.page.getByLabel("Attendance override employee").selectOption("ns-morgan");
    await hr.page.getByRole("textbox", { name: "Date", exact: true }).fill(testDates.attendance);
    await hr.page.getByLabel("Clock in").fill("07:30");
    await hr.page.getByLabel("Clock out (optional)").fill("16:30");
    await hr.page.getByLabel("Required reason").last().fill(`Browser HR attendance ${Date.now()}`);
    hr.page.once("dialog", (dialog) => dialog.accept());
    await hr.page.getByRole("button", { name: "Apply attendance override", exact: true }).click();
    await hr.page.getByRole("status").filter({ hasText: "Attendance added" }).waitFor();
    const sessions = await api(hr.page, "attendance-sessions");
    assert.ok(sessions.body.some((row) => row.employee_id === "ns-morgan" && row.source === "hr_bulk_override" && row.status === "closed"));
    await save(hr.page, "hr-attendance-override-and-overtime");
    results.push({ scenario: "hr-approves-overtime-and-adds-attendance", status: "PASS" });
  } finally { await hr.context.close(); }
} finally { await user.context.close(); }

const responsive = await login("user", { width: 360, height: 800 });
try {
  await responsive.page.getByRole("button", { name: "Open navigation" }).click();
  await responsive.page.getByRole("button", { name: "Leave", exact: true }).click();
  await responsive.page.getByRole("button", { name: "Request leave", exact: true }).click();
  assert.equal(await responsive.page.getByLabel("Partial start").count(), 0);
  await responsive.page.getByLabel("Leave duration").selectOption("custom_hours");
  assert.equal(await responsive.page.getByLabel("Partial start").count(), 1);
  assert.equal(await responsive.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await save(responsive.page, "responsive-custom-leave-form");
  results.push({ scenario: "responsive-custom-leave-form", status: "PASS" });
} finally { await responsive.context.close(); }

await fs.promises.writeFile(path.join(artifactDir, "results.json"), JSON.stringify({ baseUrl, results }, null, 2));
console.log(`ARTIFACTS ${artifactDir}`);
for (const result of results) console.log(`${result.status} | ${result.scenario}`);
await browser.close();
