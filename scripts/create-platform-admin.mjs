import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.PLATFORM_ADMIN_PASSWORD;
const displayName = process.env.PLATFORM_ADMIN_DISPLAY_NAME?.trim();
const platformUserId = process.env.PLATFORM_ADMIN_ID?.trim() || crypto.randomUUID();

if (!email || !/^\S+@\S+\.\S+$/.test(email))
  throw new Error("PLATFORM_ADMIN_EMAIL must be a valid email address.");
if (!displayName)
  throw new Error("PLATFORM_ADMIN_DISPLAY_NAME is required.");
if (typeof password !== "string" || password.length < 12)
  throw new Error("PLATFORM_ADMIN_PASSWORD must be at least 12 characters.");

if (process.env.MIGRATION_DATABASE_URL)
  process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL or MIGRATION_DATABASE_URL is required.");

const { closePool, withTransaction } = await import("../src/server/config/database.js");

try {
  const memberships = await withTransaction(async (client) => {
    const existingPlatformAdmin = await client.query(
      "SELECT platform_user_id,email FROM platform_users LIMIT 1 FOR UPDATE",
    );
    if (existingPlatformAdmin.rowCount)
      throw new Error(
        `A platform administrator already exists (${existingPlatformAdmin.rows[0].email}). Use the in-app password change flow instead.`,
      );

    const emailInUse = await client.query(
      `SELECT 1 FROM users WHERE lower(email)=lower($1)
       UNION ALL
       SELECT 1 FROM auth_credentials WHERE lower(email)=lower($1)
       LIMIT 1`,
      [email],
    );
    if (emailInUse.rowCount)
      throw new Error("PLATFORM_ADMIN_EMAIL is already used by a tenant account.");

    const tenantCount = await client.query("SELECT count(*)::integer AS count FROM tenants");
    const eligibleTenantCount = await client.query(
      `SELECT count(*)::integer AS count
         FROM tenants t
        WHERE EXISTS (
          SELECT 1 FROM users u
           WHERE u.tenant_id=t.tenant_id
             AND 'users:write'=ANY(u.capabilities)
        )`,
    );
    if (tenantCount.rows[0].count !== eligibleTenantCount.rows[0].count)
      throw new Error("Every existing tenant must have an HR Manager before creating the platform administrator.");

    await client.query(
      `INSERT INTO platform_users
        (platform_user_id,display_name,email,capabilities,status)
       VALUES ($1,$2,$3,$4,'active')`,
      [
        platformUserId,
        displayName,
        email,
        ["platform:read", "platform:write", "organizations:write", "access:write", "platform-audit:read"],
      ],
    );
    await client.query(
      `INSERT INTO platform_credentials
        (platform_user_id,email,password_hash)
       VALUES ($1,$2,$3)`,
      [
        platformUserId,
        email,
        await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS || 12)),
      ],
    );
    const access = await client.query(
      `INSERT INTO platform_memberships
        (platform_user_id,tenant_id,tenant_user_id,roles,status)
       SELECT $1,t.tenant_id,tenant_admin.user_id,
              ARRAY['Platform Administrator','HR Manager'],'active'
         FROM tenants t
        CROSS JOIN LATERAL (
          SELECT u.user_id
            FROM users u
           WHERE u.tenant_id=t.tenant_id
             AND 'users:write'=ANY(u.capabilities)
           ORDER BY (u.status='active') DESC,u.user_id
           LIMIT 1
        ) tenant_admin`,
      [platformUserId],
    );
    return access.rowCount;
  });
  console.log(`Created platform administrator ${email} with access to ${memberships} tenant(s).`);
} finally {
  await closePool();
}
