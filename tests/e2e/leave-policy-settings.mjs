import "dotenv/config";
import assert from "node:assert/strict";
import pg from "pg";
import { launchAuditBrowser, appUrl } from "../support/audit-config.mjs";

const resetTestData = async () => {
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      DELETE FROM job_leave_policies
       WHERE tenant_id='northstar'
         AND leave_type_id IN (
           SELECT leave_type_id FROM leave_types
            WHERE tenant_id='northstar' AND code='E2E_RESET'
         );
      DELETE FROM leave_types
       WHERE tenant_id='northstar' AND code='E2E_RESET';
      UPDATE job_leave_policies
         SET accrual_rule = jsonb_set(accrual_rule, '{reset_frequency}', '"annually"')
       WHERE tenant_id='northstar' AND policy_id='ns-people-annual-policy'
    `);
  } finally {
    await client.end();
  }
};

await resetTestData();
const browser = await launchAuditBrowser();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);

try {
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill("hr@dev.local");
  await page
    .getByLabel("Password")
    .fill(process.env.SEED_HR_PASSWORD || process.env.SEED_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Make your time count." }).waitFor();
  await page.getByRole("button", { name: "Leave policies", exact: true }).click();
  await page.getByRole("heading", { name: "Leave policies" }).waitFor();

  await page.getByRole("button", { name: "New leave type" }).click();
  await page.getByLabel("Name").fill("Browser Reset Leave");
  await page.getByLabel("Code").fill("E2E_RESET");
  await page.getByRole("button", { name: "Create leave type" }).click();
  await page.getByText("Leave type created.").waitFor();

  await page.getByRole("button", { name: "New mapping" }).click();
  await page.getByLabel("Policy job").selectOption({ label: "People Operations Partner" });
  await page.getByLabel("Policy leave type").selectOption({ label: "Browser Reset Leave" });
  await page.getByLabel("Annual allowance").fill("60");
  await page.getByLabel("Carry-over limit").fill("0");
  await page.getByLabel("Balance reset frequency").selectOption("monthly");
  assert.match(await page.locator("body").innerText(), /Monthly credit:\s*5\.00/);
  await page.getByRole("button", { name: "Create mapping" }).click();
  await page.getByText("Policy mapping created.").waitFor();

  const createdPolicyCard = page
    .locator("div.rounded-xl.border.bg-card")
    .filter({ has: page.getByRole("heading", { name: "Browser Reset Leave", exact: true }) });
  await createdPolicyCard.getByRole("button", { name: "Edit policy" }).waitFor();
  await createdPolicyCard
    .getByText("Balance resets", { exact: true })
    .locator("xpath=..")
    .getByText("Monthly", { exact: true })
    .waitFor();
  assert.match(await createdPolicyCard.innerText(), /Annual allowance\s*60\.00/i);

  const policyCard = page
    .locator("div.rounded-xl.border.bg-card")
    .filter({ has: page.getByRole("heading", { name: "Annual Leave", exact: true }) })
    .filter({ has: page.getByText("Job: People Operations Partner", { exact: true }) });
  await policyCard.getByRole("button", { name: "Edit policy" }).click();
  const resetFrequency = page.getByLabel("Balance reset frequency");
  await resetFrequency.waitFor();
  assert.equal(await resetFrequency.inputValue(), "annually");
  await resetFrequency.selectOption("monthly");
  assert.equal(await page.getByLabel("Carry-over limit").isDisabled(), true);
  assert.match(await page.locator("body").innerText(), /Monthly credit:\s*1\.67/);
  await page.getByRole("button", { name: "Save policy" }).click();
  await page.getByText("Policy mapping updated.").waitFor();

  await policyCard
    .getByText("Balance resets", { exact: true })
    .locator("xpath=..")
    .getByText("Monthly", { exact: true })
    .waitFor();
  assert.match(await policyCard.innerText(), /Annual allowance\s*20\.00/i);
  assert.match(await policyCard.innerText(), /Carry-over limit\s*5\.00/i);

  await policyCard.getByRole("button", { name: "Edit policy" }).click();
  await page.getByLabel("Balance reset frequency").selectOption("annually");
  assert.equal(await page.getByLabel("Carry-over limit").isEnabled(), true);
  await page.getByRole("button", { name: "Save policy" }).click();
  await page.getByText("Policy mapping updated.").waitFor();
  await policyCard
    .getByText("Balance resets", { exact: true })
    .locator("xpath=..")
    .getByText("Annually", { exact: true })
    .waitFor();

  console.log("PASS | leave policy create/edit reset controls and two-decimal display");
} finally {
  await resetTestData();
  await context.close();
  await browser.close();
}
