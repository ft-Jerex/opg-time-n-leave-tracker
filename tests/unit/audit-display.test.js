import test from "node:test";
import assert from "node:assert/strict";
import { auditDisplayRows } from "../../src/client/lib/audit.js";

test("audit rows resolve actor and leave target IDs to real names", () => {
  const [row] = auditDisplayRows([
    {
      event_id: "audit-1",
      actor_user_id: "user-hr",
      target_type: "LeaveRequest",
      target_id: "leave-1",
      metadata: {},
    },
  ], {
    users: [{ user_id: "user-hr", display_name: "Helen Rivera" }],
    employees: [{ employee_id: "employee-1", name: "Morgan Santos" }],
    departments: [],
    "job-profiles": [],
    "leave-types": [],
    tenants: [],
    "leave-requests": [{ request_id: "leave-1", employee_id: "employee-1" }],
    "attendance-sessions": [],
    "attendance-adjustments": [],
    "overtime-requests": [],
  });
  assert.equal(row.actor, "Helen Rivera");
  assert.equal(row.target_name, "Morgan Santos");
});
