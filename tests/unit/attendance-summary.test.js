import test from "node:test";
import assert from "node:assert/strict";
import { attendanceSummaryValues } from "../../src/server/services/attendance-summary-service.js";

test("non-overtime summaries cap worked time at scheduled time", () => {
  assert.deepEqual(
    attendanceSummaryValues({
      actualWorkedMins: 571,
      scheduledMins: 480,
      isOvertimeEligible: false,
    }),
    {
      workedMins: 480,
      scheduledMins: 480,
      overtimeMins: 0,
      status: "complete",
      exceptionCodes: [],
    },
  );
});

test("overtime-eligible summaries retain time above scheduled time", () => {
  assert.deepEqual(
    attendanceSummaryValues({
      actualWorkedMins: 571,
      scheduledMins: 480,
      isOvertimeEligible: true,
    }),
    {
      workedMins: 571,
      scheduledMins: 480,
      overtimeMins: 91,
      status: "complete",
      exceptionCodes: [],
    },
  );
});

test("short days remain below standard for either eligibility setting", () => {
  assert.deepEqual(
    attendanceSummaryValues({
      actualWorkedMins: 420,
      scheduledMins: 480,
      isOvertimeEligible: false,
    }),
    {
      workedMins: 420,
      scheduledMins: 480,
      overtimeMins: 0,
      status: "below_standard",
      exceptionCodes: ["SHORT_DAY"],
    },
  );
});
