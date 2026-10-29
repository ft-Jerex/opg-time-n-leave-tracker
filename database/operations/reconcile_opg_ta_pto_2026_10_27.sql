-- One-time, auditable reconciliation of opg-ta PTO balances.
-- Review the preview result first. Change ROLLBACK to COMMIT only after every
-- employee, PTO mapping, current balance, target, and delta has been verified.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('pto-reconcile:opg-ta:2026-10-27'));

CREATE TEMP TABLE requested_pto_balances (
  employee_name text PRIMARY KEY,
  target_remaining numeric NOT NULL
) ON COMMIT DROP;

INSERT INTO requested_pto_balances (employee_name, target_remaining) VALUES
  ('Armi Escamilla', 28.12),
  ('Ella Lapitan', 7.77),
  ('Allen Guevarra', 4.46),
  ('Hanna Mariño', 3.22),
  ('Joy Peduche', 7.91),
  ('Migs Perez', 8.34),
  ('Glam Tan', 3.17),
  ('Aki Zita', 0.67),
  ('Kyla Alinas', 2.33),
  ('Je Regalado', 1.33);

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.employees e
  JOIN requested_pto_balances r ON r.employee_name = e.name
  WHERE e.tenant_id = 'opg-ta';
  IF v_count <> 10 THEN
    RAISE EXCEPTION 'Expected 10 exact employee-name matches in opg-ta; found %.', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.leave_types
  WHERE tenant_id = 'opg-ta'
    AND upper(code) = 'PTO'
    AND unit = 'days'
    AND status = 'active';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active PTO leave type in opg-ta; found %.', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM requested_pto_balances r
  JOIN public.employees e
    ON e.tenant_id = 'opg-ta' AND e.name = r.employee_name
  JOIN public.leave_types lt
    ON lt.tenant_id = e.tenant_id
   AND upper(lt.code) = 'PTO'
   AND lt.unit = 'days'
   AND lt.status = 'active'
  JOIN public.job_leave_policies p
    ON p.tenant_id = e.tenant_id
   AND p.job_id = e.job_id
   AND p.leave_type_id = lt.leave_type_id
   AND p.status = 'active'
   AND p.annual_allotment = 28
   AND p.accrual_rule ->> 'type' = 'monthly'
   AND p.effective_from <= DATE '2026-10-27'
   AND (p.effective_to IS NULL OR p.effective_to >= DATE '2026-10-27');
  IF v_count <> 10 THEN
    RAISE EXCEPTION 'All 10 employees must have an active 28-day monthly PTO mapping; found %.', v_count;
  END IF;
END;
$$;

CREATE TEMP TABLE pto_reconciliation ON COMMIT DROP AS
SELECT
  e.employee_id,
  e.name AS employee_name,
  lt.leave_type_id,
  b.balance_id,
  b.period,
  b.remaining AS previous_remaining,
  r.target_remaining,
  r.target_remaining - b.remaining AS adjustment
FROM requested_pto_balances r
JOIN public.employees e
  ON e.tenant_id = 'opg-ta' AND e.name = r.employee_name
JOIN public.leave_types lt
  ON lt.tenant_id = e.tenant_id
 AND upper(lt.code) = 'PTO'
 AND lt.unit = 'days'
 AND lt.status = 'active'
JOIN LATERAL (
  SELECT candidate.*
  FROM public.leave_balances candidate
  WHERE candidate.tenant_id = e.tenant_id
    AND candidate.employee_id = e.employee_id
    AND candidate.leave_type_id = lt.leave_type_id
  ORDER BY candidate.as_of DESC, candidate.balance_id DESC
  LIMIT 1
) b ON true;

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM pto_reconciliation;
  IF v_count <> 10 THEN
    RAISE EXCEPTION 'Expected 10 existing PTO balances; found %.', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pto_reconciliation
  WHERE period <> '2026';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Every reconciled PTO balance must be in period 2026; found % outside that period.', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pto_reconciliation r
  JOIN public.leave_ledger_entries existing
    ON existing.entry_id = 'pto-reconcile:opg-ta:' || r.employee_id || ':2026-10-27'
  WHERE r.adjustment <> 0;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'A reconciliation entry already exists but its balance is not at the requested target.';
  END IF;
END;
$$;

SELECT 1
FROM public.leave_balances b
JOIN pto_reconciliation r
  ON r.balance_id = b.balance_id
 AND b.tenant_id = 'opg-ta'
FOR UPDATE OF b;

INSERT INTO public.leave_ledger_entries (
  entry_id, tenant_id, employee_id, leave_type_id, effective_date,
  amount, entry_type, source_id, reason, created_by, created_at
)
SELECT
  'pto-reconcile:opg-ta:' || employee_id || ':2026-10-27',
  'opg-ta', employee_id, leave_type_id, DATE '2026-10-27',
  adjustment, 'manual_adjustment', 'pto-reconcile:2026-10-27',
  'Reconciled to the supplied PTO balance through October 2026.',
  'system:pto-reconciliation', CURRENT_TIMESTAMP
FROM pto_reconciliation
WHERE adjustment <> 0;

UPDATE public.leave_balances b
SET manual_adjustments = b.manual_adjustments + r.adjustment,
    remaining = r.target_remaining,
    as_of = DATE '2026-10-27'
FROM pto_reconciliation r
WHERE b.tenant_id = 'opg-ta'
  AND b.balance_id = r.balance_id
  AND r.adjustment <> 0;

SELECT
  employee_name,
  previous_remaining,
  target_remaining,
  adjustment
FROM pto_reconciliation
ORDER BY employee_name;

ROLLBACK;
