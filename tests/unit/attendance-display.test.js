import test from "node:test";
import assert from "node:assert/strict";
import { completedRecordedSeconds } from "../../src/client/lib/attendance.js";

test("recorded hours stop increasing at the non-overtime daily limit", () => {
  assert.equal(
    completedRecordedSeconds({
      summaryMinutes: 540,
      closedSessionSeconds: 9 * 60 * 60,
      isOvertimeEligible: false,
      maxDailyMins: 480,
    }),
    8 * 60 * 60,
  );
});

test("recorded hours use completed sessions and do not include a live timer", () => {
  assert.equal(
    completedRecordedSeconds({
      summaryMinutes: 0,
      closedSessionSeconds: 49 * 60 + 45,
      isOvertimeEligible: false,
      maxDailyMins: 480,
    }),
    49 * 60 + 45,
  );
});

test("an open session by itself leaves recorded hours at zero", () => {
  assert.equal(
    completedRecordedSeconds({
      summaryMinutes: 0,
      closedSessionSeconds: 0,
      isOvertimeEligible: false,
      maxDailyMins: 480,
    }),
    0,
  );
});

test("overtime-eligible jobs remain uncapped", () => {
  assert.equal(
    completedRecordedSeconds({
      summaryMinutes: 540,
      closedSessionSeconds: 9 * 60 * 60,
      isOvertimeEligible: true,
      maxDailyMins: 480,
    }),
    9 * 60 * 60,
  );
});

test("a corrected summary wins when it is newer than loaded session totals", () => {
  assert.equal(
    completedRecordedSeconds({
      summaryMinutes: 180,
      closedSessionSeconds: 2 * 60 * 60,
      isOvertimeEligible: false,
      maxDailyMins: 480,
    }),
    3 * 60 * 60,
  );
});
