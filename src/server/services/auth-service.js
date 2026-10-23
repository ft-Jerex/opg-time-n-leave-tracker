import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { effectiveCapabilities } from "../domain/role-capabilities.js";
import { HttpError } from "../views/problem-view.js";

const withTransaction = async (fn) => {
  const database = await import("../config/database.js");
  return database.withTransaction(fn);
};

const secret = () => {
  if (!process.env.JWT_SECRET && process.env.NODE_ENV === "production")
    throw new Error("JWT_SECRET is required in production.");
  return process.env.JWT_SECRET || "development-only-jwt-secret-change-me";
};
const csrfSecret = () => process.env.CSRF_SECRET || secret();

export const hashPassword = (password) =>
  bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS || 12));
export const verifyPassword = (password, hash) =>
  bcrypt.compare(password, hash);

export const changePassword = async (actor, currentPassword, newPassword) => {
  if (typeof currentPassword !== "string" || !currentPassword)
    throw new HttpError(422, "Invalid Password", "The current password is required.");
  if (typeof newPassword !== "string" || newPassword.length < 12)
    throw new HttpError(422, "Invalid Password", "The new password must be at least 12 characters.");
  return withTransaction(async (client) => {
    const isPlatform = actor.actor_kind === "platform";
    const actorId = isPlatform ? actor.platform_user_id || actor.user_id : actor.user_id;
    const credentials = await client.query(
      isPlatform
        ? "SELECT password_hash FROM platform_credentials WHERE platform_user_id=$1 FOR UPDATE"
        : "SELECT password_hash FROM auth_credentials WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
      isPlatform ? [actorId] : [actor.tenant_id, actorId],
    );
    if (!credentials.rowCount)
      throw new HttpError(409, "Credentials Unavailable", "Password credentials are unavailable for this account.");
    const passwordHash = credentials.rows[0].password_hash;
    if (!(await verifyPassword(currentPassword, passwordHash)))
      throw new HttpError(422, "Invalid Password", "The current password is incorrect.");
    if (await verifyPassword(newPassword, passwordHash))
      throw new HttpError(422, "Invalid Password", "The new password must be different from the current password.");
    const nextHash = await hashPassword(newPassword);
    await client.query(
      isPlatform
        ? "UPDATE platform_credentials SET password_hash=$1,updated_at=now() WHERE platform_user_id=$2"
        : "UPDATE auth_credentials SET password_hash=$1,updated_at=now() WHERE tenant_id=$2 AND user_id=$3",
      isPlatform ? [nextHash, actorId] : [nextHash, actor.tenant_id, actorId],
    );
    if (isPlatform) {
      await client.query(
        `INSERT INTO platform_audit_events
          (event_id,platform_user_id,action,target_type,target_id,occurred_at,reason,metadata)
         VALUES ($1,$2,'password_changed','PlatformUser',$2,now(),'User changed their password',$3::jsonb)`,
        [crypto.randomUUID(), actorId, JSON.stringify({ source: "profile" })],
      );
    } else {
      await client.query(
        `INSERT INTO audit_events
          (event_id,tenant_id,actor_user_id,actor_role,action,target_type,target_id,occurred_at,reason,metadata)
         VALUES ($1,$2,$3,$4,'password_changed','User',$3,now(),'User changed their password',$5::jsonb)`,
        [crypto.randomUUID(), actor.tenant_id, actorId, actor.actor_role || "employee", JSON.stringify({ source: "profile" })],
      );
    }
  });
};
export const issueSession = (actor) =>
  jwt.sign(
    {
      sub: actor.user_id,
      tenant_id: actor.active_tenant_id ?? actor.tenant_id ?? null,
      active_tenant_id: actor.active_tenant_id ?? actor.tenant_id ?? null,
      actor_kind: actor.actor_kind || "tenant",
    },
    secret(),
    {
    expiresIn: process.env.JWT_EXPIRES_IN || "8h",
    issuer: "time-leave-tracker",
    },
  );
export const verifySession = (token) =>
  jwt.verify(token, secret(), { issuer: "time-leave-tracker" });
export const issueCsrf = () => crypto.randomBytes(32).toString("hex");
export const signCsrf = (value) =>
  jwt.sign({ csrf: value }, csrfSecret(), { expiresIn: "8h" });
export const verifyCsrf = (token, value) => {
  try {
    return jwt.verify(token, csrfSecret()).csrf === value;
  } catch {
    return false;
  }
};

const invitationHash = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

export const acceptInvitation = async (token, password) => {
  if (typeof token !== "string" || token.length < 32)
    throw new HttpError(422, "Invalid Invitation", "The invitation token is invalid.");
  if (typeof password !== "string" || password.length < 12)
    throw new HttpError(422, "Invalid Password", "The password must be at least 12 characters.");
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT i.invite_id, i.tenant_id, i.email, i.expires_at, i.accepted_at, i.revoked_at,
              u.user_id, u.employee_id, u.status AS user_status, 'tenant' AS invitation_kind
         FROM tenant_invitations i
         JOIN users u ON u.tenant_id=i.tenant_id AND u.user_id=i.user_id
        WHERE i.token_hash=$1
       UNION ALL
       SELECT i.invite_id, i.tenant_id, i.email, i.expires_at, i.accepted_at, i.revoked_at,
              u.user_id, u.employee_id, u.status AS user_status, 'user' AS invitation_kind
         FROM user_invitations i
         JOIN users u ON u.tenant_id=i.tenant_id AND u.user_id=i.user_id
        WHERE i.token_hash=$1`,
      [invitationHash(token)],
    );
    const invitation = result.rows[0];
    if (!invitation)
      throw new HttpError(400, "Invalid Invitation", "The invitation link is invalid or has expired.");
    if (invitation.accepted_at || invitation.revoked_at || new Date(invitation.expires_at).getTime() <= Date.now())
      throw new HttpError(400, "Invalid Invitation", "The invitation link is invalid or has expired.");
    const passwordHash = await hashPassword(password);
    const isPasswordReset = invitation.user_status === "active";
    if (isPasswordReset) {
      const updated = await client.query(
        "UPDATE auth_credentials SET email=$1,password_hash=$2,updated_at=now() WHERE tenant_id=$3 AND user_id=$4",
        [invitation.email, passwordHash, invitation.tenant_id, invitation.user_id],
      );
      if (!updated.rowCount) {
        await client.query(
          "INSERT INTO auth_credentials (user_id,tenant_id,email,password_hash) VALUES ($1,$2,$3,$4)",
          [invitation.user_id, invitation.tenant_id, invitation.email, passwordHash],
        );
      }
    } else {
      try {
        await client.query(
          "INSERT INTO auth_credentials (user_id,tenant_id,email,password_hash) VALUES ($1,$2,$3,$4)",
          [invitation.user_id, invitation.tenant_id, invitation.email, passwordHash],
        );
      } catch (error) {
        if (error.code === "23505")
          throw new HttpError(409, "Account Already Active", "This invitation can no longer be accepted.");
        throw error;
      }
    }
    await client.query(
      "UPDATE users SET status='active' WHERE tenant_id=$1 AND user_id=$2",
      [invitation.tenant_id, invitation.user_id],
    );
    await client.query(
      "UPDATE employees SET status='active' WHERE tenant_id=$1 AND employee_id=$2",
      [invitation.tenant_id, invitation.employee_id],
    );
    await client.query(
      `UPDATE ${invitation.invitation_kind === "user" ? "user_invitations" : "tenant_invitations"} SET accepted_at=now() WHERE invite_id=$1`,
      [invitation.invite_id],
    );
    await client.query(
      `INSERT INTO audit_events
        (event_id,tenant_id,actor_user_id,actor_role,action,target_type,target_id,occurred_at,reason,metadata)
       VALUES ($1,$2,$3,$4,$5,'User',$3,now(),$6,$7::jsonb)`,
      [
        crypto.randomUUID(),
        invitation.tenant_id,
        invitation.user_id,
        invitation.invitation_kind === "user" ? "employee" : "tenant_admin",
        isPasswordReset ? "password_reset_accepted" : "invitation_accepted",
        isPasswordReset
          ? "Password reset invitation accepted"
          : invitation.invitation_kind === "user"
            ? "Portal user invitation accepted"
            : "Initial HR administrator invitation accepted",
        JSON.stringify({ invite_id: invitation.invite_id }),
      ],
    );
    return { email: invitation.email };
  });
};

export const authenticate = async (client, email, password) => {
  const result = await client.query(
    `SELECT u.user_id, u.tenant_id, u.employee_id, u.display_name, u.email, u.capabilities, u.status, c.password_hash FROM users u JOIN auth_credentials c ON c.user_id = u.user_id AND c.tenant_id = u.tenant_id WHERE lower(u.email) = lower($1) LIMIT 1`,
    [email],
  );
  const record = result.rows[0];
  const platformResult = await client.query(
    `SELECT p.platform_user_id AS user_id, p.display_name, p.email, p.capabilities,
            p.status, c.password_hash,
            COALESCE(json_agg(json_build_object(
              'tenant_id', m.tenant_id,
              'tenant_user_id', m.tenant_user_id,
              'roles', m.roles,
              'status', m.status
            ) ORDER BY m.tenant_id) FILTER (WHERE m.tenant_id IS NOT NULL), '[]') AS memberships
       FROM platform_users p
       JOIN platform_credentials c ON c.platform_user_id = p.platform_user_id
       LEFT JOIN platform_memberships m ON m.platform_user_id = p.platform_user_id
      WHERE lower(p.email) = lower($1)
      GROUP BY p.platform_user_id, p.display_name, p.email, p.capabilities, p.status, c.password_hash
      LIMIT 1`,
    [email],
  );
  const platform = platformResult.rows[0];
  const valid = await verifyPassword(
    password || "",
    record?.password_hash || platform?.password_hash ||
      "$2b$12$a6ITSX1l6hICIPCpWD.O1.0nJHM0zQc76LU0RzM424ml6nIx6RGTS",
  );
  if (platform && valid && platform.status === "active") {
    const { password_hash: _hash, memberships, ...actor } = platform;
    return {
      ...actor,
      actor_kind: "platform",
      tenant_id: null,
      active_tenant_id: null,
      roles: ["Platform Administrator"],
      memberships,
    };
  }
  if (!record || !valid || record.status !== "active")
    throw new HttpError(
      401,
      "Unauthenticated",
      "Email or password is incorrect.",
    );
  const { password_hash: _hash, ...actor } = record;
  actor.capabilities = effectiveCapabilities(actor.capabilities);
  return {
    ...actor,
    actor_kind: "tenant",
    roles: [
      "Employee",
      ...(actor.capabilities.includes("leave:approve")
        ? ["Reporting Manager"]
        : []),
      ...(actor.capabilities.includes("users:write") ? ["HR Manager"] : []),
    ],
    memberships: [
      {
        tenant_id: actor.tenant_id,
        tenant_user_id: actor.user_id,
        employee_id: actor.employee_id,
        roles: [
          "Employee",
          ...(actor.capabilities.includes("leave:approve")
            ? ["Reporting Manager"]
            : []),
          ...(actor.capabilities.includes("users:write") ? ["HR Manager"] : []),
        ],
        status: actor.status,
      },
    ],
    active_tenant_id: actor.tenant_id,
  };
};
