import test from "node:test";
import assert from "node:assert/strict";
import {
  addLocalDays,
  formatUsDate,
  isWeekendDate,
  localDateForTimeZone,
  monthDateForTimeZone,
  monthGrid,
  parseUsDate,
  teamLeaveDay,
  workWeekDates,
  workWeekLabel,
  weekdayLabels,
} from "../../src/client/lib/calendar.js";

test("month grid aligns dates to a Monday-first tenant calendar", () => {
  assert.deepEqual(monthGrid(2026, 9, 1), { daysInMonth: 31, leadingDays: 3 });
  assert.deepEqual(weekdayLabels(1), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
});

test("month grid honors a Sunday-first tenant calendar", () => {
  assert.deepEqual(monthGrid(2026, 9, 0), { daysInMonth: 31, leadingDays: 4 });
  assert.deepEqual(weekdayLabels(0), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
});

test("calendar month follows the tenant timezone instead of the browser date", () => {
  const instant = new Date("2026-10-31T16:30:00.000Z");
  const manila = monthDateForTimeZone("Asia/Manila", 0, instant);
  const newYork = monthDateForTimeZone("America/New_York", 0, instant);
  assert.deepEqual(
    [manila.getFullYear(), manila.getMonth(), manila.getDate()],
    [2026, 10, 1],
  );
  assert.deepEqual(
    [newYork.getFullYear(), newYork.getMonth(), newYork.getDate()],
    [2026, 9, 1],
  );
});

test("work weeks always run Monday through Friday", () => {
  assert.deepEqual(workWeekDates("2026-10-27"), [
    "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30",
  ]);
  assert.equal(workWeekLabel("2026-10-27"), "October 26 - 30 | 2026");
  assert.equal(workWeekLabel("2026-09-01"), "August 31 - September 4 | 2026");
  assert.equal(addLocalDays("2026-12-31", 1), "2027-01-01");
  assert.equal(isWeekendDate("2026-10-31"), true);
  assert.equal(isWeekendDate("2026-10-30"), false);
});

test("tenant-local date handles opposite sides of midnight", () => {
  const instant = new Date("2026-10-31T16:30:00.000Z");
  assert.equal(localDateForTimeZone("Asia/Manila", instant), "2026-11-01");
  assert.equal(localDateForTimeZone("America/New_York", instant), "2026-10-31");
});

test("leave request dates use MM/DD/YYYY while retaining ISO values", () => {
  assert.equal(formatUsDate("2026-12-22"), "12/22/2026");
  assert.equal(parseUsDate("12/22/2026"), "2026-12-22");
  assert.equal(parseUsDate("22/12/2026"), "");
  assert.equal(parseUsDate("02/29/2027"), "");
  assert.equal(parseUsDate("02/29/2028"), "2028-02-29");
});

test("team leave days exclude weekends and keep rejected requests out of scheduled leave", () => {
  const rows = [
    { request_id: "approved", employee_id: "a", start_date: "2026-12-18", end_date: "2026-12-21", status: "approved" },
    { request_id: "rejected", employee_id: "b", start_date: "2026-12-21", end_date: "2026-12-21", status: "rejected" },
  ];
  assert.deepEqual(teamLeaveDay(rows, "2026-12-19", true).details, []);
  assert.deepEqual(teamLeaveDay(rows, "2026-12-20", true).scheduled, []);
  assert.deepEqual(teamLeaveDay(rows, "2026-12-21").scheduled.map((row) => row.request_id), ["approved"]);
  assert.deepEqual(teamLeaveDay(rows, "2026-12-21").details.map((row) => row.request_id), ["approved", "rejected"]);
});

test("team leave only flags repeated requests from the same employee", () => {
  const rows = [
    { request_id: "one", employee_id: "a", start_date: "2026-12-21", end_date: "2026-12-21", status: "approved" },
    { request_id: "two", employee_id: "b", start_date: "2026-12-21", end_date: "2026-12-21", status: "approved" },
    { request_id: "three", employee_id: "a", start_date: "2026-12-21", end_date: "2026-12-21", status: "pending" },
  ];
  assert.equal(teamLeaveDay(rows, "2026-12-21").repeatedEmployee, false);
  assert.equal(teamLeaveDay(rows, "2026-12-21", true).repeatedEmployee, true);
  assert.equal(teamLeaveDay(rows.slice(0, 2), "2026-12-21", true).repeatedEmployee, false);
});
