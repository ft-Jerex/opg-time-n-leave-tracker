import test from "node:test";
import assert from "node:assert/strict";
import { groupLeavePolicies } from "../../src/client/lib/leave-policy-groups.js";

const policy = (policy_id, job_id, annual_allotment = 20) => ({
  policy_id,
  job_id,
  leave_type_id: "annual-leave",
  annual_allotment,
  accrual_rule: { type: "monthly", reset_frequency: "annually" },
  carry_over_limit: 5,
  allow_negative: false,
  allow_partial_day: true,
  counting_rule: { weekends: false, holidays: false },
  request_window: { min_days: 1, max_days: 365 },
  documentation_rule: {},
  effective_from: "2026-01-01",
  effective_to: null,
  status: "active",
});

test("identical leave policies group their jobs without merging different terms", () => {
  const legacyPolicy = policy("policy-1", "job-1");
  legacyPolicy.accrual_rule = { type: "monthly" };
  const groups = groupLeavePolicies([
    legacyPolicy,
    policy("policy-2", "job-2"),
    policy("policy-3", "job-3", 15),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].job_ids, ["job-1", "job-2"]);
  assert.deepEqual(
    groups[0].policies.map((item) => item.policy_id),
    ["policy-1", "policy-2"],
  );
  assert.deepEqual(groups[1].job_ids, ["job-3"]);
});
