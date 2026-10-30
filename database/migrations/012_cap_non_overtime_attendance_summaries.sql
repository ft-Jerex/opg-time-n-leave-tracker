-- Preserve raw attendance sessions for audit while correcting derived totals.
-- Overtime-eligible summaries retain their recorded worked and overtime minutes.
UPDATE attendance_summaries AS summary
SET worked_mins = LEAST(summary.worked_mins, summary.scheduled_mins),
    overtime_mins = 0
FROM job_profiles AS job
WHERE job.tenant_id = summary.tenant_id
  AND job.job_id = summary.effective_job_id
  AND job.is_ot_eligible = false
  AND (
    summary.worked_mins > summary.scheduled_mins
    OR summary.overtime_mins <> 0
  );
