-- Correct the 2026-11-23 opg-ta credit: move the 10 PTO days granted to
-- each of the other 10 active employees into LWP. Preserve Aphrodite's LWP.
-- Preview by replacing the final COMMIT with ROLLBACK.

BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL statement_timeout = '15s';
SELECT pg_advisory_xact_lock(hashtext('leave-credit-correction:opg-ta:2026-11-23'));

CREATE TEMP TABLE correction_targets ON COMMIT DROP AS
SELECT e.employee_id, e.name AS employee_name,
       pto.leave_type_id AS pto_type_id, pto_balance.balance_id AS pto_balance_id,
       pto_balance.remaining AS previous_pto, pto_balance.manual_adjustments AS previous_pto_adjustments,
       pto_balance.used AS previous_pto_used, pto_balance.pending AS previous_pto_pending,
       lwp.leave_type_id AS lwp_type_id, lwp_balance.balance_id AS lwp_balance_id,
       lwp_balance.remaining AS previous_lwp, lwp_balance.manual_adjustments AS previous_lwp_adjustments,
       lwp_balance.used AS previous_lwp_used, lwp_balance.pending AS previous_lwp_pending
FROM public.leave_ledger_entries original
JOIN public.employees e
  ON e.tenant_id = original.tenant_id AND e.employee_id = original.employee_id
 AND e.status = 'active'
JOIN public.leave_types pto
  ON pto.tenant_id = original.tenant_id AND pto.leave_type_id = original.leave_type_id
 AND pto.code = 'PTO' AND pto.status = 'active' AND pto.is_paid AND pto.unit = 'days'
JOIN public.leave_types lwp
  ON lwp.tenant_id = original.tenant_id
 AND lwp.code = 'LWP' AND lwp.status = 'active' AND NOT lwp.is_paid AND lwp.unit = 'days'
JOIN public.job_leave_policies lwp_policy
  ON lwp_policy.tenant_id = e.tenant_id AND lwp_policy.job_id = e.job_id
 AND lwp_policy.leave_type_id = lwp.leave_type_id AND lwp_policy.status = 'active'
 AND lwp_policy.effective_from <= DATE '2026-11-23'
 AND (lwp_policy.effective_to IS NULL OR lwp_policy.effective_to >= DATE '2026-11-23')
JOIN public.leave_balances pto_balance
  ON pto_balance.tenant_id = e.tenant_id AND pto_balance.employee_id = e.employee_id
 AND pto_balance.leave_type_id = pto.leave_type_id AND pto_balance.period = '2026'
 AND pto_balance.remaining >= 10
JOIN public.leave_balances lwp_balance
  ON lwp_balance.tenant_id = e.tenant_id AND lwp_balance.employee_id = e.employee_id
 AND lwp_balance.leave_type_id = lwp.leave_type_id AND lwp_balance.period = '2026'
WHERE original.tenant_id = 'opg-ta'
  AND original.source_id = 'manual-credit:opg-ta:2026-11-23'
  AND original.entry_type = 'manual_adjustment'
  AND original.effective_date = DATE '2026-11-23'
  AND original.amount = 10;

DO $$
BEGIN
  IF (SELECT count(*) FROM correction_targets) <> 10
     OR (SELECT count(DISTINCT employee_id) FROM correction_targets) <> 10
     OR (SELECT count(DISTINCT pto_balance_id) FROM correction_targets) <> 10
     OR (SELECT count(DISTINCT lwp_balance_id) FROM correction_targets) <> 10
     OR (SELECT count(*) FROM public.employees
         WHERE tenant_id = 'opg-ta' AND status = 'active'
           AND employee_id <> 'employee-f82d0cf8-9939-4ebe-945c-a8cbc3498e25') <> 10 THEN
    RAISE EXCEPTION 'Expected exactly the 10 other active employees and their PTO/LWP balances.';
  END IF;

  IF (
    SELECT count(*) FROM public.leave_ledger_entries
    WHERE tenant_id = 'opg-ta'
      AND source_id = 'manual-credit:opg-ta:2026-11-23'
      AND employee_id = 'employee-f82d0cf8-9939-4ebe-945c-a8cbc3498e25'
      AND entry_type = 'manual_adjustment' AND amount = 10
  ) <> 1 OR EXISTS (
    SELECT 1 FROM correction_targets
    WHERE employee_id = 'employee-f82d0cf8-9939-4ebe-945c-a8cbc3498e25'
  ) THEN
    RAISE EXCEPTION 'Aphrodite original credit must remain outside this correction.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.leave_ledger_entries
    WHERE tenant_id = 'opg-ta'
      AND source_id = 'credit-correction:opg-ta:2026-11-23'
  ) THEN
    RAISE EXCEPTION 'This correction was already recorded.';
  END IF;
END;
$$;

SELECT b.balance_id
FROM public.leave_balances b
JOIN (
  SELECT pto_balance_id AS balance_id FROM correction_targets
  UNION ALL
  SELECT lwp_balance_id FROM correction_targets
) target ON target.balance_id = b.balance_id
WHERE b.tenant_id = 'opg-ta'
FOR UPDATE OF b;

INSERT INTO public.leave_ledger_entries (
  entry_id, tenant_id, employee_id, leave_type_id, effective_date,
  amount, entry_type, source_id, reason, created_by, created_at
)
SELECT 'credit-correction:opg-ta:2026-11-23:' || change.code || ':' || target.employee_id,
       'opg-ta', target.employee_id, change.leave_type_id, DATE '2026-11-23',
       change.amount, 'manual_adjustment', 'credit-correction:opg-ta:2026-11-23',
       CASE change.code WHEN 'PTO' THEN 'Reverse the mistaken 10 Paid Time Off credits.'
                        ELSE 'Move the requested 10 credits to Leave without Pay.' END,
       'system:requested-leave-credit-correction', CURRENT_TIMESTAMP
FROM correction_targets target
CROSS JOIN LATERAL (
  VALUES ('PTO', target.pto_type_id, -10), ('LWP', target.lwp_type_id, 10)
) change (code, leave_type_id, amount);

UPDATE public.leave_balances b
SET manual_adjustments = b.manual_adjustments - 10,
    remaining = b.remaining - 10,
    as_of = DATE '2026-11-23'
FROM correction_targets target
WHERE b.tenant_id = 'opg-ta' AND b.balance_id = target.pto_balance_id;

UPDATE public.leave_balances b
SET manual_adjustments = b.manual_adjustments + 10,
    remaining = b.remaining + 10,
    as_of = DATE '2026-11-23'
FROM correction_targets target
WHERE b.tenant_id = 'opg-ta' AND b.balance_id = target.lwp_balance_id;

DO $$
BEGIN
  IF (
    SELECT count(*) FROM public.leave_ledger_entries
    WHERE tenant_id = 'opg-ta'
      AND source_id = 'credit-correction:opg-ta:2026-11-23'
  ) <> 20 OR EXISTS (
    SELECT 1 FROM correction_targets target
    JOIN public.leave_balances pto ON pto.tenant_id = 'opg-ta'
      AND pto.balance_id = target.pto_balance_id
    JOIN public.leave_balances lwp ON lwp.tenant_id = 'opg-ta'
      AND lwp.balance_id = target.lwp_balance_id
    WHERE pto.manual_adjustments <> target.previous_pto_adjustments - 10
       OR pto.remaining <> target.previous_pto - 10
       OR pto.used <> target.previous_pto_used
       OR pto.pending <> target.previous_pto_pending
       OR lwp.manual_adjustments <> target.previous_lwp_adjustments + 10
       OR lwp.remaining <> target.previous_lwp + 10
       OR lwp.used <> target.previous_lwp_used
       OR lwp.pending <> target.previous_lwp_pending
  ) THEN
    RAISE EXCEPTION 'Correction ledger or balances failed verification.';
  END IF;
END;
$$;

SELECT target.employee_name,
       target.previous_pto, pto.remaining AS new_pto,
       pto.pending AS pto_pending, pto.remaining - pto.pending AS pto_available,
       target.previous_lwp, lwp.remaining AS new_lwp
FROM correction_targets target
JOIN public.leave_balances pto ON pto.tenant_id = 'opg-ta'
 AND pto.balance_id = target.pto_balance_id
JOIN public.leave_balances lwp ON lwp.tenant_id = 'opg-ta'
 AND lwp.balance_id = target.lwp_balance_id
ORDER BY target.employee_name;

COMMIT;
