import test from "node:test";
import assert from "node:assert/strict";
import {
  monthDateForTimeZone,
  monthGrid,
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
