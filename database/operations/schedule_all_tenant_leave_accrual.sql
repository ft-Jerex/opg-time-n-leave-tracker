-- Run after migration 014 has been applied and Supabase Cron is enabled.
-- The hourly dispatcher selects only tenants whose local time is within the
-- first hour of the first day of a month. Ledger IDs make retries idempotent.

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN (
  'opg-ta-monthly-pto-accrual',
  'opg-ta-monthly-leave-accrual',
  'propertywise-monthly-leave-accrual',
  'all-tenants-monthly-leave-accrual'
);

SELECT cron.schedule(
  'all-tenants-monthly-leave-accrual',
  '15 * * * *',
  $job$
    SELECT app_private.run_due_monthly_leave_accrual(CURRENT_TIMESTAMP)
  $job$
);
