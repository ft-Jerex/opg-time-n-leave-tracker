# Deployment

## Topology

- Vercel serves the Vite build from `dist` and invokes Express through `api/index.js`.
- Supabase supplies PostgreSQL. The browser never uses Supabase Auth, Storage, or the Data API.
- Local Docker remains the development and integration-test database.
- Preview uses a staging Supabase project; Production uses a separate production project.

## Supabase setup

1. Create separate staging and production Supabase projects.
2. Enable SSL enforcement and restrict database network access where practical.
3. Copy the Shared Pooler transaction URL to the runtime `DATABASE_URL`.
4. Copy a direct or session-pooler URL to the protected `MIGRATION_DATABASE_URL`.
5. Apply migrations from a trusted workstation or CI job with `npm run db:migrate`.
6. Verify `schema_migrations` checksums and run integration tests against staging.
7. Seed only local or explicitly approved staging databases. Never set `ALLOW_DEV_SEED` in Production.

## Create the platform administrator

After migrations, create the single platform administrator once from a trusted workstation or protected CI job. Set `PLATFORM_ADMIN_DISPLAY_NAME`, `PLATFORM_ADMIN_EMAIL`, and a unique `PLATFORM_ADMIN_PASSWORD` of at least 12 characters, then run `npm run platform-admin:create`. The command refuses to create a second platform administrator or reuse a tenant email. It creates one global credential and grants access to every existing organization; organizations created later are connected automatically. Remove `PLATFORM_ADMIN_PASSWORD` from the environment immediately afterward.

The platform administrator signs in once, selects an organization from the platform overview, and can exit back to the organization picker. Do not share this human account among multiple people; “single account” means one credential works across tenants, not that multiple administrators should share a password.

The runtime uses `DB_SSL=true`, certificate verification, and `DB_POOL_MAX=1`. The migration connection is not used by the Vercel function.

## Vercel setup

Configure the project with:

- Build Command: `npm run build`
- Output Directory: `dist`
- Node runtime: the repository `package.json` and Vercel Node runtime
- Preview variables: staging Supabase and staging secrets
- Production variables: production Supabase and production secrets

Required server-side variables include `DATABASE_URL`, `DB_SSL=true`, `DB_SSL_REJECT_UNAUTHORIZED=true`, `DB_POOL_MAX=1`, `JWT_SECRET`, `CSRF_SECRET`, `COOKIE_SECRET`, `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=lax`, `INVITATION_BASE_URL`, `INVITATION_DELIVERY_URL`, `REGISTRATION_RATE_MAX`, `REGISTRATION_RATE_WINDOW_MS`, and the configured timeout/rate-limit values. Do not prefix these with `VITE_`.

`INVITATION_DELIVERY_URL` is a server-side webhook used when a platform administrator provisions an organization. It receives a JSON payload containing `to`, `organization_name`, `invite_url`, and `expires_at`. The application stores only a SHA-256 token hash, so the webhook must deliver the link immediately. Invitation acceptance is available at `/#/accept-invitation`. Public organization registration is available at `/#/register` and `POST /api/v1/auth/register-tenant`; it activates the registering HR administrator immediately and is protected by `REGISTRATION_RATE_MAX` and `REGISTRATION_RATE_WINDOW_MS` (defaults: 5 attempts per hour per IP/email key).

Platform Administrators can copy a one-time invitation link from the organization workflow. Link generation rotates the pending invitation, returns the link only to the authorized platform session, and records the action in the platform audit log. Treat the link as a bearer credential and share it only with the intended HR administrator.

HR Managers can create an employee portal user without handling a password by leaving the temporary-password field blank. The API generates a tenant-scoped, one-time invitation at `POST /api/v1/hr/directory` or `PUT /api/v1/hr/directory/:employee_id` with `account.enabled=true`, `account.invite=true`; no email is sent. The returned link is copied for the HR Manager to share manually. A pending link can be rotated at `POST /api/v1/hr/directory/:employee_id/invitation/link`. These links use the same `INVITATION_TTL_HOURS` and `INVITATION_BASE_URL` settings, are stored only as hashes, and must be shared as bearer credentials.

The application bundles Supabase's public 2021 root CA for Supabase database hosts. If Supabase rotates that certificate, download the current root certificate from Database Settings → SSL Configuration and add it to Vercel as `DB_SSL_CA` (preserving PEM newlines) or `DB_SSL_CA_BASE64` (base64-encoded PEM). Keep `DB_SSL_REJECT_UNAUTHORIZED=true`; do not bypass certificate verification in Production.

Deploy Preview first. Confirm SPA refreshes, `/api/v1/auth/me`, secure cookies, CSRF writes, reports, CSV downloads, and tenant context switching before promoting the deployment.

## Migration and rollback

Migrations are append-only and checksum verified. Apply them before deploying code that depends on them. To roll back an application deployment, promote the previous Vercel deployment; do not delete migration history or edit an applied migration. Data corrections require a new forward migration or a reviewed operational SQL change.
