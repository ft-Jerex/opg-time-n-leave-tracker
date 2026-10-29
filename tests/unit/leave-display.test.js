import test from "node:test";
import assert from "node:assert/strict";
import { formatLeaveAmount } from "../../src/client/lib/leave.js";

test("leave amounts display with exactly two decimal places", () => {
  assert.equal(formatLeaveAmount(2.333333), "2.33");
  assert.equal(formatLeaveAmount("28"), "28.00");
  assert.equal(formatLeaveAmount(-1.5), "-1.50");
});

test("invalid leave amounts display as unavailable", () => {
  assert.equal(formatLeaveAmount(undefined), "—");
});
