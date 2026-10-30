import crypto from "node:crypto";
import { pool, withTransaction } from "../config/database.js";
import { HttpError } from "../views/problem-view.js";

const id = () => crypto.randomUUID();
const invitationToken = () => crypto.randomBytes(32).toString("base64url");
export const hashInvitationToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");
const now = () => new Date().toISOString();
const invitationLifetimeHours = () =>
  Math.min(Math.max(Number(process.env.INVITATION_TTL_HOURS || 72), 1), 720);
const assertPlatform = (req) => {
  if (req.actor?.actor_kind !== "platform")
    throw new HttpError(403, "Forbidden", "A platform administrator context is required.");
};

const assertPlatformWrite = (req) => {
  assertPlatform(req);
  if (!req.actor?.capabilities?.includes("organizations:write"))
    throw new HttpError(403, "Forbidden", "Organization provisioning is not allowed for this platform account.");
};

const requiredString = (value, field) => {
  if (typeof value !== "string" || !value.trim())
    throw new HttpError(422, "Invalid Request", `${field} is required.`);
  return value.trim();
};

export const normalizeEmail = (value, field = "email") => {
  const email = requiredString(value, field).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email))
    throw new HttpError(422, "Invalid Request", `${field} must be a valid email address.`);
  return email;
};

export const normalizeTenantId = (value) => {
  const tenantId = requiredString(value, "tenant_id").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(tenantId))
    throw new HttpError(422, "Invalid Request", "tenant_id must be a lowercase slug between 2 and 48 characters.");
  return tenantId;
};

export const normalizeTimezone = (value) => {
  const timezone = requiredString(value, "timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new HttpError(422, "Invalid Request", "timezone must be a valid IANA timezone.");
  }
  return timezone;
};

export const normalizeOrganization = (body, { partial = false } = {}) => {
  const source = body || {};
  const result = {};
  if (!partial || source.name !== undefined) result.name = requiredString(source.name, "name");
  if (!partial || source.timezone !== undefined) result.timezone = normalizeTimezone(source.timezone);
  if (!partial || source.locale !== undefined) result.locale = requiredString(source.locale, "locale");
  if (!partial || source.currency !== undefined) result.currency = requiredString(source.currency, "currency").toUpperCase();
  if (!partial || source.week_start !== undefined) {
    const weekStart = Number(source.week_start);
    if (!Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6)
      throw new HttpError(422, "Invalid Request", "week_start must be an integer from 0 to 6.");
    result.week_start = weekStart;
  }
  if (source.support_email !== undefined)
    result.support_email = normalizeEmail(source.support_email, "support_email");
  return result;
};

export const hrCapabilities = [
  "attendance-sessions:write", "attendance-adjustments:write", "attendance:write", "attendance:override",
  "attendance:approve", "leave-requests:write", "leave:write", "leave:approve",
  "leave:override", "overtime-requests:write", "overtime:approve", "job-profiles:write", "job-leave-policies:write",
  "employees:write", "users:write", "departments:write", "locations:write",
  "work-schedules:write", "attachments:write", "holiday-calendars:write",
  "holidays:write", "alerts:write",
];

const grantPlatformAdministratorsTenantAccess = async (client, tenantId, tenantUserId) => {
  await client.query(
    `INSERT INTO platform_memberships
      (platform_user_id,tenant_id,tenant_user_id,roles,status)
     SELECT platform_user_id,$1,$2,ARRAY['Platform Administrator','HR Manager'],'active'
       FROM platform_users
      WHERE status='active'
     ON CONFLICT (platform_user_id,tenant_id) DO UPDATE
       SET roles=EXCLUDED.roles,
           status='active'`,
    [tenantId, tenantUserId],
  );
};

const invitationUrl = (req, token) => {
  const base = (process.env.INVITATION_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return `${base}/#/accept-invitation?token=${encodeURIComponent(token)}`;
};

const deliverInvitation = async ({ req, email, organizationName, token, expiresAt }) => {
  const endpoint = process.env.INVITATION_DELIVERY_URL;
  if (!endpoint) {
    if (process.env.NODE_ENV === "production")
      throw new HttpError(503, "Invitation Delivery Not Configured", "Configure INVITATION_DELIVERY_URL before provisioning organizations in production.");
    return { status: "not_configured" };
  }
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: email,
        organization_name: organizationName,
        invite_url: invitationUrl(req, token),
        expires_at: expiresAt,
      }),
    });
  } catch {
    throw new HttpError(502, "Invitation Delivery Failed", "The invitation provider could not be reached.");
  }
  if (!response.ok)
    throw new HttpError(502, "Invitation Delivery Failed", "The invitation provider rejected the invitation.");
  return { status: "sent" };
};

const deliverOrReport = async (payload) => {
  try {
    return await deliverInvitation(payload);
  } catch (error) {
    if ([502, 503].includes(error.status)) return { status: "failed" };
    throw error;
  }
};

const auditPlatform = async (client, req, action, targetId, reason = null, metadata = {}) => {
  await client.query(
    `INSERT INTO platform_audit_events
      (event_id, platform_user_id, action, target_type, target_id, occurred_at, reason, metadata)
     VALUES ($1,$2,$3,'Tenant',$4,$5,$6,$7::jsonb)`,
    [id(), req.actor.platform_user_id || req.actor.user_id, action, targetId, now(), reason, JSON.stringify(metadata)],
  );
};

export const provisionTenantDefaults = async (client, { tenantId, organization, adminName, adminEmail, active = true, duplicateMessage = "An organization with this ID already exists." }) => {
  const duplicate = await client.query("SELECT 1 FROM tenants WHERE tenant_id=$1", [tenantId]);
  if (duplicate.rowCount)
    throw new HttpError(409, "Duplicate Organization", duplicateMessage);
  const usedEmail = await client.query(
    `SELECT 1 FROM users WHERE lower(email)=lower($1)
     UNION ALL SELECT 1 FROM auth_credentials WHERE lower(email)=lower($1)
     UNION ALL SELECT 1 FROM platform_users WHERE lower(email)=lower($1)
     UNION ALL SELECT 1 FROM platform_credentials WHERE lower(email)=lower($1)
     LIMIT 1`,
    [adminEmail],
  );
  if (usedEmail.rowCount)
    throw new HttpError(409, "Duplicate Email", "This email is already assigned to a tenant account.");
  const ids = { department: id(), calendar: id(), location: id(), schedule: id(), job: id(), employee: id(), user: id() };
  const status = active ? "active" : "inactive";
  const settings = { support_email: organization.support_email || adminEmail, minimum_coverage: 1, overtime_warning_percent: 80 };
  await client.query(
    `INSERT INTO tenants (tenant_id,name,timezone,locale,week_start,currency,settings)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [tenantId, organization.name, organization.timezone, organization.locale, organization.week_start, organization.currency, JSON.stringify(settings)],
  );
  await client.query(
    `INSERT INTO tenant_platform_state (tenant_id,status,settings)
     VALUES ($1,'active',$2::jsonb)`,
    [tenantId, JSON.stringify({ minimum_coverage: 1, overtime_warning_percent: 80 })],
  );
  await client.query(
    `INSERT INTO departments (department_id,tenant_id,name,code,status)
     VALUES ($1,$2,'General','GENERAL','active')`,
    [ids.department, tenantId],
  );
  await client.query(
    `INSERT INTO holiday_calendars (holiday_calendar_id,tenant_id,name,location_ids,status)
     VALUES ($1,$2,'Default calendar',ARRAY[]::text[],'active')`,
    [ids.calendar, tenantId],
  );
  await client.query(
    `INSERT INTO locations (location_id,tenant_id,name,timezone,holiday_calendar_id,status)
     VALUES ($1,$2,'Default location',$3,$4,'active')`,
    [ids.location, tenantId, organization.timezone, ids.calendar],
  );
  await client.query(
    `UPDATE holiday_calendars SET location_ids=ARRAY[$1]::text[]
     WHERE tenant_id=$2 AND holiday_calendar_id=$3`,
    [ids.location, tenantId, ids.calendar],
  );
  await client.query(
    `INSERT INTO work_schedules (schedule_id,tenant_id,name,weekday_rules,effective_from,effective_to,status)
     VALUES ($1,$2,'Standard Monday-Friday',$3::jsonb,CURRENT_DATE,NULL,'active')`,
    [ids.schedule, tenantId, JSON.stringify({
      monday: { start: "09:00", end: "17:00" }, tuesday: { start: "09:00", end: "17:00" },
      wednesday: { start: "09:00", end: "17:00" }, thursday: { start: "09:00", end: "17:00" },
      friday: { start: "09:00", end: "17:00" },
    })],
  );
  await client.query(
    `INSERT INTO job_profiles (job_id,tenant_id,title,department_id,standard_daily_mins,standard_weekly_mins,is_ot_eligible,max_daily_mins,effective_from,effective_to,status)
     VALUES ($1,$2,'Organization Administrator',$3,480,2400,false,480,CURRENT_DATE,NULL,'active')`,
    [ids.job, tenantId, ids.department],
  );
  await client.query(
    `INSERT INTO employees (employee_id,tenant_id,employee_number,name,job_id,manager_id,department_id,location_id,holiday_calendar_id,work_schedule,start_date,status)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9::jsonb,CURRENT_DATE,$10)`,
    [ids.employee, tenantId, `${tenantId.toUpperCase()}-ADMIN`, adminName, ids.job, ids.department, ids.location, ids.calendar, JSON.stringify({ schedule_id: ids.schedule }), status],
  );
  await client.query(
    `INSERT INTO users (user_id,tenant_id,employee_id,display_name,email,capabilities,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ids.user, tenantId, ids.employee, adminName, adminEmail, hrCapabilities, status],
  );
  // A platform login is global. Keep the tenant-user mapping internal so the
  // existing tenant-scoped SQL and audit constraints remain enforced without
  // creating another password for the platform administrator.
  await grantPlatformAdministratorsTenantAccess(client, tenantId, ids.user);
  return { ...ids, settings };
};

const mapTenant = (row) => ({
  ...row,
  invitation: row.invitation_status
    ? {
        status: row.invitation_status,
        email: row.invitation_email,
        expires_at: row.invitation_expires_at,
      }
    : null,
});

const tenantQuery = `
  SELECT t.tenant_id, t.name, t.timezone, t.locale, t.week_start, t.currency, t.settings,
         COALESCE(s.status,'active') AS status, COALESCE(s.settings,'{}'::jsonb) AS platform_settings,
         (SELECT count(*)::integer FROM employees e WHERE e.tenant_id=t.tenant_id AND e.status='active') AS active_employees,
         (SELECT count(*)::integer FROM leave_requests l WHERE l.tenant_id=t.tenant_id AND l.status='pending') AS pending_requests,
         invite.email AS invitation_email,
         invite.expires_at AS invitation_expires_at,
         CASE
           WHEN invite.accepted_at IS NOT NULL THEN 'accepted'
           WHEN invite.revoked_at IS NOT NULL THEN 'revoked'
           WHEN invite.expires_at < now() THEN 'expired'
           WHEN invite.invite_id IS NOT NULL THEN 'pending'
           ELSE NULL
         END AS invitation_status
    FROM tenants t
    LEFT JOIN tenant_platform_state s ON s.tenant_id=t.tenant_id
    LEFT JOIN LATERAL (
      SELECT i.invite_id, i.email, i.expires_at, i.accepted_at, i.revoked_at
        FROM tenant_invitations i
       WHERE i.tenant_id=t.tenant_id
       ORDER BY i.created_at DESC
       LIMIT 1
    ) invite ON true`;

const normalizeSettings = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(422, "Invalid Settings", "Settings must be an object.");
  const settings = {};
  if (value.minimum_coverage !== undefined) {
    const coverage = Number(value.minimum_coverage);
    if (!Number.isInteger(coverage) || coverage < 0 || coverage > 100000)
      throw new HttpError(422, "Invalid Settings", "Minimum coverage must be a non-negative whole number.");
    settings.minimum_coverage = coverage;
  }
  if (value.overtime_warning_percent !== undefined) {
    const threshold = Number(value.overtime_warning_percent);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100)
      throw new HttpError(422, "Invalid Settings", "Overtime warning percentage must be between 1 and 100.");
    settings.overtime_warning_percent = threshold;
  }
  if (!Object.keys(settings).length)
    throw new HttpError(422, "Invalid Settings", "At least one supported setting is required.");
  return settings;
};

export const listTenants = async (req) => {
  assertPlatform(req);
  const result = await pool.query(`${tenantQuery} ORDER BY t.name ASC`);
  return result.rows.map(mapTenant);
};

export const createTenant = async (req) => {
  assertPlatformWrite(req);
  const tenantId = normalizeTenantId(req.body?.tenant_id);
  const organization = normalizeOrganization(req.body);
  const adminName = requiredString(req.body?.initial_admin?.display_name, "initial_admin.display_name");
  const adminEmail = normalizeEmail(req.body?.initial_admin?.email, "initial_admin.email");
  const token = process.env.NODE_ENV === "test" && process.env.INVITATION_TEST_TOKEN
    ? process.env.INVITATION_TEST_TOKEN
    : invitationToken();
  const inviteId = id();
  const expiresAt = new Date(Date.now() + invitationLifetimeHours() * 60 * 60 * 1000).toISOString();
  const platformUserId = req.actor.platform_user_id || req.actor.user_id;

  const created = await withTransaction(async (client) => {
    const ids = await provisionTenantDefaults(client, {
      tenantId,
      organization,
      adminName,
      adminEmail,
      active: false,
    });
    await client.query(
      `INSERT INTO tenant_invitations (invite_id,tenant_id,user_id,email,token_hash,expires_at,created_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [inviteId, tenantId, ids.user, adminEmail, hashInvitationToken(token), expiresAt, now(), platformUserId],
    );
    await auditPlatform(client, req, "tenant_created", tenantId, req.body.reason || null, {
      name: organization.name,
      initial_admin_email: adminEmail,
    });
    await auditPlatform(client, req, "tenant_invitation_created", tenantId, "Initial HR administrator invitation created", {
      email: adminEmail,
      invite_id: inviteId,
    });
    return { tenantId, inviteId, token, expiresAt, email: adminEmail, organizationName: organization.name };
  });

  const delivery = await deliverOrReport({
    req,
    email: created.email,
    organizationName: created.organizationName,
    token: created.token,
    expiresAt: created.expiresAt,
  });
  const tenant = await pool.query(`${tenantQuery} WHERE t.tenant_id=$1`, [created.tenantId]);
  return { ...mapTenant(tenant.rows[0]), invitation_delivery: delivery.status, invite_url: invitationUrl(req, created.token), invite_expires_at: created.expiresAt };
};

export const updateTenant = async (req) => {
  assertPlatformWrite(req);
  const tenantId = normalizeTenantId(req.params.tenant_id);
  const patch = normalizeOrganization(req.body, { partial: true });
  if (!Object.keys(patch).length)
    throw new HttpError(422, "Invalid Request", "At least one organization field is required.");
  return withTransaction(async (client) => {
    const current = await client.query("SELECT * FROM tenants WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
    if (!current.rowCount) throw new HttpError(404, "Not Found", "Organization not found.");
    const next = { ...current.rows[0], ...patch };
    const settings = { ...(current.rows[0].settings || {}) };
    if (patch.support_email !== undefined) settings.support_email = patch.support_email;
    await client.query(
      `UPDATE tenants SET name=$1,timezone=$2,locale=$3,week_start=$4,currency=$5,settings=$6::jsonb
       WHERE tenant_id=$7`,
      [next.name, next.timezone, next.locale, next.week_start, next.currency, JSON.stringify(settings), tenantId],
    );
    await auditPlatform(client, req, "tenant_updated", tenantId, req.body.reason || null, patch);
    const result = await client.query(`${tenantQuery} WHERE t.tenant_id=$1`, [tenantId]);
    return mapTenant(result.rows[0]);
  });
};

export const resendInvitation = async (req) => {
  assertPlatformWrite(req);
  const tenantId = normalizeTenantId(req.params.tenant_id);
  const created = await withTransaction(async (client) => {
    const tenant = await client.query("SELECT tenant_id,name FROM tenants WHERE tenant_id=$1", [tenantId]);
    if (!tenant.rowCount) throw new HttpError(404, "Not Found", "Organization not found.");
    const pending = await client.query(
      `SELECT i.invite_id, i.email, i.user_id
         FROM tenant_invitations i
        WHERE i.tenant_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        ORDER BY i.created_at DESC LIMIT 1 FOR UPDATE`,
      [tenantId],
    );
    if (!pending.rowCount)
      throw new HttpError(409, "Invitation Unavailable", "There is no pending invitation to resend.");
    const token = invitationToken();
    const expiresAt = new Date(Date.now() + invitationLifetimeHours() * 60 * 60 * 1000).toISOString();
    await client.query("UPDATE tenant_invitations SET revoked_at=now() WHERE invite_id=$1", [pending.rows[0].invite_id]);
    const inviteId = id();
    await client.query(
      `INSERT INTO tenant_invitations (invite_id,tenant_id,user_id,email,token_hash,expires_at,created_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [inviteId, tenantId, pending.rows[0].user_id, pending.rows[0].email, hashInvitationToken(token), expiresAt, now(), req.actor.platform_user_id || req.actor.user_id],
    );
    await auditPlatform(client, req, "tenant_invitation_resent", tenantId, req.body?.reason || null, {
      email: pending.rows[0].email,
      invite_id: inviteId,
    });
    return { tenantId, organizationName: tenant.rows[0].name, email: pending.rows[0].email, token, expiresAt };
  });
  const delivery = await deliverOrReport({
    req,
    email: created.email,
    organizationName: created.organizationName,
    token: created.token,
    expiresAt: created.expiresAt,
  });
  return { invitation_delivery: delivery.status, invite_url: invitationUrl(req, created.token), expires_at: created.expiresAt };
};

export const generateInvitationLink = async (req) => {
  assertPlatformWrite(req);
  const tenantId = normalizeTenantId(req.params.tenant_id);
  const created = await withTransaction(async (client) => {
    const tenant = await client.query("SELECT tenant_id,name FROM tenants WHERE tenant_id=$1", [tenantId]);
    if (!tenant.rowCount) throw new HttpError(404, "Not Found", "Organization not found.");
    const pending = await client.query(
      `SELECT i.invite_id, i.email, i.user_id
         FROM tenant_invitations i
        WHERE i.tenant_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        ORDER BY i.created_at DESC LIMIT 1 FOR UPDATE`,
      [tenantId],
    );
    if (!pending.rowCount)
      throw new HttpError(409, "Invitation Unavailable", "There is no pending invitation to generate a link for.");
    const token = invitationToken();
    const expiresAt = new Date(Date.now() + invitationLifetimeHours() * 60 * 60 * 1000).toISOString();
    await client.query("UPDATE tenant_invitations SET revoked_at=now() WHERE invite_id=$1", [pending.rows[0].invite_id]);
    const inviteId = id();
    await client.query(
      `INSERT INTO tenant_invitations (invite_id,tenant_id,user_id,email,token_hash,expires_at,created_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [inviteId, tenantId, pending.rows[0].user_id, pending.rows[0].email, hashInvitationToken(token), expiresAt, now(), req.actor.platform_user_id || req.actor.user_id],
    );
    await auditPlatform(client, req, "tenant_invitation_link_generated", tenantId, "Platform administrator generated an invitation link", {
      email: pending.rows[0].email,
      invite_id: inviteId,
    });
    return { email: pending.rows[0].email, token, expiresAt, organizationName: tenant.rows[0].name };
  });
  return { invite_url: invitationUrl(req, created.token), expires_at: created.expiresAt, email: created.email };
};

export const listAccess = async (req) => {
  assertPlatform(req);
  const result = await pool.query(
    `SELECT p.platform_user_id, p.display_name, p.email, m.tenant_id, m.tenant_user_id, m.roles, m.status
       FROM platform_users p JOIN platform_memberships m ON m.platform_user_id=p.platform_user_id
      ORDER BY p.display_name, m.tenant_id`,
  );
  return result.rows;
};

export const listSettings = async (req) => {
  assertPlatform(req);
  const result = await pool.query(
    `SELECT t.tenant_id, t.name, t.timezone,
            COALESCE(s.status, 'active') AS status,
            COALESCE(s.settings, t.settings, '{}'::jsonb) AS settings
       FROM tenants t
       LEFT JOIN tenant_platform_state s ON s.tenant_id = t.tenant_id
      ORDER BY t.name ASC`,
  );
  return result.rows;
};

export const updateSettings = async (req) => {
  assertPlatform(req);
  const tenantId = req.body?.tenant_id;
  if (!tenantId)
    throw new HttpError(422, "Invalid Request", "tenant_id is required.");
  const patch = normalizeSettings(req.body?.settings);
  return withTransaction(async (client) => {
    const tenant = await client.query("SELECT tenant_id FROM tenants WHERE tenant_id=$1", [tenantId]);
    if (!tenant.rowCount) throw new HttpError(404, "Not Found", "Tenant not found.");
    const row = await client.query(
      `INSERT INTO tenant_platform_state (tenant_id, status, settings)
       VALUES ($1, 'active', $2::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE
       SET settings = tenant_platform_state.settings || EXCLUDED.settings
       RETURNING tenant_id, status, settings`,
      [tenantId, JSON.stringify(patch)],
    );
    await client.query(
      `INSERT INTO platform_audit_events
        (event_id, platform_user_id, action, target_type, target_id, occurred_at, reason, metadata)
       VALUES ($1,$2,'tenant_settings_updated','Tenant',$3,now(),$4,$5::jsonb)`,
      [id(), req.actor.platform_user_id, tenantId, req.body.reason || null, JSON.stringify(patch)],
    );
    return row.rows[0];
  });
};

export const listAudit = async (req) => {
  assertPlatform(req);
  const result = await pool.query(
    "SELECT event_id, platform_user_id, action, target_type, target_id, occurred_at, reason, metadata FROM platform_audit_events ORDER BY occurred_at DESC LIMIT 500",
  );
  return result.rows;
};

export const updateTenantStatus = async (req) => {
  assertPlatformWrite(req);
  const status = req.body?.status;
  if (!['active', 'suspended'].includes(status))
    throw new HttpError(422, "Invalid Status", "Tenant status must be active or suspended.");
  return withTransaction(async (client) => {
    const tenant = await client.query("SELECT tenant_id FROM tenants WHERE tenant_id=$1", [req.params.tenant_id]);
    if (!tenant.rowCount) throw new HttpError(404, "Not Found", "Tenant not found.");
    await client.query(
      "INSERT INTO tenant_platform_state (tenant_id,status,settings) VALUES ($1,$2,'{}') ON CONFLICT (tenant_id) DO UPDATE SET status=EXCLUDED.status",
      [req.params.tenant_id, status],
    );
    const row = await client.query(
      "INSERT INTO platform_audit_events (event_id,platform_user_id,action,target_type,target_id,occurred_at,reason,metadata) VALUES ($1,$2,$3,$4,$5,now(),$6,$7) RETURNING *",
      [id(), req.actor.platform_user_id, status === 'suspended' ? 'tenant_suspended' : 'tenant_reactivated', 'Tenant', req.params.tenant_id, req.body.reason || null, {}],
    );
    return row.rows[0];
  });
};
