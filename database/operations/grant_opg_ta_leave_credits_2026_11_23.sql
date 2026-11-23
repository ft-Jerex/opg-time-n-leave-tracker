-- One-time credit for the 10 active opg-ta employees with available PTO,
-- plus 10 days of LWP for Aphrodite Marie Quey Abalos.
-- Preview by replacing the final COMMIT with ROLLBACK.

BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL statement_timeout = '15s';
SELECT pg_advisory_xact_lock(hashtext('leave-credit:opg-ta:2026-11-23'));

CREATE TEMP TABLE credit_targets ON COMMIT DROP AS
WITH requested (employee_id, code) AS (
  VALUES
    ('employee-08690bd9-3dd4-4134-aaeb-114b7a3f5166', 'PTO'),
    ('employee-afb695c7-b96d-4767-941c-9e15695bb15a', 'PTO'),
    ('employee-458111c0-80a4-4760-913a-c0a36f909573', 'PTO'),
    ('employee-0691b5c5-e3d5-43aa-a8be-a2a3277fc624', 'PTO'),
    ('employee-948fe3a5-6502-4b3a-84c5-310d00380cc1', 'PTO'),
    ('f8d9d3a6-2e71-44cc-bb04-3341046fdd4a', 'PTO'),
    ('employee-58d0029e-3a00-49ab-85a8-cc15aa751382', 'PTO'),
    ('employee-01846c95-dcc9-4a9f-a68b-eb29e33aa312', 'PTO'),
    ('employee-60efb344-38d7-46f9-8cc0-9f6314f1d891', 'PTO'),
    ('employee-fd625ef0-e9df-4e0a-a16e-3763c9049ed9', 'PTO'),
    ('employee-f82d0cf8-9939-4ebe-945c-a8cbc3498e25', 'LWP')
)
SELECT e.employee_id, e.name AS employee_name, lt.leave_type_id, r.code,
       b.balance_id, b.remaining AS previous_remaining,
       b.manual_adjustments AS previous_adjustments, b.used AS previous_used,
       b.pending AS previous_pending
FROM requested r
JOIN public.employees e
  ON e.tenant_id = 'opg-ta' AND e.employee_id = r.employee_id AND e.status = 'active'
JOIN public.leave_types lt
  ON lt.tenant_id = e.tenant_id AND lt.code = r.code
 AND lt.status = 'active' AND lt.unit = 'days' AND lt.is_paid = (r.code = 'PTO')
JOIN public.job_leave_policies p
  ON p.tenant_id = e.tenant_id AND p.job_id = e.job_id
 AND p.leave_type_id = lt.leave_type_id AND p.status = 'active'
 AND p.effective_from <= DATE '2026-11-23'
 AND (p.effective_to IS NULL OR p.effective_to >= DATE '2026-11-23')
JOIN public.leave_balances b
  ON b.tenant_id = e.tenant_id AND b.employee_id = e.employee_id
 AND b.leave_type_id = lt.leave_type_id AND b.period = '2026'
WHERE r.code = 'LWP' OR b.remaining - b.pending > 0;

DO $$
BEGIN
  IF (SELECT count(*) FROM credit_targets) <> 11
     OR (SELECT count(*) FROM credit_targets WHERE code = 'PTO') <> 10
     OR (SELECT count(DISTINCT balance_id) FROM credit_targets) <> 11 THEN
    RAISE EXCEPTION 'Expected exactly 10 eligible PTO balances and Aphrodite LWP.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM credit_targets
    WHERE code = 'LWP' AND employee_id = 'employee-f82d0cf8-9939-4ebe-945c-a8cbc3498e25'
      AND employee_name = 'Aphrodite Marie Quey Abalos'
  ) THEN
    RAISE EXCEPTION 'Aphrodite LWP identity did not match.';
  END IF;

  IF (
    SELECT count(DISTINCT e.employee_id)
    FROM public.employees e
    JOIN public.leave_types lt ON lt.tenant_id = e.tenant_id
      AND lt.code = 'PTO' AND lt.is_paid AND lt.unit = 'days' AND lt.status = 'active'
    JOIN public.job_leave_policies p ON p.tenant_id = e.tenant_id
      AND p.job_id = e.job_id AND p.leave_type_id = lt.leave_type_id
      AND p.status = 'active' AND p.effective_from <= DATE '2026-11-23'
      AND (p.effective_to IS NULL OR p.effective_to >= DATE '2026-11-23')
    JOIN public.leave_balances b ON b.tenant_id = e.tenant_id
      AND b.employee_id = e.employee_id AND b.leave_type_id = lt.leave_type_id
      AND b.period = '2026' AND b.remaining - b.pending > 0
    WHERE e.tenant_id = 'opg-ta' AND e.status = 'active'
  ) <> 10 THEN
    RAISE EXCEPTION 'The set of employees with available PTO changed.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.leave_ledger_entries
    WHERE tenant_id = 'opg-ta'
      AND source_id = 'manual-credit:opg-ta:2026-11-23'
  ) THEN
    RAISE EXCEPTION 'This credit operation was already recorded.';
  END IF;
END;
$$;

SELECT b.balance_id
FROM public.leave_balances b
JOIN credit_targets t ON t.balance_id = b.balance_id AND b.tenant_id = 'opg-ta'
FOR UPDATE OF b;

INSERT INTO public.leave_ledger_entries (
  entry_id, tenant_id, employee_id, leave_type_id, effective_date,
  amount, entry_type, source_id, reason, created_by, created_at
)
SELECT 'manual-credit:opg-ta:2026-11-23:' || code || ':' || employee_id,
       'opg-ta', employee_id, leave_type_id, DATE '2026-11-23',
       10, 'manual_adjustment', 'manual-credit:opg-ta:2026-11-23',
       CASE code WHEN 'PTO' THEN 'Additional 10 Paid Time Off credits.'
                 ELSE 'Additional 10 Leave without Pay credits.' END,
       'system:requested-leave-credit', CURRENT_TIMESTAMP
FROM credit_targets;

UPDATE public.leave_balances b
SET manual_adjustments = b.manual_adjustments + 10,
    remaining = b.remaining + 10,
    as_of = DATE '2026-11-23'
FROM credit_targets t
WHERE b.tenant_id = 'opg-ta' AND b.balance_id = t.balance_id;

DO $$
BEGIN
  IF (
    SELECT count(*) FROM public.leave_ledger_entries
    WHERE tenant_id = 'opg-ta'
      AND source_id = 'manual-credit:opg-ta:2026-11-23'
  ) <> 11 OR EXISTS (
    SELECT 1 FROM credit_targets t
    JOIN public.leave_balances b ON b.tenant_id = 'opg-ta' AND b.balance_id = t.balance_id
    WHERE b.manual_adjustments <> t.previous_adjustments + 10
       OR b.remaining <> t.previous_remaining + 10
       OR b.used <> t.previous_used OR b.pending <> t.previous_pending
       OR b.as_of <> DATE '2026-11-23'
  ) THEN
    RAISE EXCEPTION 'Credit ledger or balance verification failed.';
  END IF;
END;
$$;

SELECT t.employee_name, t.code, t.previous_remaining,
       b.remaining AS new_remaining, b.pending,
       b.remaining - b.pending AS available_after
FROM credit_targets t
JOIN public.leave_balances b ON b.tenant_id = 'opg-ta' AND b.balance_id = t.balance_id
ORDER BY t.code, t.employee_name;

COMMIT;
