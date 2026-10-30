-- A single timezone-aware dispatcher replaces per-tenant accrual schedules.
-- Newly created tenants are included automatically once active monthly leave
-- policies exist for at least one active employee.
CREATE OR REPLACE FUNCTION app_private.run_due_monthly_leave_accrual(
  p_run_at timestamptz DEFAULT CURRENT_TIMESTAMP
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant record;
  v_credited integer;
  v_total_credited integer := 0;
BEGIN
  IF p_run_at IS NULL THEN
    RAISE EXCEPTION 'Accrual run timestamp is required.';
  END IF;

  FOR v_tenant IN
    SELECT DISTINCT
      tenant.tenant_id,
      (p_run_at AT TIME ZONE tenant.timezone)::date AS local_date
    FROM public.tenants AS tenant
    LEFT JOIN public.tenant_platform_state AS platform_state
      ON platform_state.tenant_id = tenant.tenant_id
    JOIN public.employees AS employee
      ON employee.tenant_id = tenant.tenant_id
     AND employee.status = 'active'
    JOIN public.job_leave_policies AS policy
      ON policy.tenant_id = employee.tenant_id
     AND policy.job_id = employee.job_id
     AND policy.status = 'active'
    JOIN public.leave_types AS leave_type
      ON leave_type.tenant_id = policy.tenant_id
     AND leave_type.leave_type_id = policy.leave_type_id
     AND leave_type.status = 'active'
    WHERE COALESCE(platform_state.status, 'active') = 'active'
      AND policy.accrual_rule ->> 'type' = 'monthly'
      AND COALESCE(policy.accrual_rule ->> 'reset_frequency', 'annually')
          IN ('annually', 'monthly')
      AND policy.annual_allotment > 0
      AND policy.effective_from <= (p_run_at AT TIME ZONE tenant.timezone)::date
      AND (
        policy.effective_to IS NULL
        OR policy.effective_to >= (p_run_at AT TIME ZONE tenant.timezone)::date
      )
      AND extract(day FROM p_run_at AT TIME ZONE tenant.timezone) = 1
      AND extract(hour FROM p_run_at AT TIME ZONE tenant.timezone) = 0
    ORDER BY tenant.tenant_id
  LOOP
    SELECT app_private.run_monthly_leave_accrual(
      v_tenant.tenant_id,
      v_tenant.local_date
    )
    INTO v_credited;

    v_total_credited := v_total_credited + COALESCE(v_credited, 0);
  END LOOP;

  RETURN v_total_credited;
END;
$$;

REVOKE ALL ON FUNCTION app_private.run_due_monthly_leave_accrual(timestamptz)
FROM PUBLIC;

COMMENT ON FUNCTION app_private.run_due_monthly_leave_accrual(timestamptz) IS
  'Runs idempotent monthly leave accrual for every due active tenant in its own timezone.';
