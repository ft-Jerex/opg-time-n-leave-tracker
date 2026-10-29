CREATE SCHEMA IF NOT EXISTS app_private;

REVOKE ALL ON SCHEMA app_private FROM PUBLIC;

DROP FUNCTION IF EXISTS app_private.run_monthly_pto_accrual(text, date);

CREATE OR REPLACE FUNCTION app_private.run_monthly_leave_accrual(
  p_tenant_id text,
  p_effective_date date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_month_start date := date_trunc('month', p_effective_date)::date;
  v_period text := to_char(date_trunc('year', p_effective_date), 'YYYY');
  v_month_key text := to_char(v_month_start, 'YYYY-MM');
  v_balance public.leave_balances%ROWTYPE;
  v_policy record;
  v_accrual_entry_id text;
  v_carry numeric;
  v_inserted integer;
  v_credited integer := 0;
BEGIN
  IF p_tenant_id IS NULL OR length(trim(p_tenant_id)) = 0 THEN
    RAISE EXCEPTION 'Tenant ID is required.';
  END IF;

  IF p_effective_date IS NULL OR p_effective_date <> v_month_start THEN
    RAISE EXCEPTION 'Leave accrual date must be the first day of a month.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('monthly-leave-accrual:' || p_tenant_id || ':' || v_month_key)
  );

  FOR v_policy IN
    SELECT DISTINCT ON (e.employee_id, lt.leave_type_id)
      e.employee_id,
      lt.leave_type_id,
      lt.unit,
      p.carry_over_limit,
      COALESCE(p.accrual_rule ->> 'reset_frequency', 'annually') AS reset_frequency,
      round(p.annual_allotment / 12, 6) AS monthly_credit
    FROM public.employees e
    JOIN public.job_leave_policies p
      ON p.tenant_id = e.tenant_id
     AND p.job_id = e.job_id
    JOIN public.leave_types lt
      ON lt.tenant_id = p.tenant_id
     AND lt.leave_type_id = p.leave_type_id
    WHERE e.tenant_id = p_tenant_id
      AND e.status = 'active'
      AND p.status = 'active'
      AND lt.status = 'active'
      AND p.accrual_rule ->> 'type' = 'monthly'
      AND COALESCE(p.accrual_rule ->> 'reset_frequency', 'annually') IN ('annually', 'monthly')
      AND p.effective_from <= v_month_start
      AND (p.effective_to IS NULL OR p.effective_to >= v_month_start)
      AND p.annual_allotment > 0
    ORDER BY e.employee_id, lt.leave_type_id, p.effective_from DESC, p.policy_id
  LOOP
    v_accrual_entry_id :=
      'leave-accrual:' || p_tenant_id || ':' || v_policy.employee_id || ':' ||
      v_policy.leave_type_id || ':' || v_month_key;

    IF EXISTS (
      SELECT 1
      FROM public.leave_ledger_entries
      WHERE entry_id = v_accrual_entry_id
    ) THEN
      CONTINUE;
    END IF;

    SELECT *
      INTO v_balance
      FROM public.leave_balances
     WHERE tenant_id = p_tenant_id
       AND employee_id = v_policy.employee_id
       AND leave_type_id = v_policy.leave_type_id
     ORDER BY as_of DESC, balance_id DESC
     LIMIT 1
     FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.leave_balances (
        balance_id, tenant_id, employee_id, leave_type_id, period,
        accrued, carried_over, manual_adjustments, used, pending,
        remaining, unit, as_of
      ) VALUES (
        'balance:' || p_tenant_id || ':' || v_policy.employee_id || ':' || v_policy.leave_type_id,
        p_tenant_id, v_policy.employee_id, v_policy.leave_type_id, v_period,
        0, 0, 0, 0, 0, 0, v_policy.unit, v_month_start
      )
      RETURNING * INTO v_balance;
    ELSIF v_policy.reset_frequency = 'monthly' THEN
      IF v_balance.remaining <> 0 THEN
        INSERT INTO public.leave_ledger_entries (
          entry_id, tenant_id, employee_id, leave_type_id, effective_date,
          amount, entry_type, source_id, reason, created_by, created_at
        ) VALUES (
          'leave-monthly-expiry:' || p_tenant_id || ':' || v_policy.employee_id || ':' ||
            v_policy.leave_type_id || ':' || v_month_key,
          p_tenant_id, v_policy.employee_id, v_policy.leave_type_id, v_month_start,
          -v_balance.remaining, 'expiry', 'monthly-reset:' || v_month_key,
          'Unused leave expired at monthly reset.', 'system:leave-accrual', CURRENT_TIMESTAMP
        );
      END IF;

      UPDATE public.leave_balances
         SET period = v_period,
             accrued = 0,
             carried_over = 0,
             manual_adjustments = 0,
             used = 0,
             remaining = 0,
             as_of = v_month_start
       WHERE tenant_id = p_tenant_id
         AND balance_id = v_balance.balance_id
      RETURNING * INTO v_balance;
    ELSIF v_balance.period <> v_period THEN
      v_carry := CASE
        WHEN v_balance.remaining <= 0 THEN v_balance.remaining
        ELSE LEAST(v_balance.remaining, v_policy.carry_over_limit)
      END;

      IF v_balance.remaining > 0 THEN
        INSERT INTO public.leave_ledger_entries (
          entry_id, tenant_id, employee_id, leave_type_id, effective_date,
          amount, entry_type, source_id, reason, created_by, created_at
        ) VALUES (
          'leave-annual-close:' || p_tenant_id || ':' || v_policy.employee_id || ':' ||
            v_policy.leave_type_id || ':' || v_period,
          p_tenant_id, v_policy.employee_id, v_policy.leave_type_id, v_month_start,
          -v_balance.remaining, 'expiry', 'annual-reset:' || v_period,
          'Prior-year leave balance closed.', 'system:leave-accrual', CURRENT_TIMESTAMP
        );
      END IF;

      IF v_carry > 0 THEN
        INSERT INTO public.leave_ledger_entries (
          entry_id, tenant_id, employee_id, leave_type_id, effective_date,
          amount, entry_type, source_id, reason, created_by, created_at
        ) VALUES (
          'leave-annual-carry:' || p_tenant_id || ':' || v_policy.employee_id || ':' ||
            v_policy.leave_type_id || ':' || v_period,
          p_tenant_id, v_policy.employee_id, v_policy.leave_type_id, v_month_start,
          v_carry, 'carry_over', 'annual-carry-over:' || v_period,
          'Leave carried into the new policy year.', 'system:leave-accrual', CURRENT_TIMESTAMP
        );
      END IF;

      UPDATE public.leave_balances
         SET period = v_period,
             accrued = 0,
             carried_over = v_carry,
             manual_adjustments = 0,
             used = 0,
             remaining = v_carry,
             as_of = v_month_start
       WHERE tenant_id = p_tenant_id
         AND balance_id = v_balance.balance_id
      RETURNING * INTO v_balance;
    END IF;

    INSERT INTO public.leave_ledger_entries (
      entry_id, tenant_id, employee_id, leave_type_id, effective_date,
      amount, entry_type, source_id, reason, created_by, created_at
    ) VALUES (
      v_accrual_entry_id, p_tenant_id, v_policy.employee_id, v_policy.leave_type_id,
      v_month_start, v_policy.monthly_credit, 'accrual',
      'monthly-leave-accrual:' || v_month_key,
      'Automatic monthly leave credit.', 'system:leave-accrual', CURRENT_TIMESTAMP
    )
    ON CONFLICT (entry_id) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 1 THEN
      UPDATE public.leave_balances
         SET accrued = accrued + v_policy.monthly_credit,
             remaining = remaining + v_policy.monthly_credit,
             as_of = v_month_start
       WHERE tenant_id = p_tenant_id
         AND balance_id = v_balance.balance_id;
      v_credited := v_credited + 1;
    END IF;
  END LOOP;

  RETURN v_credited;
END;
$$;

REVOKE ALL ON FUNCTION app_private.run_monthly_leave_accrual(text, date) FROM PUBLIC;

COMMENT ON FUNCTION app_private.run_monthly_leave_accrual(text, date) IS
  'Idempotently applies monthly or annual balance rollover and credits active monthly leave policies.';
