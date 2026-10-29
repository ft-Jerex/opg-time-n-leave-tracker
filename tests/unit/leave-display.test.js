import test from "node:test";
import assert from "node:assert/strict";
import { formatLeaveAmount, partialLeaveCharge } from "../../src/client/lib/leave.js";

test("leave amounts display with exactly two decimal places", () => {
  assert.equal(formatLeaveAmount(2.333333), "2.33");
  assert.equal(formatLeaveAmount("28"), "28.00");
  assert.equal(formatLeaveAmount(-1.5), "-1.50");
});

test("day-based hourly leave charges 0.11 credits per hour", () => {
  assert.equal(partialLeaveCharge(60, "days"), 0.11);
  assert.equal(partialLeaveCharge(180, "days"), 0.33);
  assert.equal(partialLeaveCharge(90, "days"), 0.17);
});

test("hour-unit leave balances continue charging actual hours", () => {
  assert.equal(partialLeaveCharge(90, "hours"), 1.5);
});

test("invalid leave amounts display as unavailable", () => {
  assert.equal(formatLeaveAmount(undefined), "—");
});
