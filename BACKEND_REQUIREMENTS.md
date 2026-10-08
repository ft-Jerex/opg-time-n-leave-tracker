# Backend Requirements

The Express MVC server is under `src/server/`. The canonical API schema is `.agent/instructions/schema.json`; client view models under `src/client/` are not schema authorities.

## Runtime structure

- `src/server/routes/` declares `/api/v1` routes.
- `src/server/controllers/` handles HTTP input, status codes, headers, and response delegation.
- `src/server/services/` owns transactions, state transitions, domain invariants, and audit writes.
- `src/server/models/` owns parameterized, tenant-scoped PostgreSQL queries.
- `src/server/middleware/` owns authentication, CSRF, tenant context, capabilities, request IDs, versions, and errors.
- `src/server/views/` serializes validated entities and RFC 7807 problem details.
- `database/migrations/` contains checksum-tracked migrations; `database/seeders/seed.js` provides development data.

Vercel uses `api/index.js` as the serverless Express entry point. Vercel serves the Vite `dist` output; the Express process does not serve static assets in that environment.

## Authentication and tenancy

Local development uses bcrypt credentials in the separate `auth_credentials` table and HttpOnly JWT cookies. `AUTH_ADAPTER_MODULE` remains available for verified external identity providers. Every actor must provide `user_id`, `tenant_id`, and capabilities. All reads and writes are tenant-scoped, and state-changing cookie requests require a CSRF token. HR directory creation is transactional across employees, users, and auth credentials; plaintext passwords are never persisted or returned.

## API conventions

The API prefix is `/api/v1`. Authentication endpoints are `/auth/login`, `/auth/me`, `/auth/logout`, `/auth/context`, `/auth/password`, and `/auth/invitations/accept`. Platform organization provisioning is available only to platform administrators through `/platform/tenants`, `/platform/tenants/:tenant_id`, `/platform/tenants/:tenant_id/status`, and `/platform/tenants/:tenant_id/invitation/resend`. HR endpoints include `/hr/directory` and `/hr/directory/:employee_id/reset-password`. Organization reports are available at `/reports/:preset` and `/reports/:preset.csv`; tenant audit export is `/audit-events/export.csv`. Resource responses contain only validated canonical entities. Collection pagination uses response headers. Versioned resources require `If-Match`; stale updates return `409`. Failures use `application/problem+json` and include the request ID. Organizations are not self-registered; suspension preserves historical records and hard deletion is not supported.

## Database and local environment

On Windows PowerShell, run `docker compose up -d`, `npm run db:migrate`, set `$env:ALLOW_DEV_SEED = "true"`, and run `npm run db:seed`. `001_initial_schema.sql` is preserved; `002_auth_credentials.sql` adds credential storage and `004_supabase_security.sql` removes browser-role access when those Supabase roles exist. Production requires explicit database, JWT, CSRF, cookie, and TLS configuration. Runtime connections use `DATABASE_URL`; controlled DDL uses `MIGRATION_DATABASE_URL` and a direct/session-pooler connection.

For Supabase, enable SSL enforcement and network restrictions, keep database credentials server-side, and do not expose Supabase browser/Data API credentials through Vite environment variables. The application enforces tenant scope in Express and SQL; Supabase browser roles are revoked by migration `004` because the browser does not connect directly to PostgreSQL.

## Verification

Run `npm run test:unit`, `npm run test:integration`, `npm run test:domain`, `npm run test:e2e`, `npm run audit:a11y`, `npm run audit:layout`, `npm run audit:authorization`, and `npm run audit:security`. PostgreSQL-backed suites require Docker or an equivalent `DATABASE_URL`.
