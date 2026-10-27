import test from "node:test";
import assert from "node:assert/strict";
import {
  completedRecordedSeconds,
  weeklyCompletedSeconds,
} from "../../src/client/lib/attendance.js";

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

test("weekly completed hours include weekdays, cap each day, and retain history", () => {
  const result = weeklyCompletedSeconds({
    dates: ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
    employeeId: "employee-1",
    isOvertimeEligible: false,
    maxDailyMins: 480,
    summaries: [
      { employee_id: "employee-1", local_date: "2026-08-31", worked_mins: 540 },
      { employee_id: "employee-1", local_date: "2026-09-01", worked_mins: 420 },
      { employee_id: "employee-1", local_date: "2026-09-05", worked_mins: 600 },
      { employee_id: "employee-2", local_date: "2026-09-02", worked_mins: 480 },
    ],
  });
  assert.equal(result.totalSeconds, (480 + 420) * 60);
  assert.deepEqual(result.days.map((day) => day.seconds / 60), [480, 420, 0, 0, 0]);
});
