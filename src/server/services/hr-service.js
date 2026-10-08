import crypto from "node:crypto";
import { withTransaction } from "../config/database.js";
import { hashPassword } from "./auth-service.js";
import { HttpError } from "../views/problem-view.js";

const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const now = () => new Date().toISOString();
const generatedEmployeeNumber = (tenantId, employeeId) => `${tenantId.toUpperCase()}-${employeeId.slice(-8).toUpperCase()}`;
const invitationToken = () => crypto.randomBytes(32).toString("base64url");
const invitationHash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const invitationUrl = (req, token) => {
  const base = (process.env.INVITATION_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return `${base}/#/accept-invitation?token=${encodeURIComponent(token)}`;
};
const passwordResetUrl = (req, token) => {
  const base = (process.env.INVITATION_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return `${base}/#/reset-password?token=${encodeURIComponent(token)}`;
};
const invitationExpiry = () => new Date(Date.now() + Math.min(Math.max(Number(process.env.INVITATION_TTL_HOURS || 72), 1), 720) * 60 * 60 * 1000).toISOString();

const roleCapabilities = {
  Employee: ["attendance:write", "attendance-adjustments:write", "leave:write", "leave-requests:write", "overtime-requests:write"],
  "Reporting Manager": ["attendance:approve", "leave:approve", "overtime-requests:write", "overtime:approve", "alerts:write"],
  "HR Manager": [
    "users:write", "departments:write", "job-profiles:write", "leave-types:write",
    "job-leave-policies:write", "leave-balances:write", "leave-ledger-entries:write",
    "leave-requests:write", "leave:approve", "attendance:approve", "attendance-adjustments:write", "attendance:override",
    "overtime-requests:write", "overtime:approve",
    "attachments:write", "alerts:write",
  ],
};

const assertString = (value, field, { nullable = false } = {}) => {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !value.trim())
    throw new HttpError(422, "Invalid Request", `${field} is required.`);
};

const assertManager = async (client, tenantId, employeeId, managerId) => {
  if (!managerId) return;
  if (employeeId === managerId)
    throw new HttpError(422, "Invalid Hierarchy", "An employee cannot manage itself.");
  const cycle = await client.query(
    `WITH RECURSIVE chain(employee_id, manager_id) AS (
       SELECT employee_id, manager_id FROM employees WHERE tenant_id=$1 AND employee_id=$2
       UNION ALL
       SELECT e.employee_id, e.manager_id FROM employees e JOIN chain c ON e.employee_id=c.manager_id
       WHERE e.tenant_id=$1
     ) SELECT 1 FROM chain WHERE employee_id=$3 LIMIT 1`,
    [tenantId, managerId, employeeId],
  );
  if (cycle.rowCount)
    throw new HttpError(422, "Invalid Hierarchy", "The manager assignment would create a reporting cycle.");
};

const audit = async (client, req, action, targetType, targetId, reason = null, metadata = {}) => {
  await client.query(
    `INSERT INTO audit_events (event_id,tenant_id,actor_user_id,actor_role,action,target_type,target_id,occurred_at,reason,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id("audit"), req.tenantId, req.actor.user_id, req.actor.actor_role || "hr_manager", action, targetType, targetId, now(), reason, metadata],
  );
};

const employeePayload = (body, tenantId, employeeId) => ({
  employee_id: employeeId,
  tenant_id: tenantId,
  employee_number: String(body.employee_number || "").trim(),
  name: String(body.name || "").trim(),
  job_id: body.job_id,
  manager_id: body.manager_id || null,
  department_id: body.department_id,
  location_id: body.location_id,
  holiday_calendar_id: body.holiday_calendar_id,
  work_schedule: body.work_schedule || {},
  start_date: body.start_date,
  status: body.status || "active",
});

const validateEmployee = (payload) => {
  for (const field of ["employee_number", "name", "job_id", "department_id", "location_id", "holiday_calendar_id", "start_date"])
    assertString(payload[field], field);
  if (!payload.manager_id && payload.manager_id !== null)
    throw new HttpError(422, "Invalid Request", "manager_id is required and may be null.");
  if (!payload.work_schedule || typeof payload.work_schedule !== "object")
    throw new HttpError(422, "Invalid Request", "work_schedule must be an object.");
  if (!["active", "inactive"].includes(payload.status))
    throw new HttpError(422, "Invalid Request", "status is invalid.");
};

const accountCapabilities = (roles = [], requested = []) => {
  const selected = Array.isArray(roles) && roles.length ? roles : ["Employee"];
  if (selected.some((role) => !roleCapabilities[role]))
    throw new HttpError(422, "Invalid Request", "One or more account roles are invalid.");
  const allowed = new Set(selected.flatMap((role) => roleCapabilities[role]));
  if (requested.length) {
    for (const capability of requested)
      if (!allowed.has(capability))
        throw new HttpError(403, "Forbidden", "Requested capabilities exceed the selected roles.");
    return [...new Set(requested)];
  }
  return [...allowed];
};

const createPortalAccount = async (client, tenantId, employee, account) => {
  assertString(account?.email, "account.email");
  const invite = account.invite === true;
  if (!invite) {
    assertString(account?.password, "account.password");
    if (account.password.length < 12)
      throw new HttpError(422, "Invalid Request", "Account password must be at least 12 characters.");
  }
  const email = account.email.trim();
  const duplicate = await client.query(
    `SELECT 1 FROM auth_credentials WHERE lower(email)=lower($1)
     UNION ALL SELECT 1 FROM platform_credentials WHERE lower(email)=lower($1)
     LIMIT 1`,
    [email],
  );
  if (duplicate.rowCount)
    throw new HttpError(409, "Duplicate Email", "This email is already assigned to an account.");
  if (invite) {
    const pendingEmail = await client.query(
      "SELECT 1 FROM user_invitations WHERE tenant_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL AND revoked_at IS NULL LIMIT 1",
      [tenantId, email],
    );
    if (pendingEmail.rowCount)
      throw new HttpError(409, "Invitation Pending", "A pending invitation already exists for this email.");
  }
  const existing = await client.query(
    "SELECT status FROM users WHERE tenant_id=$1 AND employee_id=$2 LIMIT 1",
    [tenantId, employee.employee_id],
  );
  if (existing.rows.some((row) => row.status === "active"))
    throw new HttpError(409, "Account Already Active", "This employee already has an active portal account.");
  if (existing.rowCount && invite)
    throw new HttpError(409, "Invitation Pending", "This employee already has a pending portal invitation.");
  const userId = account.user_id || id("user");
  const capabilities = accountCapabilities(account.roles, account.capabilities);
  const displayName = account.display_name || employee.name;
  await client.query(
    "INSERT INTO users (user_id,tenant_id,employee_id,display_name,email,capabilities,status) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [userId, tenantId, employee.employee_id, displayName, email, capabilities, invite ? "inactive" : "active"],
  );
  if (!invite) {
    await client.query(
      "INSERT INTO auth_credentials (user_id,tenant_id,email,password_hash) VALUES ($1,$2,$3,$4)",
      [userId, tenantId, email, await hashPassword(account.password)],
    );
    return { user_id: userId, display_name: displayName, email, roles: account.roles || ["Employee"], status: "active" };
  }
  const token = invitationToken();
  const expiresAt = invitationExpiry();
  const inviteId = id("invite");
  await client.query(
    `INSERT INTO user_invitations (invite_id,tenant_id,user_id,employee_id,email,token_hash,expires_at,created_at,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)`,
    [inviteId, tenantId, userId, employee.employee_id, email, invitationHash(token), expiresAt, account.created_by],
  );
  return { user_id: userId, display_name: displayName, email, roles: account.roles || ["Employee"], status: "inactive", invite_url: invitationUrl(account.request, token), invite_expires_at: expiresAt };
};

export const createDirectoryEntry = async (req) => withTransaction(async (client) => {
  const body = req.body || {};
  const employeeId = body.employee_id || id("employee");
  const employee = employeePayload({ ...body, employee_number: body.employee_number || generatedEmployeeNumber(req.tenantId, employeeId) }, req.tenantId, employeeId);
  validateEmployee(employee);
  await assertManager(client, req.tenantId, employee.employee_id, employee.manager_id);
  const duplicateNumber = await client.query("SELECT 1 FROM employees WHERE tenant_id=$1 AND employee_number=$2 LIMIT 1", [req.tenantId, employee.employee_number]);
  if (duplicateNumber.rowCount) throw new HttpError(409, "Duplicate Employee Number", "Employee number is already in use.");
  await client.query(
    `INSERT INTO employees (employee_id,tenant_id,employee_number,name,job_id,manager_id,department_id,location_id,holiday_calendar_id,work_schedule,start_date,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [employee.employee_id, req.tenantId, employee.employee_number, employee.name, employee.job_id, employee.manager_id, employee.department_id, employee.location_id, employee.holiday_calendar_id, employee.work_schedule, employee.start_date, employee.status],
  );
  const account = body.account?.enabled ? await createPortalAccount(client, req.tenantId, employee, { ...body.account, created_by: req.actor.user_id, request: req }) : null;
  await audit(client, req, "directory_create", "Employee", employee.employee_id, "HR directory entry created", { account_created: Boolean(account) });
  return { employee, account };
});

export const updateDirectoryEntry = async (req) => withTransaction(async (client) => {
  const current = await client.query("SELECT * FROM employees WHERE tenant_id=$1 AND employee_id=$2 FOR UPDATE", [req.tenantId, req.params.employee_id]);
  if (!current.rowCount) throw new HttpError(404, "Not Found", "Employee was not found.");
  const employee = employeePayload({ ...current.rows[0], ...req.body }, req.tenantId, req.params.employee_id);
  validateEmployee(employee);
  await assertManager(client, req.tenantId, employee.employee_id, employee.manager_id);
  const duplicateNumber = await client.query("SELECT 1 FROM employees WHERE tenant_id=$1 AND employee_number=$2 AND employee_id<>$3 LIMIT 1", [req.tenantId, employee.employee_number, employee.employee_id]);
  if (duplicateNumber.rowCount) throw new HttpError(409, "Duplicate Employee Number", "Employee number is already in use.");
  const result = await client.query(
    `UPDATE employees SET employee_number=$1,name=$2,job_id=$3,manager_id=$4,department_id=$5,location_id=$6,holiday_calendar_id=$7,work_schedule=$8,start_date=$9,status=$10 WHERE tenant_id=$11 AND employee_id=$12 RETURNING *`,
    [employee.employee_number, employee.name, employee.job_id, employee.manager_id, employee.department_id, employee.location_id, employee.holiday_calendar_id, employee.work_schedule, employee.start_date, employee.status, req.tenantId, employee.employee_id],
  );
  const account = req.body?.account?.enabled
    ? await createPortalAccount(client, req.tenantId, employee, { ...req.body.account, created_by: req.actor.user_id, request: req })
    : null;
  const directReports = await client.query("SELECT employee_id FROM employees WHERE tenant_id=$1 AND manager_id=$2 AND status='active' ORDER BY employee_id", [req.tenantId, employee.employee_id]);
  await audit(client, req, "directory_update", "Employee", employee.employee_id, "HR directory assignment updated", { manager_id: employee.manager_id, account_created: Boolean(account) });
  return { employee: result.rows[0], account, reporting_scope: { direct_report_ids: directReports.rows.map((row) => row.employee_id), direct_report_count: directReports.rowCount } };
});

export const resetPassword = async (req) => withTransaction(async (client) => {
  const result = await client.query(
    `SELECT u.user_id, u.email
       FROM users u
      WHERE u.tenant_id=$1 AND u.employee_id=$2 AND u.status='active'
      LIMIT 1`,
    [req.tenantId, req.params.employee_id],
  );
  if (!result.rowCount) throw new HttpError(404, "Not Found", "No active portal account exists for this employee.");
  const user = result.rows[0];
  const token = invitationToken();
  const expiresAt = invitationExpiry();
  await client.query(
    "UPDATE user_invitations SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
    [req.tenantId, user.user_id],
  );
  const inviteId = id("invite");
  await client.query(
    `INSERT INTO user_invitations (invite_id,tenant_id,user_id,employee_id,email,token_hash,expires_at,created_at,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)`,
    [inviteId, req.tenantId, user.user_id, req.params.employee_id, user.email, invitationHash(token), expiresAt, req.actor.user_id],
  );
  await audit(client, req, "password_reset_link_generated", "User", user.user_id, "Password reset invitation link generated", { invite_id: inviteId, expires_at: expiresAt });
  return { employee_id: req.params.employee_id, user_id: user.user_id, email: user.email, invite_url: passwordResetUrl(req, token), invite_expires_at: expiresAt };
});

export const generateDirectoryInvitationLink = async (req) => withTransaction(async (client) => {
  const result = await client.query(
    `SELECT u.user_id, u.email, u.status, e.name
       FROM users u JOIN employees e ON e.tenant_id=u.tenant_id AND e.employee_id=u.employee_id
      WHERE u.tenant_id=$1 AND u.employee_id=$2 FOR UPDATE`,
    [req.tenantId, req.params.employee_id],
  );
  if (!result.rowCount) throw new HttpError(404, "Not Found", "No portal user exists for this employee.");
  const user = result.rows[0];
  if (user.status === "active") throw new HttpError(409, "Account Already Active", "This employee already has an active portal account.");
  const token = invitationToken();
  const expiresAt = invitationExpiry();
  await client.query("UPDATE user_invitations SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL", [req.tenantId, user.user_id]);
  const inviteId = id("invite");
  await client.query(
    `INSERT INTO user_invitations (invite_id,tenant_id,user_id,employee_id,email,token_hash,expires_at,created_at,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)`,
    [inviteId, req.tenantId, user.user_id, req.params.employee_id, user.email, invitationHash(token), expiresAt, req.actor.user_id],
  );
  await audit(client, req, "user_invitation_link_generated", "User", user.user_id, "Portal invitation link generated", { invite_id: inviteId, expires_at: expiresAt });
  return { employee_id: req.params.employee_id, email: user.email, invite_url: invitationUrl(req, token), invite_expires_at: expiresAt };
});

export const getOwnJobProfile = async (req) => withTransaction(async (client) => {
  const result = await client.query(
    `SELECT j.job_id, j.title, j.standard_daily_mins, j.standard_weekly_mins, j.is_ot_eligible, j.max_daily_mins
       FROM employees e
       JOIN job_profiles j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id
      WHERE e.tenant_id=$1 AND e.employee_id=$2`,
    [req.tenantId, req.actor.employee_id],
  );
  if (!result.rowCount) throw new HttpError(404, "Not Found", "The employee job profile was not found.");
  return result.rows[0];
});

const localTimeMinutes = (value, field) => {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value))
    throw new HttpError(422, "Invalid Request", `${field} must use HH:MM format.`);
  const [hours, minutes] = value.split(":").map(Number);
  if (hours > 23 || minutes > 59)
    throw new HttpError(422, "Invalid Request", `${field} is not a valid time.`);
  return hours * 60 + minutes;
};

const refreshDailySummary = async (client, tenantId, employee, localDate) => {
  const totals = await client.query(
    `SELECT COALESCE(sum(floor(extract(epoch FROM (s.clock_out_at - s.clock_in_at)) / 60)), 0)::integer AS worked_mins,
            count(*)::integer AS closed_count
       FROM attendance_sessions s
       JOIN tenants t ON t.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.employee_id = $2 AND s.status = 'closed'
        AND (s.clock_in_at AT TIME ZONE t.timezone)::date = $3::date`,
    [tenantId, employee.employee_id, localDate],
  );
  const existing = await client.query(
    "SELECT summary_id FROM attendance_summaries WHERE tenant_id=$1 AND employee_id=$2 AND local_date=$3 FOR UPDATE",
    [tenantId, employee.employee_id, localDate],
  );
  if (!existing.rowCount && !Number(totals.rows[0].closed_count)) return null;
  const workedMins = Number(totals.rows[0].worked_mins);
  const scheduledMins = Number(employee.standard_daily_mins);
  const complete = workedMins >= scheduledMins;
  const values = [
    workedMins,
    scheduledMins,
    Math.max(0, workedMins - scheduledMins),
    complete ? "complete" : "below_standard",
    complete ? [] : ["SHORT_DAY"],
    employee.job_id,
    tenantId,
    employee.employee_id,
    localDate,
  ];
  if (existing.rowCount) {
    const result = await client.query(
      `UPDATE attendance_summaries
          SET worked_mins=$1, scheduled_mins=$2, overtime_mins=$3, status=$4, exception_codes=$5, effective_job_id=$6
        WHERE tenant_id=$7 AND employee_id=$8 AND local_date=$9 RETURNING *`,
      values,
    );
    return result.rows[0];
  }
  const result = await client.query(
    `INSERT INTO attendance_summaries
      (summary_id,tenant_id,employee_id,local_date,worked_mins,scheduled_mins,overtime_mins,status,exception_codes,effective_job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id("summary"), tenantId, employee.employee_id, localDate, ...values.slice(0, 6)],
  );
  return result.rows[0];
};

export const createAttendanceOverride = async (req) => withTransaction(async (client) => {
  const body = req.body || {};
  const employeeId = String(body.employee_id || "").trim();
  const localDate = String(body.local_date || "").trim();
  const clockInTime = String(body.clock_in_time || "").trim();
  const clockOutTime = body.clock_out_time ? String(body.clock_out_time).trim() : null;
  const reason = String(body.reason || "").trim();
  if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !reason)
    throw new HttpError(422, "Invalid Request", "employee_id, local_date, and reason are required.");
  const clockInMinutes = localTimeMinutes(clockInTime, "clock_in_time");
  const clockOutMinutes = clockOutTime === null ? null : localTimeMinutes(clockOutTime, "clock_out_time");
  if (clockOutMinutes !== null && clockOutMinutes <= clockInMinutes)
    throw new HttpError(422, "Invalid Request", "clock_out_time must be after clock_in_time.");
  const employeeResult = await client.query(
    `SELECT e.employee_id, e.job_id, j.standard_daily_mins, t.timezone
       FROM employees e
       JOIN job_profiles j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id
       JOIN tenants t ON t.tenant_id=e.tenant_id
      WHERE e.tenant_id=$1 AND e.employee_id=$2
      FOR SHARE`,
    [req.tenantId, employeeId],
  );
  if (!employeeResult.rowCount)
    throw new HttpError(404, "Not Found", "The employee was not found in this organization.");
  const employee = employeeResult.rows[0];
  const times = await client.query(
    `SELECT (($2::date + $3::time) AT TIME ZONE t.timezone) AS clock_in_at,
            CASE WHEN $4::time IS NULL THEN NULL ELSE (($2::date + $4::time) AT TIME ZONE t.timezone) END AS clock_out_at
       FROM tenants t WHERE t.tenant_id=$1`,
    [req.tenantId, localDate, clockInTime, clockOutTime],
  );
  const clockInAt = times.rows[0].clock_in_at;
  const clockOutAt = times.rows[0].clock_out_at;
  const overlap = await client.query(
    `SELECT session_id, clock_in_at, clock_out_at, source, status
       FROM attendance_sessions
      WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('open','closed')
        AND clock_in_at < COALESCE($4::timestamptz, 'infinity'::timestamptz)
        AND COALESCE(clock_out_at, 'infinity'::timestamptz) > $3::timestamptz
      FOR UPDATE`,
    [req.tenantId, employeeId, clockInAt, clockOutAt],
  );
  const replacedSessions = overlap.rows.map((row) => ({
    session_id: row.session_id,
    clock_in_at: row.clock_in_at,
    clock_out_at: row.clock_out_at,
    source: row.source,
    status: row.status,
  }));
  const replacedSessionIds = replacedSessions.map((row) => row.session_id);
  if (replacedSessionIds.length)
    await client.query(
      "UPDATE attendance_sessions SET status='voided', version=version+1 WHERE tenant_id=$1 AND session_id = ANY($2::text[])",
      [req.tenantId, replacedSessionIds],
    );
  const status = clockOutAt ? "closed" : "open";
  const sessionResult = await client.query(
    `INSERT INTO attendance_sessions (session_id,tenant_id,employee_id,clock_in_at,clock_out_at,source,status,version)
     VALUES ($1,$2,$3,$4,$5,'hr_bulk_override',$6,0) RETURNING *`,
    [id("session"), req.tenantId, employeeId, clockInAt, clockOutAt, status],
  );
  const summary = (clockOutAt || replacedSessionIds.length)
    ? await refreshDailySummary(client, req.tenantId, employee, localDate)
    : null;
  await audit(
    client,
    req,
    "attendance_manual_override",
    "AttendanceSession",
    sessionResult.rows[0].session_id,
    reason,
    { employee_id: employeeId, local_date: localDate, replaced_sessions: replacedSessions, replaced_session_ids: replacedSessionIds, new_values: { clock_in_time: clockInTime, clock_out_time: clockOutTime, source: "hr_bulk_override", status }, timezone: employee.timezone },
  );
  return { session: sessionResult.rows[0], summary, replaced_session_ids: replacedSessionIds };
});
