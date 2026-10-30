-- One-time initial October 2026 leave credits for the named Propertywise employees.
-- Safe to rerun: deterministic ledger IDs prevent duplicate credits.

BEGIN;

CREATE TEMP TABLE propertywise_initial_leave_targets ON COMMIT DROP AS
SELECT DISTINCT ON (employee.employee_id, leave_type.leave_type_id)
       employee.employee_id,
       employee.name AS employee_name,
       leave_type.leave_type_id,
       leave_type.name AS leave_type_name,
       leave_type.code,
       leave_type.unit,
       CASE leave_type.code
         WHEN 'PTO' THEN 2.33::numeric
         WHEN 'LWP' THEN 5::numeric
       END AS initial_credit
FROM public.employees AS employee
JOIN public.job_leave_policies AS policy
  ON policy.tenant_id = employee.tenant_id
 AND policy.job_id = employee.job_id
JOIN public.leave_types AS leave_type
  ON leave_type.tenant_id = policy.tenant_id
 AND leave_type.leave_type_id = policy.leave_type_id
WHERE employee.tenant_id = 'propertywise'
  AND employee.name IN ('Marcelino Cruz', 'Jose Benedic Garcia')
  AND employee.status = 'active'
  AND policy.status = 'active'
  AND policy.effective_from <= DATE '2026-10-30'
  AND (policy.effective_to IS NULL OR policy.effective_to >= DATE '2026-10-30')
  AND leave_type.status = 'active'
  AND leave_type.code IN ('PTO', 'LWP')
ORDER BY employee.employee_id,
         leave_type.leave_type_id,
         policy.effective_from DESC,
         policy.policy_id;

DO $$
DECLARE
  employee_count integer;
  target_count integer;
BEGIN
  SELECT count(DISTINCT employee_id), count(*)
    INTO employee_count, target_count
    FROM propertywise_initial_leave_targets;

  IF employee_count <> 2 OR target_count <> 4 THEN
    RAISE EXCEPTION
      'Expected 2 Propertywise employees and 4 PTO/LWP targets; found % employees and % targets.',
      employee_count,
      target_count;
  END IF;
END;
$$;

INSERT INTO public.leave_balances (
  balance_id,
  tenant_id,
  employee_id,
  leave_type_id,
  period,
  accrued,
  carried_over,
  manual_adjustments,
  used,
  pending,
  remaining,
  unit,
  as_of
)
SELECT 'balance:propertywise:' || target.employee_id || ':' || target.leave_type_id,
       'propertywise',
       target.employee_id,
       target.leave_type_id,
       '2026',
       0,
       0,
       0,
       0,
       0,
       0,
       target.unit,
       DATE '2026-10-01'
FROM propertywise_initial_leave_targets AS target
ON CONFLICT (balance_id) DO NOTHING;

WITH inserted_credits AS (
  INSERT INTO public.leave_ledger_entries (
    entry_id,
    tenant_id,
    employee_id,
    leave_type_id,
    effective_date,
    amount,
    entry_type,
    source_id,
    reason,
    created_by,
    created_at
  )
  SELECT 'leave-accrual:propertywise:' || target.employee_id || ':' ||
           target.leave_type_id || ':2026-10',
         'propertywise',
         target.employee_id,
         target.leave_type_id,
         DATE '2026-10-01',
         target.initial_credit,
         'accrual',
         'monthly-leave-accrual:2026-10',
         'Initial October 2026 leave credit.',
         'system:leave-accrual',
         CURRENT_TIMESTAMP
  FROM propertywise_initial_leave_targets AS target
  ON CONFLICT (entry_id) DO NOTHING
  RETURNING employee_id, leave_type_id, amount
)
UPDATE public.leave_balances AS balance
SET accrued = balance.accrued + credit.amount,
    remaining = balance.remaining + credit.amount,
    as_of = DATE '2026-10-01'
FROM inserted_credits AS credit
WHERE balance.tenant_id = 'propertywise'
  AND balance.employee_id = credit.employee_id
  AND balance.leave_type_id = credit.leave_type_id
  AND balance.balance_id =
      'balance:propertywise:' || credit.employee_id || ':' || credit.leave_type_id;

SELECT target.employee_name,
       target.code,
       balance.accrued,
       balance.used,
       balance.pending,
       balance.remaining,
       balance.unit,
       balance.as_of
FROM propertywise_initial_leave_targets AS target
JOIN public.leave_balances AS balance
  ON balance.tenant_id = 'propertywise'
 AND balance.employee_id = target.employee_id
 AND balance.leave_type_id = target.leave_type_id
ORDER BY target.employee_name, target.code;

ROLLBACK;
