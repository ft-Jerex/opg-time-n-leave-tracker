import crypto from "node:crypto";
import { withTransaction } from "../config/database.js";
import { hashPassword } from "./auth-service.js";
import { HttpError } from "../views/problem-view.js";
import { roleCapabilities } from "../domain/role-capabilities.js";
import { partialLeaveCharge } from "../../shared/leave.js";
import { refreshAttendanceSummary } from "./attendance-summary-service.js";

export { roleCapabilities } from "../domain/role-capabilities.js";

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

export const accountCapabilities = (roles = [], requested = []) => {
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

export const accountRoles = (capabilities = []) => {
  if (capabilities.includes("users:write")) return ["HR Manager"];
  if (capabilities.includes("leave:approve")) return ["Reporting Manager"];
  return ["Employee"];
};

const sameCapabilities = (left, right) => {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((capability, index) => capability === sortedRight[index]);
};

const updatePortalAccountRoles = async (client, req, employee) => {
  const roles = req.body?.account?.roles;
  if (!Array.isArray(roles) || roles.length !== 1)
    throw new HttpError(422, "Invalid Request", "Exactly one portal role is required.");
  const capabilities = accountCapabilities(roles);

  // Consistent tenant-wide lock ordering prevents two concurrent demotions
  // from both concluding that another active HR Manager remains.
  const tenantAccounts = await client.query(
    `SELECT user_id,employee_id,capabilities,status
       FROM users
      WHERE tenant_id=$1
      ORDER BY user_id
      FOR UPDATE`,
    [req.tenantId],
  );
  const current = tenantAccounts.rows.find((row) => row.employee_id === employee.employee_id);
  if (!current)
    throw new HttpError(422, "Invalid Request", "Create a portal account before assigning a role.");

  const previousRoles = accountRoles(current.capabilities);
  if (sameCapabilities(current.capabilities, capabilities))
    return { user_id: current.user_id, roles, status: current.status, changed: false };

  const removesHrAccess = current.status === "active" &&
    current.capabilities.includes("users:write") &&
    !capabilities.includes("users:write");
  if (removesHrAccess) {
    const activeHrCount = tenantAccounts.rows.filter(
      (row) => row.status === "active" && row.capabilities.includes("users:write"),
    ).length;
    if (activeHrCount <= 1)
      throw new HttpError(409, "Last HR Manager", "Assign another active HR Manager before removing this role.");
  }

  await client.query(
    "UPDATE users SET capabilities=$1 WHERE tenant_id=$2 AND user_id=$3",
    [capabilities, req.tenantId, current.user_id],
  );
  await audit(client, req, "account_role_update", "User", current.user_id, "Portal account role updated", {
    employee_id: employee.employee_id,
    previous_roles: previousRoles,
    roles,
  });
  return { user_id: current.user_id, roles, status: current.status, changed: true };
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
    : req.body?.account?.roles !== undefined
      ? await updatePortalAccountRoles(client, req, employee)
      : null;
  const directReports = await client.query("SELECT employee_id FROM employees WHERE tenant_id=$1 AND manager_id=$2 AND status='active' ORDER BY employee_id", [req.tenantId, employee.employee_id]);
  await audit(client, req, "directory_update", "Employee", employee.employee_id, "HR directory assignment updated", {
    manager_id: employee.manager_id,
    account_created: Boolean(req.body?.account?.enabled && account),
    account_role_changed: Boolean(account?.changed),
  });
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

export const getOwnLeaveOptions = async (req) => withTransaction(async (client) => {
  const result = await client.query(
    `SELECT DISTINCT ON (p.leave_type_id)
            p.policy_id,
            p.leave_type_id,
            lt.name,
            lt.code,
            lt.unit,
            lt.is_paid,
            lt.color,
            lt.description,
            p.annual_allotment,
            p.accrual_rule,
            p.carry_over_limit,
            p.allow_negative,
            p.allow_partial_day,
            b.balance_id,
            b.period,
            COALESCE(b.accrued, 0) AS accrued,
            COALESCE(b.carried_over, 0) AS carried_over,
            COALESCE(b.manual_adjustments, 0) AS manual_adjustments,
            COALESCE(b.used, 0) AS used,
            COALESCE(b.pending, 0) AS pending,
            COALESCE(b.remaining, 0) AS remaining,
            COALESCE(b.remaining, 0) - COALESCE(b.pending, 0) AS available,
            b.as_of
       FROM employees e
       JOIN tenants t
         ON t.tenant_id = e.tenant_id
       JOIN job_leave_policies p
         ON p.tenant_id = e.tenant_id
        AND p.job_id = e.job_id
       JOIN leave_types lt
         ON lt.tenant_id = p.tenant_id
        AND lt.leave_type_id = p.leave_type_id
       LEFT JOIN LATERAL (
         SELECT lb.*
           FROM leave_balances lb
          WHERE lb.tenant_id = e.tenant_id
            AND lb.employee_id = e.employee_id
            AND lb.leave_type_id = p.leave_type_id
          ORDER BY lb.as_of DESC, lb.balance_id DESC
          LIMIT 1
       ) b ON true
      WHERE e.tenant_id = $1
        AND e.employee_id = $2
        AND e.status = 'active'
        AND p.status = 'active'
        AND lt.status = 'active'
        AND p.effective_from <= (CURRENT_TIMESTAMP AT TIME ZONE t.timezone)::date
        AND (p.effective_to IS NULL OR p.effective_to >= (CURRENT_TIMESTAMP AT TIME ZONE t.timezone)::date)
      ORDER BY p.leave_type_id, p.effective_from DESC, p.policy_id`,
    [req.tenantId, req.actor.employee_id],
  );
  return result.rows;
});

const localTimeMinutes = (value, field) => {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value))
    throw new HttpError(422, "Invalid Request", `${field} must use HH:MM format.`);
  const [hours, minutes] = value.split(":").map(Number);
  if (hours > 23 || minutes > 59)
    throw new HttpError(422, "Invalid Request", `${field} is not a valid time.`);
  return hours * 60 + minutes;
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
    ? await refreshAttendanceSummary(client, req.tenantId, employee.employee_id, localDate)
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

export const createLeaveOverride = async (req) => withTransaction(async (client) => {
  const body = req.body || {};
  const employeeId = String(body.employee_id || "").trim();
  const leaveTypeId = String(body.leave_type_id || "").trim();
  const startDate = String(body.start_date || "").trim();
  const endDate = String(body.end_date || "").trim();
  const duration = String(body.duration || "full_day");
  const startTime = body.start_time ? String(body.start_time).trim() : null;
  const endTime = body.end_time ? String(body.end_time).trim() : null;
  const reason = String(body.reason || "").trim();
  const validDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!employeeId || !leaveTypeId || !validDate.test(startDate) || !validDate.test(endDate) || !reason)
    throw new HttpError(422, "Invalid Request", "employee_id, leave_type_id, dates, and reason are required.");
  if (endDate < startDate)
    throw new HttpError(422, "Invalid Request", "end_date must be on or after start_date.");
  if (!new Set(["full_day", "custom_hours"]).has(duration))
    throw new HttpError(422, "Invalid Request", "duration must be full_day or custom_hours.");

  let partialMinutes = null;
  if (duration === "custom_hours") {
    if (startDate !== endDate)
      throw new HttpError(422, "Invalid Request", "Hourly leave must use one date.");
    const startMinutes = localTimeMinutes(startTime, "start_time");
    const endMinutes = localTimeMinutes(endTime, "end_time");
    if (endMinutes <= startMinutes)
      throw new HttpError(422, "Invalid Request", "end_time must be after start_time.");
    partialMinutes = endMinutes - startMinutes;
  }

  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `leave:${req.tenantId}:${employeeId}`,
  ]);
  const policyResult = await client.query(
    `SELECT e.employee_id, e.name, p.allow_negative, p.allow_partial_day,
            lt.unit AS leave_unit
       FROM employees e
       JOIN job_leave_policies p
         ON p.tenant_id=e.tenant_id AND p.job_id=e.job_id
       JOIN leave_types lt
         ON lt.tenant_id=p.tenant_id AND lt.leave_type_id=p.leave_type_id
      WHERE e.tenant_id=$1 AND e.employee_id=$2 AND e.status='active'
        AND p.leave_type_id=$3 AND p.status='active' AND lt.status='active'
        AND p.effective_from <= $4::date
        AND (p.effective_to IS NULL OR p.effective_to >= $5::date)
      ORDER BY p.effective_from DESC
      LIMIT 1`,
    [req.tenantId, employeeId, leaveTypeId, startDate, endDate],
  );
  if (!policyResult.rowCount)
    throw new HttpError(422, "Ineligible Leave", "No active leave policy covers this employee and period.");
  const policy = policyResult.rows[0];
  if (duration === "custom_hours" && !policy.allow_partial_day)
    throw new HttpError(422, "Ineligible Leave", "This leave policy does not allow hourly leave.");

  let amount;
  if (duration === "custom_hours") {
    amount = partialLeaveCharge(partialMinutes, policy.leave_unit);
  } else {
    const charge = await client.query(
      `SELECT count(*)::numeric AS days
         FROM generate_series($1::date,$2::date,'1 day') day
        WHERE extract(isodow FROM day) BETWEEN 1 AND 5
          AND NOT EXISTS (
            SELECT 1
              FROM holidays h
              JOIN employees e
                ON e.tenant_id=h.tenant_id
               AND e.holiday_calendar_id=h.holiday_calendar_id
             WHERE e.tenant_id=$3 AND e.employee_id=$4
               AND h.status='active' AND h.local_date=day::date
          )`,
      [startDate, endDate, req.tenantId, employeeId],
    );
    amount = Number(charge.rows[0].days);
  }
  if (amount <= 0)
    throw new HttpError(422, "Invalid Leave Period", "The selected period has no chargeable working time.");

  const overlap = await client.query(
    `SELECT 1 FROM leave_requests
      WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('pending','approved')
        AND start_date <= $4::date AND end_date >= $3::date
      LIMIT 1`,
    [req.tenantId, employeeId, startDate, endDate],
  );
  if (overlap.rowCount)
    throw new HttpError(409, "Overlapping Leave", "The period overlaps pending or approved leave.");

  const balanceResult = await client.query(
    `SELECT * FROM leave_balances
      WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3
      ORDER BY as_of DESC, balance_id DESC
      LIMIT 1 FOR UPDATE`,
    [req.tenantId, employeeId, leaveTypeId],
  );
  if (!balanceResult.rowCount)
    throw new HttpError(422, "Missing Balance", "No leave balance exists for this employee and leave type.");
  const balance = balanceResult.rows[0];
  const available = Number(balance.remaining) - Number(balance.pending);
  if (!policy.allow_negative && available < amount)
    throw new HttpError(422, "Insufficient Leave Balance", "The override exceeds the balance available after pending requests.");

  const requestId = id("leave");
  const occurredAt = now();
  const requestResult = await client.query(
    `INSERT INTO leave_requests
      (request_id,tenant_id,employee_id,leave_type_id,start_date,end_date,
       partial_day,partial_start_time,partial_end_time,partial_minutes,
       chargeable_amount,reason,attachment_ids,status,approver_id,submitted_at,
       decided_at,decision_note,version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,ARRAY[]::text[],
             'approved',$13,$14,$14,'HR leave override',1)
     RETURNING *`,
    [
      requestId,
      req.tenantId,
      employeeId,
      leaveTypeId,
      startDate,
      endDate,
      duration === "custom_hours" ? "custom_hours" : "none",
      duration === "custom_hours" ? startTime : null,
      duration === "custom_hours" ? endTime : null,
      partialMinutes,
      amount,
      reason,
      req.actor.employee_id,
      occurredAt,
    ],
  );
  const ledgerResult = await client.query(
    `INSERT INTO leave_ledger_entries
      (entry_id,tenant_id,employee_id,leave_type_id,effective_date,amount,
       entry_type,source_id,reason,created_by,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'usage',$7,$8,$9,$10)
     RETURNING *`,
    [id("ledger"), req.tenantId, employeeId, leaveTypeId, startDate, -amount, requestId, reason, req.actor.user_id, occurredAt],
  );
  const updatedBalance = await client.query(
    `UPDATE leave_balances
        SET used=used+$1, remaining=remaining-$1, as_of=$2
      WHERE tenant_id=$3 AND balance_id=$4
      RETURNING *`,
    [amount, startDate, req.tenantId, balance.balance_id],
  );
  await audit(
    client,
    req,
    "leave_manual_override",
    "LeaveRequest",
    requestId,
    reason,
    { employee_id: employeeId, employee_name: policy.name, leave_type_id: leaveTypeId, chargeable_amount: amount, duration },
  );
  return {
    request: requestResult.rows[0],
    ledger_entry: ledgerResult.rows[0],
    balance: updatedBalance.rows[0],
  };
});
