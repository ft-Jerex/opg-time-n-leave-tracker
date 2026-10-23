import { pool } from "../config/database.js";
import {
  authenticate,
  acceptInvitation as acceptInvitationService,
  changePassword as changePasswordService,
  issueSession,
  issueCsrf,
  signCsrf,
} from "../services/auth-service.js";
import { HttpError } from "../views/problem-view.js";
import { clearLoginRateLimit } from "../middleware/login-rate-limit.js";
import { registerTenant } from "../services/registration-service.js";
import { effectiveCapabilities } from "../domain/role-capabilities.js";

const maxAge = () =>
  Number(process.env.COOKIE_MAX_AGE_MS || 8 * 60 * 60 * 1000);
const cookieOptions = () => ({
  httpOnly: true,
  sameSite: process.env.COOKIE_SAME_SITE || "lax",
  secure: process.env.COOKIE_SECURE === "true",
  maxAge: maxAge(),
  path: "/",
});
const csrfOptions = () => ({
  httpOnly: false,
  sameSite: process.env.COOKIE_SAME_SITE || "lax",
  secure: process.env.COOKIE_SECURE === "true",
  maxAge: maxAge(),
  path: "/",
});

const setAuthCookies = (res, actor) => {
  const csrf = issueCsrf();
  res.cookie("tlt_session", issueSession(actor), cookieOptions());
  res.cookie("tlt_csrf", csrf, csrfOptions());
  res.cookie("tlt_csrf_signature", signCsrf(csrf), {
    ...cookieOptions(),
    httpOnly: true,
    signed: true,
  });
  return csrf;
};

const authPayload = (actor, csrf) => ({
  user_id: actor.user_id,
  tenant_id: actor.tenant_id,
  employee_id: actor.employee_id,
  display_name: actor.display_name,
  email: actor.email,
  capabilities: actor.capabilities,
  actor_kind: actor.actor_kind,
  roles: actor.roles,
  memberships: actor.memberships,
  active_tenant_id: actor.active_tenant_id,
  status: actor.status,
  csrf_token: csrf,
});

export const login = async (req, res) => {
  if (
    typeof req.body?.email !== "string" ||
    typeof req.body?.password !== "string"
  )
    throw new HttpError(
      422,
      "Invalid Request",
      "Email and password are required.",
    );
  const actor = await authenticate(
    pool,
    req.body.email.trim(),
    req.body.password,
  );
  clearLoginRateLimit(req);
  return authPayload(actor, setAuthCookies(res, actor));
};

export const register = async (req, res) => {
  const created = await registerTenant(req.body || {});
  const actor = await authenticate(pool, created.email, req.body.admin.password);
  return authPayload(actor, setAuthCookies(res, actor));
};

export const acceptInvitation = async (req, res) => {
  if (typeof req.body?.token !== "string" || typeof req.body?.password !== "string")
    throw new HttpError(422, "Invalid Request", "Invitation token and password are required.");
  const accepted = await acceptInvitationService(req.body.token, req.body.password);
  const actor = await authenticate(pool, accepted.email, req.body.password);
  return authPayload(actor, setAuthCookies(res, actor));
};

export const changePassword = async (req) => {
  await changePasswordService(
    req.actor,
    req.body?.current_password,
    req.body?.new_password,
  );
};

export const me = async (req) => {
  if (req.actor.actor_kind === "platform") {
    const result = await pool.query(
      `SELECT p.platform_user_id AS user_id, p.display_name, p.email, p.capabilities,
              p.status, COALESCE(json_agg(json_build_object(
                'tenant_id', m.tenant_id,
                'tenant_user_id', m.tenant_user_id,
                'roles', m.roles,
                'status', m.status
              ) ORDER BY m.tenant_id) FILTER (WHERE m.tenant_id IS NOT NULL), '[]') AS memberships
         FROM platform_users p
         LEFT JOIN platform_memberships m ON m.platform_user_id = p.platform_user_id
        WHERE p.platform_user_id = $1
        GROUP BY p.platform_user_id, p.display_name, p.email, p.capabilities, p.status`,
      [req.actor.platform_user_id || req.actor.user_id],
    );
    if (!result.rowCount || result.rows[0].status !== "active")
      throw new HttpError(401, "Unauthenticated", "The session user no longer exists.");
    return {
      ...result.rows[0],
      actor_kind: "platform",
      roles: ["Platform Administrator"],
      active_tenant_id: req.actor.tenant_id,
      tenant_id: req.actor.tenant_id,
      employee_id: req.actor.employee_id,
      csrf_token: req.cookies?.tlt_csrf || null,
    };
  }
  const result = await pool.query(
    "SELECT user_id, tenant_id, employee_id, display_name, email, capabilities, status FROM users WHERE tenant_id = $1 AND user_id = $2",
    [req.actor.tenant_id, req.actor.user_id],
  );
  if (!result.rowCount)
    throw new HttpError(
      401,
      "Unauthenticated",
      "The session user no longer exists.",
    );
  return {
    ...result.rows[0],
    capabilities: effectiveCapabilities(result.rows[0].capabilities),
    actor_kind: req.actor.actor_kind,
    roles: req.actor.roles,
    memberships: req.actor.memberships,
    active_tenant_id: req.actor.tenant_id,
    csrf_token: req.cookies?.tlt_csrf || null,
  };
};

export const context = async (req, res) => {
  if (req.actor.actor_kind !== "platform")
    throw new HttpError(403, "Forbidden", "Only platform administrators can change tenant context.");
  const tenantId = req.body?.tenant_id ?? null;
  const result = await pool.query(
    `SELECT m.tenant_id, m.tenant_user_id, m.roles, m.status,
            u.employee_id, u.display_name, u.email, u.capabilities
       FROM platform_memberships m
       LEFT JOIN users u ON u.tenant_id = m.tenant_id AND u.user_id = m.tenant_user_id
      WHERE m.platform_user_id = $1 AND ($2::text IS NULL OR m.tenant_id = $2)
        AND m.status = 'active' AND (m.tenant_user_id IS NULL OR u.user_id IS NOT NULL)`,
    [req.actor.platform_user_id || req.actor.user_id, tenantId],
  );
  if (tenantId !== null && !result.rowCount)
    throw new HttpError(403, "Forbidden", "The platform administrator is not assigned to that tenant.");
  // A null tenant_id means the platform administrator is exiting the active
  // organization. Keep the membership list for the platform overview, but do
  // not select the first membership as a new active tenant.
  const membership = tenantId === null ? null : result.rows[0] || null;
  const actor = {
    user_id: req.actor.platform_user_id || req.actor.user_id,
    tenant_id: membership?.tenant_id || null,
    active_tenant_id: membership?.tenant_id || null,
    actor_kind: "platform",
    display_name: membership?.display_name || req.actor.display_name,
    email: membership?.email || req.actor.email,
    employee_id: membership?.employee_id || null,
    capabilities: effectiveCapabilities(membership?.capabilities || req.actor.capabilities),
  };
  res.cookie("tlt_session", issueSession(actor), cookieOptions());
  return {
    ...actor,
    roles: membership?.roles || ["Platform Administrator"],
    memberships: result.rows,
    csrf_token: req.cookies?.tlt_csrf || null,
  };
};

export const logout = async (_req, res) => {
  res.clearCookie("tlt_session", { path: "/" });
  res.clearCookie("tlt_csrf", { path: "/" });
  res.clearCookie("tlt_csrf_signature", { path: "/" });
  return null;
};
