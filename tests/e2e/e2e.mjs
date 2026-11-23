import "dotenv/config";
import { launchAuditBrowser, appUrl } from "../support/audit-config.mjs";

const credentials = {
  admin: [
    "admin@dev.local",
    process.env.SEED_ADMIN_PASSWORD || "Admin-dev-password-2026!",
  ],
  hr: [
    "hr@dev.local",
    process.env.SEED_HR_PASSWORD || process.env.SEED_ADMIN_PASSWORD || "Admin-dev-password-2026!",
  ],
  manager: [
    "manager@dev.local",
    process.env.SEED_USER_PASSWORD || "User-dev-password-2026!",
  ],
  user: [
    "user@dev.local",
    process.env.SEED_USER_PASSWORD || "User-dev-password-2026!",
  ],
  readonly: [
    "readonly@dev.local",
    process.env.SEED_READONLY_PASSWORD || "Readonly-dev-password-2026!",
  ],
};
const browser = await launchAuditBrowser();
const results = [];
const flowId = `E2E-${Date.now()}`;
const correctionId = `Attendance-${Date.now()}`;
const leaveFrom = new Date(
  Date.UTC(2040, 0, 1 + Math.floor(Math.random() * 10000)),
);
while ([0, 6].includes(leaveFrom.getUTCDay()))
  leaveFrom.setUTCDate(leaveFrom.getUTCDate() + 1);
const leaveTo = new Date(leaveFrom.getTime() + 86400000);
const isoDate = (value) => value.toISOString().slice(0, 10);
const usDate = (value) => `${String(value.getUTCMonth() + 1).padStart(2, "0")}/${String(value.getUTCDate()).padStart(2, "0")}/${value.getUTCFullYear()}`;

async function test(
  name,
  run,
  viewport = { width: 1280, height: 900 },
  allowHttpErrors = false,
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.setDefaultTimeout(15000);
  try {
    await page.goto(appUrl(), {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await run(page);
    const unexpectedErrors = allowHttpErrors
      ? consoleErrors.filter(
          (message) => !message.startsWith("Failed to load resource:"),
        )
      : consoleErrors;
    if (unexpectedErrors.length)
      throw new Error(`browser console errors: ${consoleErrors.join(" | ")}`);
    results.push(["PASS", name]);
  } catch (error) {
    results.push(["FAIL", name, `${error.message.split("\n")[0]} ${error.stack?.replaceAll("\n", " | ") || ""}`]);
  } finally {
    await context.close();
  }
}

async function signIn(page, persona) {
  const [email, password] = credentials[persona];
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: persona === "admin" ? "Platform overview" : "Make your time count." }).waitFor();
}

await test(
  "invalid credentials return an accessible error",
  async (page) => {
    await page.getByLabel("Email").fill("unknown@dev.local");
    await page.getByLabel("Password").fill("incorrect-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("alert").waitFor();
  },
  undefined,
  true,
);

await test("administrator sees tenant administration and audit data", async (page) => {
  await signIn(page, "admin");
  await page.getByRole("heading", { name: "Platform overview" }).waitFor();
  await page.getByRole("button", { name: "Enter organization" }).first().click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Organization overview" }).waitFor();
  await page.getByLabel("Primary navigation").getByRole("button", { name: "Directory", exact: true }).click();
  await page.getByRole("heading", { name: "Employee directory" }).waitFor();
  await page.getByRole("columnheader", { name: "Employee" }).waitFor();
  await page.getByRole("button", { name: "Add employee" }).click();
  const employeeNumber = page.getByLabel("Employee number");
  if (!/^[A-Z0-9-]+-[A-F0-9]{8}$/.test(await employeeNumber.inputValue()))
    throw new Error("new employee number was not generated");
  await employeeNumber.fill("CUSTOM-001");
  if (await employeeNumber.inputValue() !== "CUSTOM-001")
    throw new Error("generated employee number is not editable");
  await page.keyboard.press("Escape");
  await page.getByLabel("Primary navigation").getByRole("button", { name: "Departments", exact: true }).click();
  await page.getByRole("heading", { name: "Departments" }).waitFor();
  await page.getByLabel("Primary navigation").getByRole("button", { name: "Audit", exact: true }).click();
  await page.getByRole("heading", { name: "Audit events" }).waitFor();
  await page.getByRole("button", { name: "Export all filtered events" }).waitFor();
});

await test("HR exports monthly time logs", async (page) => {
  await signIn(page, "hr");
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await page.getByRole("heading", { name: "Organization reports" }).waitFor();
  await page.getByLabel("Report month").waitFor();
  const exportButton = page.getByRole("button", { name: "Export monthly time logs" });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  if (download.suggestedFilename() !== "Monthly_Time_Logs.xls")
    throw new Error(`unexpected timesheet filename: ${download.suggestedFilename()}`);
});

await test("operational user clocks attendance and submits correction and leave", async (page) => {
  await signIn(page, "user");
  const clock = page.getByRole("button", { name: /Clock (in|out)/i });
  const before = await clock.textContent();
  await clock.click();
  await page.getByRole("status").waitFor();
  await page
    .getByRole("button", {
      name: before?.toLowerCase().includes("out") ? "Clock in" : "Clock out",
    })
    .waitFor();
  await page.getByRole("button", { name: "Attendance", exact: true }).click();
  await page.getByRole("button", { name: "Request correction" }).click();
  await page.getByLabel("Reason").fill(correctionId);
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await page.getByText(correctionId, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await page.getByRole("button", { name: "Request leave" }).click();
  await page.getByLabel("From").fill(usDate(leaveFrom));
  await page.getByLabel("To").fill(usDate(leaveTo));
  const leaveCreate = page.waitForRequest((request) => request.url().endsWith("/api/v1/leave-requests") && request.method() === "POST");
  await page.getByLabel("Reason").fill(flowId);
  await page.getByRole("button", { name: "Submit request" }).click();
  const submittedDates = (await leaveCreate).postDataJSON();
  if (submittedDates.start_date !== isoDate(leaveFrom) || submittedDates.end_date !== isoDate(leaveTo))
    throw new Error("leave request dates were not submitted as ISO dates");
  await page.getByText(flowId).waitFor();
});

await test("manager approves a direct report request", async (page) => {
  await signIn(page, "manager");
  await page.getByRole("button", { name: "Team", exact: true }).last().click();
  await page.getByRole("heading", { name: "Team dashboard" }).waitFor();
  await page.getByRole("button", { name: "Who’s in", exact: true }).click();
  await page.getByRole("heading", { name: "Who’s in" }).waitFor();
  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  const card = page
    .locator('[class*="rounded-xl"]')
    .filter({ hasText: flowId })
    .first();
  await card.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Confirm approval" }).click();
  await page.getByRole("status").waitFor();
  const correction = page
    .locator('[class*="rounded-xl"]')
    .filter({ hasText: correctionId })
    .first();
  await correction.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Confirm approval" }).click();
  await page.getByRole("status").waitFor();
});

await test("read-only persona cannot mutate attendance or leave", async (page) => {
  await signIn(page, "readonly");
  if (await page.getByRole("button", { name: /Clock (in|out)/i }).count())
    throw new Error("read-only clock action is visible");
  await page.getByRole("button", { name: "Attendance", exact: true }).click();
  if (await page.getByRole("button", { name: "Request correction" }).count())
    throw new Error("read-only correction action is visible");
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  if (await page.getByRole("button", { name: "Request leave" }).count())
    throw new Error("read-only leave action is visible");
});

await test(
  "session survives reload and cross-tenant headers are denied",
  async (page) => {
    await signIn(page, "user");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: "Make your time count." })
      .waitFor();
    const status = await page.evaluate(
      async () =>
        (
          await fetch("/api/v1/employees", {
            credentials: "include",
            headers: { "x-tenant-id": "harbor" },
          })
        ).status,
    );
    if (status !== 403)
      throw new Error(`expected cross-tenant 403, received ${status}`);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  },
  undefined,
  true,
);

await test(
  "mobile shell has no horizontal overflow",
  async (page) => {
    await signIn(page, "user");
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    if (overflow) throw new Error("unexpected horizontal overflow");
    await page.getByLabel("Open navigation").click();
    await page.getByRole("button", { name: "Holidays", exact: true }).click();
    await page.getByRole("heading", { name: "Holiday calendar" }).waitFor();
  },
  { width: 390, height: 844 },
);

for (const row of results) console.log(row.join(" | "));
console.log(
  `TOTAL ${results.length} | PASSED ${results.filter(([status]) => status === "PASS").length} | FAILED ${results.filter(([status]) => status === "FAIL").length}`,
);
await browser.close();
if (results.some(([status]) => status === "FAIL")) process.exitCode = 1;
