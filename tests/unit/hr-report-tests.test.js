import test from "node:test";
import assert from "node:assert/strict";
import { approvedLeaveTotals, pageMetadata, safeCsvCell } from "../../src/server/services/report-utils.js";
import { buildMonthlyTimesheetWorkbook, monthDates } from "../../src/server/services/monthly-timesheet-export.js";
import * as XLSX from "xlsx";

test("CSV cells neutralize formulas and preserve delimiters", () => {
  assert.equal(safeCsvCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
  assert.equal(safeCsvCell("Mendoza, Arielle\nOperations"), '"Mendoza, Arielle\nOperations"');
  assert.equal(safeCsvCell("正常"), "正常");
});

test("report pagination is bounded and deterministic", () => {
  assert.deepEqual(pageMetadata(51, 2, 25), { total: 51, page: 2, page_size: 25, page_count: 3 });
  assert.equal(pageMetadata(0, 0, 500).page_size, 100);
});

test("only approved leave contributes to paid and unpaid totals", () => {
  assert.deepEqual(approvedLeaveTotals([
    { status: "approved", is_paid: true, chargeable_amount: 2 },
    { status: "approved", is_paid: false, chargeable_amount: 1.5 },
    { status: "pending", is_paid: true, chargeable_amount: 4 },
  ]), { paid: 2, unpaid: 1.5 });
});

test("monthly time log workbook matches the legacy two-sheet layout", () => {
  const dates = monthDates("2026-09");
  assert.equal(dates.length, 30);
  assert.equal(monthDates("2024-02").length, 29);
  assert.equal(monthDates("2025-02").length, 28);
  assert.equal(monthDates("2026-04").length, 30);
  assert.equal(monthDates("2026-13"), null);
  const workbook = buildMonthlyTimesheetWorkbook({
    dates,
    rows: [{
      tenant_id: "northstar",
      name: "Jamal Al Badi",
      email: "jam@example.com",
      job_title: "Recruitment Automation Intern",
      daily: { "2026-09-01": 480, "2026-09-02": 0, "2026-09-30": 1500 },
    }],
  });
  const bytes = XLSX.write(workbook, { bookType: "biff8", type: "buffer" });
  assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0xd0, 0xcf, 0x11, 0xe0]);
  const parsed = XLSX.read(bytes, { type: "buffer" });
  assert.deepEqual(parsed.SheetNames, ["Monthly Time Logs_Hours_1", "Monthly Time Logs_Decimal_2"]);
  const hours = parsed.Sheets[parsed.SheetNames[0]];
  const decimal = parsed.Sheets[parsed.SheetNames[1]];
  assert.equal(hours.A1.v, "Employee Name");
  assert.equal(hours.F1.v, "01-Sep-2026");
  assert.equal(hours.A2.v, "Jamal Al Badi");
  assert.equal(hours.B2.v, "jam@example.com");
  assert.equal(hours.C2.v, "northstar");
  assert.equal(hours.D2.v, "Recruitment Automation Intern");
  assert.equal(hours.E2.v, "Recruitment Automation Intern");
  assert.equal(hours.F2.v, "08:00");
  assert.equal(hours.AI2.v, "25:00");
  assert.equal(hours.AJ2.v, "33:00");
  assert.equal(hours.A3.v, "Total");
  assert.equal(hours.AJ3.v, "33:00");
  assert.equal(decimal.F2.v, 8);
  assert.equal(decimal.AI2.v, 25);
  assert.equal(decimal.AJ2.v, 33);
  assert.equal(decimal.AJ3.v, 33);
});
