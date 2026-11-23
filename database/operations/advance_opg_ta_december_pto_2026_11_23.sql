-- Advance the December 2026 PTO accrual for the 10 active opg-ta employees.
-- The normal December job sees these canonical ledger IDs and skips them;
-- the January 2027 job remains scheduled. Preview with ROLLBACK.

BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL statement_timeout = '15s';
SELECT pg_advisory_xact_lock(hashtext('monthly-leave-accrual:opg-ta:2026-12'));

CREATE TEMP TABLE december_pto_targets ON COMMIT DROP AS
SELECT DISTINCT ON (e.employee_id, lt.leave_type_id)
       e.employee_id, lt.leave_type_id, b.balance_id,
       round(p.annual_allotment / 12, 6) AS monthly_credit,
       b.accrued AS previous_accrued, b.remaining AS previous_remaining,
       b.used AS previous_used, b.pending AS previous_pending
FROM public.employees e
JOIN public.job_leave_policies p
  ON p.tenant_id = e.tenant_id AND p.job_id = e.job_id
JOIN public.leave_types lt
  ON lt.tenant_id = p.tenant_id AND lt.leave_type_id = p.leave_type_id
JOIN public.leave_balances b
  ON b.tenant_id = e.tenant_id AND b.employee_id = e.employee_id
 AND b.leave_type_id = lt.leave_type_id
WHERE e.tenant_id = 'opg-ta' AND e.status = 'active'
  AND lt.code = 'PTO' AND lt.is_paid AND lt.unit = 'days' AND lt.status = 'active'
  AND p.status = 'active' AND p.accrual_rule ->> 'type' = 'monthly'
  AND COALESCE(p.accrual_rule ->> 'reset_frequency', 'annually') = 'annually'
  AND p.effective_from <= DATE '2026-12-01'
  AND (p.effective_to IS NULL OR p.effective_to >= DATE '2026-12-01')
  AND b.period = '2026' AND b.as_of <= DATE '2026-11-23'
ORDER BY e.employee_id, lt.leave_type_id, p.effective_from DESC,
         p.policy_id, b.as_of DESC, b.balance_id DESC;

DO $$
BEGIN
  IF (SELECT (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date
      FROM public.tenants WHERE tenant_id = 'opg-ta') <> DATE '2026-11-23'
     OR (SELECT count(*) FROM december_pto_targets) <> 10
     OR (SELECT count(DISTINCT balance_id) FROM december_pto_targets) <> 10
     OR EXISTS (SELECT 1 FROM december_pto_targets WHERE monthly_credit <> 2.333333)
     OR EXISTS (
       SELECT 1 FROM december_pto_targets t
       WHERE NOT EXISTS (
         SELECT 1 FROM public.leave_ledger_entries l
         WHERE l.entry_id = 'leave-accrual:opg-ta:' || t.employee_id || ':' ||
                            t.leave_type_id || ':2026-11'
       )
     )
     OR EXISTS (
       SELECT 1 FROM public.leave_ledger_entries
       WHERE tenant_id = 'opg-ta' AND source_id = 'monthly-leave-accrual:2026-12'
     ) THEN
    RAISE EXCEPTION 'OPG-TA December PTO advance preconditions failed.';
  END IF;
END;
$$;

SELECT b.balance_id
FROM public.leave_balances b
JOIN december_pto_targets t ON t.balance_id = b.balance_id
WHERE b.tenant_id = 'opg-ta'
FOR UPDATE OF b;

INSERT INTO public.leave_ledger_entries (
  entry_id, tenant_id, employee_id, leave_type_id, effective_date,
  amount, entry_type, source_id, reason, created_by, created_at
)
SELECT 'leave-accrual:opg-ta:' || employee_id || ':' || leave_type_id || ':2026-12',
       'opg-ta', employee_id, leave_type_id, DATE '2026-11-23',
       monthly_credit, 'accrual', 'monthly-leave-accrual:2026-12',
       'December 2026 PTO accrual advanced to November 23.',
       'system:requested-leave-credit', CURRENT_TIMESTAMP
FROM december_pto_targets;

UPDATE public.leave_balances b
SET accrued = b.accrued + t.monthly_credit,
    remaining = b.remaining + t.monthly_credit,
    as_of = DATE '2026-11-23'
FROM december_pto_targets t
WHERE b.tenant_id = 'opg-ta' AND b.balance_id = t.balance_id;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.leave_ledger_entries
      WHERE tenant_id = 'opg-ta' AND source_id = 'monthly-leave-accrual:2026-12'
        AND entry_type = 'accrual' AND effective_date = DATE '2026-11-23') <> 10
     OR EXISTS (
       SELECT 1 FROM december_pto_targets t
       JOIN public.leave_balances b ON b.tenant_id = 'opg-ta'
        AND b.balance_id = t.balance_id
       WHERE b.accrued <> t.previous_accrued + t.monthly_credit
          OR b.remaining <> t.previous_remaining + t.monthly_credit
          OR b.used <> t.previous_used OR b.pending <> t.previous_pending
          OR b.as_of <> DATE '2026-11-23'
     ) THEN
    RAISE EXCEPTION 'OPG-TA December PTO advance verification failed.';
  END IF;
END;
$$;

SELECT count(*) AS employees_credited, sum(monthly_credit) AS total_days_credited
FROM december_pto_targets;

COMMIT;
