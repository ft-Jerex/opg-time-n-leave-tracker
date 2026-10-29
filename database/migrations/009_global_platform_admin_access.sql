-- Platform credentials are global. Backfill every active platform
-- administrator into every existing tenant using that tenant's HR principal
-- for compatibility with tenant-scoped foreign keys and audit records.
CREATE INDEX IF NOT EXISTS platform_memberships_tenant_user_idx
  ON platform_memberships (tenant_id, tenant_user_id);

INSERT INTO platform_memberships
  (platform_user_id, tenant_id, tenant_user_id, roles, status)
SELECT p.platform_user_id,
       t.tenant_id,
       tenant_admin.user_id,
       ARRAY['Platform Administrator', 'HR Manager']::text[],
       'active'
  FROM platform_users p
 CROSS JOIN tenants t
 CROSS JOIN LATERAL (
   SELECT u.user_id
     FROM users u
    WHERE u.tenant_id = t.tenant_id
      AND 'users:write' = ANY(u.capabilities)
    ORDER BY (u.status = 'active') DESC, u.user_id
    LIMIT 1
 ) AS tenant_admin
 WHERE p.status = 'active'
ON CONFLICT (platform_user_id, tenant_id) DO UPDATE
  SET roles = EXCLUDED.roles,
      status = 'active';
