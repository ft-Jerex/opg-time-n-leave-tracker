export const grantInitialLeaveCredits = async (client, tenantId, employee, actorUserId) => {
  // shortcut: the first policy period is not prorated; add hire-date proration when policy rules define it.
  const policies = await client.query(
    `SELECT DISTINCT ON (p.leave_type_id) p.leave_type_id, lt.unit,
            CASE WHEN p.accrual_rule ->> 'type' = 'monthly'
              THEN round(p.annual_allotment / 12, 6)
              ELSE p.annual_allotment END AS credit,
            p.accrual_rule ->> 'type' AS accrual_type,
            (CURRENT_TIMESTAMP AT TIME ZONE t.timezone)::date AS local_date
       FROM job_leave_policies p
       JOIN leave_types lt ON lt.tenant_id=p.tenant_id AND lt.leave_type_id=p.leave_type_id
       JOIN tenants t ON t.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.job_id=$2 AND p.status='active' AND lt.status='active'
        AND p.annual_allotment > 0
        AND p.accrual_rule ->> 'type' IN ('monthly','annual')
        AND p.effective_from <= (CURRENT_TIMESTAMP AT TIME ZONE t.timezone)::date
        AND (p.effective_to IS NULL OR p.effective_to >= (CURRENT_TIMESTAMP AT TIME ZONE t.timezone)::date)
      ORDER BY p.leave_type_id, p.effective_from DESC, p.policy_id`,
    [tenantId, employee.job_id],
  );
  for (const policy of policies.rows) {
    const period = policy.local_date.slice(0, 4);
    await client.query(
      `INSERT INTO leave_balances
        (balance_id,tenant_id,employee_id,leave_type_id,period,accrued,carried_over,manual_adjustments,used,pending,remaining,unit,as_of)
       VALUES ($1,$2,$3,$4,$5,$6,0,0,0,0,$6,$7,$8)`,
      [`balance:${tenantId}:${employee.employee_id}:${policy.leave_type_id}`, tenantId, employee.employee_id, policy.leave_type_id, period, policy.credit, policy.unit, policy.local_date],
    );
    const monthly = policy.accrual_type === "monthly";
    const sourceId = monthly ? `monthly-leave-accrual:${policy.local_date.slice(0, 7)}` : `employee-onboarding:${employee.employee_id}`;
    await client.query(
      `INSERT INTO leave_ledger_entries
        (entry_id,tenant_id,employee_id,leave_type_id,effective_date,amount,entry_type,source_id,reason,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'accrual',$7,$8,$9,CURRENT_TIMESTAMP)`,
      [monthly
        ? `leave-accrual:${tenantId}:${employee.employee_id}:${policy.leave_type_id}:${policy.local_date.slice(0, 7)}`
        : `leave-annual-grant:${tenantId}:${employee.employee_id}:${policy.leave_type_id}:${period}`,
      tenantId, employee.employee_id, policy.leave_type_id,
      monthly ? `${policy.local_date.slice(0, 7)}-01` : policy.local_date,
      policy.credit, sourceId, "Initial job-policy leave credit.", actorUserId],
    );
  }
};
