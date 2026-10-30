-- Tenant provisioning previously created the default administrator job with
-- an 8-hour standard day but a 12-hour dashboard cap. Correct only untouched
-- provisioning defaults; custom job profiles and custom limits are preserved.
UPDATE job_profiles
SET max_daily_mins = 480
WHERE title = 'Organization Administrator'
  AND standard_daily_mins = 480
  AND standard_weekly_mins = 2400
  AND max_daily_mins = 720;
