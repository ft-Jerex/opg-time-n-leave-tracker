-- Run after migration 010 has been applied and pg_cron has been enabled in
-- Supabase Dashboard -> Integrations -> Cron.
-- Supabase cron schedules use GMT. 16:05 GMT is 00:05 Asia/Manila next day.

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'opg-ta-monthly-pto-accrual';

SELECT cron.schedule(
  'opg-ta-monthly-leave-accrual',
  '5 16 28-31 * *',
  $job$
    SELECT app_private.run_monthly_leave_accrual(
      'opg-ta',
      (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
    )
    WHERE extract(day FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila') = 1
  $job$
);
