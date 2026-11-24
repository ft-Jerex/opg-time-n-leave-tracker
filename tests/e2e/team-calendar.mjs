import "dotenv/config";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchAuditBrowser, appUrl } from "../support/audit-config.mjs";

const browser = await launchAuditBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const leave = (id, employee, name, start, end, status) => ({
  request_id: id, employee_id: employee, name, leave_type_id: "ns-annual",
  start_date: start, end_date: end, status, reason: "Calendar test",
});
const rows = [
  leave("friday-monday", "e", "Friday Person", "2026-12-18", "2026-12-21", "approved"),
  leave("one", "a", "Alex One", "2026-12-21", "2026-12-24", "approved"),
  leave("two", "b", "Blair Two", "2026-12-21", "2026-12-23", "approved"),
  leave("pending-duplicate", "a", "Alex One", "2026-12-22", "2026-12-22", "pending"),
  leave("three", "c", "Casey Three", "2026-12-23", "2026-12-24", "approved"),
  leave("four", "d", "Dana Four", "2026-12-23", "2026-12-23", "approved"),
  leave("denied", "f", "Fran Denied", "2026-12-24", "2026-12-25", "rejected"),
];

try {
  await page.clock.install({ time: new Date("2026-12-01T12:00:00Z") });
  await page.route("**/api/v1/team/calendar*", (route) => route.fulfill({ json: rows }));
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill("manager@dev.local");
  await page.getByLabel("Password").fill(process.env.SEED_USER_PASSWORD || "User-dev-password-2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Make your time count." }).waitFor();
  await page.getByRole("button", { name: "Team", exact: true }).last().click();
  await page.getByRole("button", { name: "Team leave calendar" }).click();
  await page.getByRole("heading", { name: "Team leave calendar" }).waitFor();
  await page.getByLabel("Calendar legend").waitFor();

  const day = (number) => page.getByRole("group", { name: new RegExp(`December ${number}, 2026`) });
  assert.match(await day(21).getAttribute("class"), /bg-amber-50/);
  assert.match(await day(19).getAttribute("class"), /bg-white/);
  assert.match(await day(20).getAttribute("class"), /bg-white/);
  assert.doesNotMatch(await day(19).innerText(), /Friday Person/);
  assert.equal(await day(23).locator("span.block.truncate").count(), 3);
  assert.match(await day(23).innerText(), /\+1 more/);
  assert.equal(await day(23).evaluate((element) => element.getBoundingClientRect().height),
    await day(26).evaluate((element) => element.getBoundingClientRect().height));

  await day(23).hover();
  await day(23).getByRole("tooltip").waitFor();
  assert.match(await day(23).getByRole("tooltip").innerText(), /Dana Four/);
  await day(24).hover();
  assert.match(await day(24).getByRole("tooltip").innerText(), /Denied/);
  assert.match(await day(24).getByRole("tooltip").innerText(), /Approved/);
  assert.match(await day(24).getByRole("tooltip").getByText("Denied", { exact: true }).getAttribute("class"), /bg-red-100/);
  assert.match(await day(24).getByRole("tooltip").getByText("Approved", { exact: true }).first().getAttribute("class"), /bg-emerald-100/);
  assert.match(await day(25).getAttribute("class"), /bg-white/);
  assert.equal(await day(25).locator("span.block.truncate").count(), 0);

  await page.getByLabel("Include pending").check();
  assert.match(await day(22).getAttribute("class"), /bg-red-50/);
  await day(22).focus();
  await day(22).getByRole("tooltip").waitFor();
  assert.match(await day(22).getByRole("tooltip").innerText(), /Pending/);
  assert.match(await day(22).getByRole("tooltip").getByText("Pending", { exact: true }).getAttribute("class"), /bg-amber-100/);
  if (process.env.SCREENSHOT_DIR) {
    await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/team-calendar-desktop.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await day(24).hover();
  const tooltip = await day(24).getByRole("tooltip").boundingBox();
  assert.ok(tooltip && tooltip.x >= 0 && tooltip.x + tooltip.width <= 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/team-calendar-mobile.png`, fullPage: true });
  console.log("PASS team calendar legend, colors, weekend rules, three-name cap, tooltips, and mobile layout");
} finally {
  await browser.close();
}
