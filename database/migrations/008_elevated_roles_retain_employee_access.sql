-- Reporting and HR managers are employees too. Backfill elevated accounts
-- created before that inheritance was enforced by the application service.
UPDATE users
SET capabilities = (
  SELECT array_agg(DISTINCT capability ORDER BY capability)
  FROM unnest(
    users.capabilities || ARRAY[
      'attendance:write',
      'attendance-adjustments:write',
      'leave:write',
      'leave-requests:write',
      'overtime-requests:write'
    ]::text[]
  ) AS expanded(capability)
)
WHERE ('leave:approve' = ANY(capabilities) OR 'users:write' = ANY(capabilities))
  AND NOT capabilities @> ARRAY[
    'attendance:write',
    'attendance-adjustments:write',
    'leave:write',
    'leave-requests:write',
    'overtime-requests:write'
  ]::text[];
