import { HttpError } from "../views/problem-view.js";
import { verifySession, verifyCsrf } from "../services/auth-service.js";
import { effectiveCapabilities } from "../domain/role-capabilities.js";

export const requireAuth = async (req, _res, next) => {
  const external = process.env.AUTH_ADAPTER_MODULE;
  if (external) {
    try {
      const adapter = await import(external);
      req.actor = await adapter.authenticate(req);
      if (!req.actor?.user_id)
        throw new Error("Invalid actor context");
      return next();
    } catch (error) {
      return next(
        error.status
          ? error
          : new HttpError(
              401,
              "Unauthenticated",
              "The request could not be authenticated.",
            ),
      );
    }
  }
  if (!process.env.DATABASE_URL)
    return next(
      new HttpError(
        503,
        "Authentication Not Configured",
        "A database-backed authentication adapter is required.",
      ),
    );
  try {
    const { pool } = await import("../config/database.js");
    const token = req.signedCookies?.tlt_session || req.cookies?.tlt_session;
    if (!token)
      throw new HttpError(
        401,
        "Unauthenticated",
        "A valid session is required.",
      );
    req.session = verifySession(token);
    if (req.session.actor_kind === "platform") {
      const platformResult = await pool.query(
        `SELECT p.platform_user_id AS user_id, p.display_name, p.email, p.capabilities,
                p.status, m.tenant_id AS active_tenant_id, m.tenant_user_id,
                m.roles
           FROM platform_users p
           LEFT JOIN platform_memberships m
             ON m.platform_user_id = p.platform_user_id
            AND m.tenant_id = $2
            AND m.status = 'active'
          WHERE p.platform_user_id = $1`,
        [req.session.sub, req.session.active_tenant_id || null],
      );
      const platform = platformResult.rows[0];
      if (!platform || platform.status !== "active")
        throw new HttpError(401, "Unauthenticated", "The session user is unavailable.");
      let tenantActor = null;
      if (platform.active_tenant_id && platform.tenant_user_id) {
        const tenantResult = await pool.query(
          "SELECT employee_id, capabilities, status FROM users WHERE tenant_id = $1 AND user_id = $2",
          [platform.active_tenant_id, platform.tenant_user_id],
        );
        tenantActor = tenantResult.rows[0];
      }
      const capabilities = effectiveCapabilities([
        ...platform.capabilities,
        ...(tenantActor?.capabilities || []),
      ]);
      req.actor = {
        ...platform,
        tenant_id: platform.active_tenant_id || null,
        employee_id: tenantActor?.employee_id || null,
        user_id: platform.tenant_user_id || platform.user_id,
        capabilities,
        platform_capabilities: platform.capabilities,
        roles: platform.roles || ["Platform Administrator"],
        actor_kind: "platform",
        actor_role: "platform_admin",
        platform_user_id: platform.user_id,
      };
      return next();
    }
    const result = await pool.query(
      "SELECT user_id, tenant_id, employee_id, display_name, email, capabilities, status FROM users WHERE tenant_id = $1 AND user_id = $2",
      [req.session.tenant_id, req.session.sub],
    );
    const actor = result.rows[0];
    if (!actor || actor.status !== "active")
      throw new HttpError(
        401,
        "Unauthenticated",
        "The session user is unavailable.",
      );
    const capabilities = effectiveCapabilities(actor.capabilities);
    req.actor = {
      ...actor,
      capabilities,
      actor_kind: "tenant",
      roles: [
        "Employee",
        ...(capabilities.includes("leave:approve")
          ? ["Reporting Manager"]
          : []),
        ...(capabilities.includes("users:write") ? ["HR Manager"] : []),
      ],
      actor_role: capabilities.includes("users:write")
        ? "tenant_admin"
        : capabilities.includes("leave:approve")
          ? "manager"
          : "employee",
    };
    return next();
  } catch (error) {
    return next(
      error.status
        ? error
        : new HttpError(
            401,
            "Unauthenticated",
            "The session is invalid or expired.",
          ),
    );
  }
};

export const requireCsrf = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const cookie = req.cookies?.tlt_csrf;
  const header = req.get("x-csrf-token");
  if (
    !cookie ||
    !header ||
    cookie !== header ||
    !verifyCsrf(req.signedCookies?.tlt_csrf_signature, cookie)
  )
    return next(
      new HttpError(403, "Forbidden", "A valid CSRF token is required."),
    );
  next();
};
