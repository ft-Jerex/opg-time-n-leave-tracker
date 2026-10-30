-- Default organization administrators follow the standard scheduled day.
-- Restrict this correction to the exact provisioned administrator profile.
WITH changed_jobs AS (
  UPDATE job_profiles
  SET is_ot_eligible = false
  WHERE title = 'Organization Administrator'
    AND standard_daily_mins = 480
    AND standard_weekly_mins = 2400
    AND max_daily_mins = 480
    AND is_ot_eligible = true
  RETURNING tenant_id, job_id
)
UPDATE attendance_summaries AS summary
SET worked_mins = LEAST(summary.worked_mins, summary.scheduled_mins),
    overtime_mins = 0
FROM changed_jobs AS job
WHERE job.tenant_id = summary.tenant_id
  AND job.job_id = summary.effective_job_id
  AND (
    summary.worked_mins > summary.scheduled_mins
    OR summary.overtime_mins <> 0
  );
