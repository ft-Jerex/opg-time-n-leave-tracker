# Time & Leave Tracker

Full-stack React/Vite and Express/PostgreSQL time and leave tracking application.

## Development

```bash
Copy-Item .env.example .env
docker compose up -d
npm install
npm run db:migrate
$env:ALLOW_DEV_SEED = "true"
npm run db:seed
npm run dev
```

The client runs on Vite and proxies `/api` to Express. Production uses `npm run build` followed by `npm start` with `NODE_ENV=production`.

Development credentials are configured through `SEED_ADMIN_PASSWORD`, `SEED_HR_PASSWORD`, `SEED_USER_PASSWORD`, and `SEED_READONLY_PASSWORD` in `.env`. They are bcrypt-hashed before storage.

| Account              | Role                 |
| -------------------- | -------------------- |
| `admin@dev.local`    | Platform administrator |
| `hr@dev.local`       | HR manager |
| `manager@dev.local`  | Reporting manager    |
| `user@dev.local`     | Operational user     |
| `readonly@dev.local` | Read-only user       |

Passwords are read from the seed-password variables; development-only examples are in `.env.example`. Sessions use HttpOnly cookies and CSRF protection. The platform administrator has one global email/password, chooses an organization after login, and automatically receives access to organizations added later. No tenant-specific platform password is created. Organizations can self-register publicly or be provisioned by the platform administrator. HR managers create employee portal users through a one-time invitation link that can be copied and shared manually; no email service is required, and the client retains only a non-sensitive session-presence hint locally.

HR administrators can manage Departments and the Employee Directory, provision portal accounts through one-time copyable invitation links, update reporting assignments, generate one-time password-reset links without seeing passwords, export filtered audit CSV, and generate tenant-wide payroll-preparation summaries. Payroll exports include worked minutes, overtime, approved paid leave, and approved unpaid leave for the selected date range; they do not execute payroll.

Docker exposes development PostgreSQL on port `55432` and isolated test PostgreSQL on `55433`, avoiding conflicts with native Windows installations. Run `npm run db:test:prepare` after creating `.env` to prepare the integration database.

## Commands

Run `npm run platform-admin:create` once to create the staging or production platform administrator from protected `PLATFORM_ADMIN_*` environment inputs. The command is not a development seed and refuses to create a second platform administrator.

- `npm run dev` — start client and server.
- `npm run db:migrate` — apply checksum-verified migrations.
- `npm run db:seed` — reset and seed the development database when `ALLOW_DEV_SEED=true`.
- `npm run test:all` — run the available automated checks.
- `npm run test:e2e` — run browser workflows with the development server running.
- `npm run verify:full` — run type checks, API tests, browser workflows, responsive checks, and accessibility audits.
- `npm run audit:security` — check cookie, CSRF, problem-response, and credential configuration.

File uploads remain metadata-only until a storage provider is selected.

Organization onboarding requires `INVITATION_DELIVERY_URL` and `INVITATION_BASE_URL` in production. The delivery endpoint receives the recipient, organization name, expiry, and one-time invitation URL; the database stores only a hash of the invitation token. Organization suspension is reversible and preserves historical records; hard deletion is not supported.

Production startup fails closed unless database TLS, secure cookies, and independent JWT, CSRF, and cookie secrets are configured. Production secrets must contain at least 32 characters.

## Supabase and Vercel deployment

Vercel hosts the Vite application and the Express API on one origin. Supabase provides PostgreSQL only; authentication remains the application JWT/HttpOnly-cookie flow. Configure Vercel's Build Command as `npm run build` and Output Directory as `dist`. The `/api/*` rewrite is defined in `vercel.json`.

Use a Supabase Shared Pooler transaction URL for the Vercel runtime in `DATABASE_URL`, with `DB_SSL=true` and `DB_POOL_MAX=1`. Use a direct or session-pooler URL in `MIGRATION_DATABASE_URL` for `npm run db:migrate`; never run migrations in the Vercel build. Preview deployments must use a separate staging Supabase project. Production seeding is refused; use Docker or an explicitly permitted staging database for `npm run db:seed`.

See [docs/deployment.md](docs/deployment.md) for provisioning, environment variables, migrations, smoke tests, and rollback. Operational recovery and secret rotation are documented in [docs/operations.md](docs/operations.md).
