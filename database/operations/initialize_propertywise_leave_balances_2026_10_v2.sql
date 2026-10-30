-- Supabase SQL Editor-safe initialization; no temporary tables are used.
-- Safe to rerun because each October credit has a deterministic ledger ID.

BEGIN;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM public.employees
    WHERE tenant_id = 'propertywise'
      AND status = 'active'
      AND (
        (employee_id = 'employee-b651a04d-fdbf-4b61-a976-ccbc6fb1098f' AND name = 'Marcelino Cruz')
        OR
        (employee_id = 'employee-38e589b9-465a-4e22-b546-0000d15cd1d3' AND name = 'Jose Benedic Garcia')
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'The two expected active Propertywise employees were not found.';
  END IF;
END;
$$;

WITH targets(employee_id, leave_type_id, amount) AS (
  VALUES
    ('employee-b651a04d-fdbf-4b61-a976-ccbc6fb1098f', '7e626aa7-93fe-4c83-a356-33f9d0dcca9b', 2.33::numeric),
    ('employee-b651a04d-fdbf-4b61-a976-ccbc6fb1098f', 'b5ef6e4d-49dc-4ef8-956a-8467b5335c10', 5::numeric),
    ('employee-38e589b9-465a-4e22-b546-0000d15cd1d3', '7e626aa7-93fe-4c83-a356-33f9d0dcca9b', 2.33::numeric),
    ('employee-38e589b9-465a-4e22-b546-0000d15cd1d3', 'b5ef6e4d-49dc-4ef8-956a-8467b5335c10', 5::numeric)
)
INSERT INTO public.leave_balances (
  balance_id, tenant_id, employee_id, leave_type_id, period,
  accrued, carried_over, manual_adjustments, used, pending,
  remaining, unit, as_of
)
SELECT 'balance:propertywise:' || target.employee_id || ':' || target.leave_type_id,
       'propertywise', target.employee_id, target.leave_type_id, '2026',
       0, 0, 0, 0, 0, 0, leave_type.unit, DATE '2026-10-01'
FROM targets AS target
JOIN public.leave_types AS leave_type
  ON leave_type.tenant_id = 'propertywise'
 AND leave_type.leave_type_id = target.leave_type_id
 AND leave_type.status = 'active'
ON CONFLICT (balance_id) DO NOTHING;

WITH targets(employee_id, leave_type_id, amount) AS (
  VALUES
    ('employee-b651a04d-fdbf-4b61-a976-ccbc6fb1098f', '7e626aa7-93fe-4c83-a356-33f9d0dcca9b', 2.33::numeric),
    ('employee-b651a04d-fdbf-4b61-a976-ccbc6fb1098f', 'b5ef6e4d-49dc-4ef8-956a-8467b5335c10', 5::numeric),
    ('employee-38e589b9-465a-4e22-b546-0000d15cd1d3', '7e626aa7-93fe-4c83-a356-33f9d0dcca9b', 2.33::numeric),
    ('employee-38e589b9-465a-4e22-b546-0000d15cd1d3', 'b5ef6e4d-49dc-4ef8-956a-8467b5335c10', 5::numeric)
), inserted_credits AS (
  INSERT INTO public.leave_ledger_entries (
    entry_id, tenant_id, employee_id, leave_type_id, effective_date,
    amount, entry_type, source_id, reason, created_by, created_at
  )
  SELECT 'leave-accrual:propertywise:' || target.employee_id || ':' || target.leave_type_id || ':2026-10',
         'propertywise', target.employee_id, target.leave_type_id,
         DATE '2026-10-01', target.amount, 'accrual',
         'monthly-leave-accrual:2026-10', 'Initial October 2026 leave credit.',
         'system:leave-accrual', CURRENT_TIMESTAMP
  FROM targets AS target
  ON CONFLICT (entry_id) DO NOTHING
  RETURNING employee_id, leave_type_id, amount
)
UPDATE public.leave_balances AS balance
SET accrued = balance.accrued + credit.amount,
    remaining = balance.remaining + credit.amount,
    as_of = DATE '2026-10-01'
FROM inserted_credits AS credit
WHERE balance.tenant_id = 'propertywise'
  AND balance.balance_id =
    'balance:propertywise:' || credit.employee_id || ':' || credit.leave_type_id;

SELECT employee.name AS employee_name,
       leave_type.code,
       balance.remaining,
       balance.unit,
       balance.as_of
FROM public.leave_balances AS balance
JOIN public.employees AS employee
  ON employee.tenant_id = balance.tenant_id
 AND employee.employee_id = balance.employee_id
JOIN public.leave_types AS leave_type
  ON leave_type.tenant_id = balance.tenant_id
 AND leave_type.leave_type_id = balance.leave_type_id
WHERE balance.tenant_id = 'propertywise'
  AND employee.employee_id IN (
    'employee-b651a04d-fdbf-4b61-a976-ccbc6fb1098f',
    'employee-38e589b9-465a-4e22-b546-0000d15cd1d3'
  )
  AND leave_type.leave_type_id IN (
    '7e626aa7-93fe-4c83-a356-33f9d0dcca9b',
    'b5ef6e4d-49dc-4ef8-956a-8467b5335c10'
  )
ORDER BY employee.name, leave_type.code;

COMMIT;
