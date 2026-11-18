const policyTerms = (policy) => {
  const accrualRule = {
    ...policy.accrual_rule,
    reset_frequency: policy.accrual_rule?.reset_frequency || "annually",
  };
  return JSON.stringify([
    policy.leave_type_id,
    policy.annual_allotment,
    accrualRule,
    policy.carry_over_limit,
    policy.allow_negative,
    policy.allow_partial_day,
    policy.counting_rule,
    policy.request_window,
    policy.documentation_rule,
    policy.effective_from,
    policy.effective_to,
    policy.status,
  ]);
};

export const groupLeavePolicies = (policies) => {
  const groups = new Map();
  for (const policy of policies) {
    const key = policyTerms(policy);
    const group = groups.get(key);
    if (group) {
      group.policies.push(policy);
      group.job_ids.push(policy.job_id);
    } else {
      groups.set(key, {
        ...policy,
        policies: [policy],
        job_ids: [policy.job_id],
      });
    }
  }
  return [...groups.values()];
};
