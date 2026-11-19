import test from "node:test";
import assert from "node:assert/strict";
import { clockOutInput } from "../../src/server/services/hr-service.js";

test("HR clock-out requires an employee, local date and time, and reason", () => {
  assert.deepEqual(clockOutInput({ employee_id: " emp ", clock_out_date: "2026-11-13", clock_out_time: "15:00", reason: " corrected " }), {
    employeeId: "emp", localDate: "2026-11-13", localTime: "15:00", reason: "corrected",
  });
  for (const body of [
    { employee_id: "", clock_out_date: "2026-11-13", clock_out_time: "15:00", reason: "corrected" },
    { employee_id: "emp", clock_out_date: "2026-13-13", clock_out_time: "15:00", reason: "corrected" },
    { employee_id: "emp", clock_out_date: "2026-11-13", clock_out_time: "25:00", reason: "corrected" },
    { employee_id: "emp", clock_out_date: "2026-11-13", clock_out_time: "15:00", reason: " " },
  ]) assert.throws(() => clockOutInput(body), { status: 422 });
});
