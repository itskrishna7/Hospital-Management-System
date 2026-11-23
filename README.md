# MediVerse

MediVerse is a full-stack hospital operations platform using a React/Vite client, Express API, Prisma ORM, and PostgreSQL. Development records are synthetic and must not be used as real clinical data.

## Requirements

- Node.js 20+
- PostgreSQL 15+

## Setup

```powershell
npm install
Copy-Item server\.env.example server\.env
Copy-Item client\.env.example client\.env
```

Set the application `DATABASE_URL` (Neon pooled URL), `DIRECT_URL` (Neon direct URL), a random `SESSION_SECRET` of at least 32 characters, and `SEED_ADMIN_PASSWORD` in the ignored runtime environment. `SESSION_SECRET` is required in all modes and is used to protect MFA secrets. Use a dedicated non-production Neon development branch with synthetic records; verify its project, branch, and database before running migrations or seed commands. Then run:

```powershell
npm run prisma:migrate --workspace server
npm run prisma:seed --workspace server
npm run dev
```

The client runs at `http://localhost:5173`; the API connects to Neon Postgres through Prisma. Sensitive reads and all writes require an authenticated session. The development seed creates repeatable synthetic records and an administrator account whose password is set through `SEED_ADMIN_PASSWORD`. Never point development or test commands at production.

Local PostgreSQL is not the primary database provider or the integration-test target. For app queries use the Neon pooled URL in `DATABASE_URL`; for Prisma migrations and backup tools use the direct URL in `DIRECT_URL`.

To enable patient portal email, set `RESEND_API_KEY` and a Resend-verified `RESEND_FROM` address in `server/.env`. SMS delivery is disabled.

On Vercel, configure the same Resend variables and a unique `CRON_SECRET` of at least 32 characters in the server service environment. The Hobby-compatible daily Cron retries durable notification events; first delivery is attempted immediately. See [Phase 5 operations](./docs/phase5.md).

The seed also creates repeatable synthetic demo records: 30 patients, 6 doctors, 16 beds, 18 appointments, 8 admissions, 12 medicines, 20 lab orders, and 15 invoices. Demo records use stable `DEMO-*` identifiers, so rerunning the seed updates them instead of creating duplicates.

Seeding is for development only; the seed command refuses to run with `NODE_ENV=production`. In production, deploy only reviewed Prisma migrations and configure secrets outside source control. The frontend demo fallback is development-only; production builds never show synthetic fallback data.

## Neon database configuration

MediVerse uses Neon Postgres. Configure branch-specific URLs and credentials in the appropriate ignored environment file or secret store:

- `DATABASE_URL`: Neon `DATABASE_URL`, the pooled connection URL for application requests.
- `DIRECT_URL`: Neon `DATABASE_URL_UNPOOLED`, the direct connection URL for Prisma migrations.
- `TEST_DATABASE_URL`: pooled URL from the dedicated synthetic-only Neon test branch.
- `TEST_DATABASE_DIRECT_URL`: direct URL from that same test branch.
- `TEST_NEON_PROJECT_ID`, `TEST_NEON_BRANCH_ID`, `TEST_NEON_BRANCH_NAME`, `TEST_NEON_BRANCH_IS_DEFAULT`, `TEST_NEON_PARENT_BRANCH_ID`, `TEST_NEON_PARENT_BRANCH_NAME`, `TEST_NEON_DATABASE_NAME`, `TEST_NEON_POOLED_HOST`, and `TEST_NEON_DIRECT_HOST`: branch identity and endpoint metadata independently verified before tests.
- `SESSION_SECRET`: a unique random value of at least 32 characters.
- `CRON_SECRET`: a unique random value of at least 32 characters to authorize the scheduled outbox runner.
- `CLIENT_ORIGIN`: the deployed site's exact HTTPS origin, without a trailing slash.

Keep production, development, and test credentials separate. The `prisma:neon:status` and `prisma:neon:deploy` scripts explicitly load root `.env.local` and contact Neon; use them only after verifying that the explicit project and branch are non-production and appropriate. Do not rely on the current `.neon` context, which may point to production. Never use `prisma migrate reset` or `db push --force-reset`. Do not run the development seed in production.

For an empty hosted database, create the initial administrator only after migrations are applied. Set `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME`, and a unique `BOOTSTRAP_ADMIN_PASSWORD` only in the local environment used for `npm run auth:bootstrap-admin --workspace server`; the bootstrap script refuses to run unless the `User` table is empty. Do not put bootstrap credentials in the client or commit them.

The API health endpoint performs a database query and returns HTTP 503 when Neon is unreachable. Verify it, authentication, and protected routes after migrations and administrator bootstrap. Integration tests require separate `TEST_DATABASE_URL` and `TEST_DATABASE_DIRECT_URL` values plus verified `TEST_NEON_*` metadata for the exact non-default `mediverse-test-*` branch and `mediverse_test` database. The test bootstrap rejects host/database/TLS mismatches and never falls back to production `DATABASE_URL` or `DIRECT_URL`. Tests use synthetic records only. See [Neon branch database testing](./docs/database-testing.md).

### Backup and restore

Follow the [Neon backup and restore runbook](./docs/database-backup-and-restore.md). It describes Neon branch recovery and `pg_dump`/`pg_restore` between synthetic-only disposable branches. The runbook's retention proposal is not configured policy. No backup or restore was executed in the latest verification.

### Pre-deployment checklist

- [ ] Confirm the production Neon project and branch exist, are the intended production target, and contain no local synthetic patient data.
- [ ] Keep the non-production Neon test project/branch, staging, and production credentials separate; verify project, branch ID/name, endpoint host, and database before every migration or restore.
- [ ] Apply pending migrations to a non-production branch first, run integration tests there, and inspect migration status. Back up production before any separately approved production migration; never reset or force-push schema changes.
- [ ] Configure production `DATABASE_URL` with the pooled application URL, `DIRECT_URL` with the direct migration URL, `SESSION_SECRET` with a unique random value of at least 32 characters, `CLIENT_ORIGIN` with the exact deployed HTTPS origin, and `CRON_SECRET` with a unique random value of at least 32 characters.
- [ ] Configure `RESEND_API_KEY` and `RESEND_FROM` only if email delivery is enabled; verify the sender and delivery path without clinical details.
- [ ] Configure provider backup frequency/retention, perform an isolated restore drill, and approve RPO/RTO targets.
- [ ] Confirm Vercel's Node runtime, build output, rewrites, Cron schedule, CORS origin, health endpoint, authentication, and protected routes in staging. Configure log monitoring/alerting and review the outstanding Prisma CLI advisories.
- [ ] Ensure the release contains only reviewed changes and migrations; do not run seed/bootstrap against an existing production database.
- [ ] Obtain explicit operator approval before any production migration or deployment. This checklist does not authorize either action.

## API

All application endpoints use `/api/v1`. The API returns `{ data }` for success and `{ error: { code, message } }` for failures. The API includes authenticated account/MFA and role-based administration, clinical-care workflows, patient portal features for family grants, appointment access, QR check-in, and queues, manual Phase 4 workflows, and Phase 5 live operational aggregates, clinician-approved discharge checklists, staff alerts, and a durable notification outbox. Phase 6 adds AI-free, database-backed forecasts, operational briefings, configurable alerts, performance analytics, CSV export, and hypothetical simulations; estimates are explicitly labeled and are not clinical advice. See [Phase 4 operations](./docs/operations.md), [Phase 5 operations](./docs/phase5.md), and the [development plan](./DEVELOPMENT_PLAN.md) for details and limitations.

Patients can be updated with `PATCH /api/v1/patients/:id`. Operational records are available from `/appointments`, `/admissions`, `/lab-orders`, and `/invoices`. Admission discharge cannot be set through the generic status endpoint; a doctor must record explicit discharge approval, and all required checklist items must be complete before the admission is finalized and its bed is released.

The user, patient, appointment, admission, laboratory-order, and invoice list endpoints accept `page` and `limit` (default 20, maximum 100) and return paginated `items`, `page`, `limit`, and `total`. FHIR export is available at `GET /api/v1/interop/fhir/r4/patients/:patientId/$export` for authorized administrators, doctors, and nurses. It supports optional `from`/`to` date filters and limits each export to 250 appointments and 250 admissions; larger exports require a narrower range. It returns patient-identifying information, is access-checked and audited, and is not an ABDM certification or conformance claim. The export mapping, profile validation, security boundaries, and known gaps are recorded in [the Phase 7 plan](./DEVELOPMENT_PLAN.md#phase-7---interoperability-and-deployment).

## Database, Tests, and Recovery

MediVerse uses Neon Postgres. All database-backed tests, migration rehearsals, recovery drills, and performance benchmarks must run on explicitly verified, disposable Neon test branches with synthetic data only. Local PostgreSQL is not the test provider.

```powershell
# Configure and verify the dedicated Neon test branch first; see the runbook below.
npm run prisma:deploy --workspace server
npm test
npm run build
```

`prisma:deploy` applies pending migrations without resetting a database. Before any database command, verify the Neon project, non-default test branch ID/name, endpoint host, and `mediverse_test` database. Tests use separate `TEST_DATABASE_URL` and `TEST_DATABASE_DIRECT_URL` variables plus `TEST_NEON_*` identity/host variables; they never fall back to production credentials. The test guard rejects unverified branch metadata, non-Neon or mismatched hosts, wrong database names, missing TLS, and connection-target overrides.

Read the safe setup and verification procedures before testing. Do not use the checked-in/local Neon context as a test target; it currently names a `production` branch. Use a separate Neon test project containing only synthetic data. Never use the production project as a test source, including for schema-only branching. Do not reset, delete, or overwrite production or an unknown branch.

- [Neon branch integration testing](./docs/database-testing.md)
- [Migration rollback and recovery](./docs/database-rollback-and-recovery.md)
- [Backup and restore](./docs/database-backup-and-restore.md)
- [Dependency security findings](./docs/dependency-security.md)
- [Database/API performance baseline](./docs/performance-baseline.md)

Use Neon Console/CLI metadata to verify the test branch-to-endpoint mapping before fetching or using its connection URLs. Keep test credentials separate from production; never print connection strings or save real credentials in source, shell history, logs, or committed files. Test data must be synthetic.

### Latest database verification status (2026-11-24)

- The Neon CLI is installed, but the local `.neon` context points to a branch named `production`. No Neon test branch, test credentials, or `TEST_NEON_*` / `TEST_DATABASE_*` variables were supplied. No Neon project/branch listing, connection-string retrieval, or database operation was performed.
- The test guard now requires explicit project/branch/parent identity, a non-default `mediverse-test-*` branch with a synthetic-only seed parent, exact pooled/direct endpoint hosts, TLS, and the `mediverse_test` database. Its targeted tests passed (1 file / 10 tests), and the backend TypeScript no-emit check passed. These checks do not contact Neon.
- Database integration, migration, rollback/recovery, backup/restore, and database/API performance tests remain blocked pending a verified non-production Neon test target. Previous local PostgreSQL readiness checks are not evidence for Neon.
- Prisma schema validation/backend and client build results from the prior verification remain recorded in [the development plan](./DEVELOPMENT_PLAN.md); the targeted Neon guard tests and TypeScript check are the relevant new checks in this follow-up.
- Both `npm audit` and `npm audit --omit=dev` report 4 High and 0 Critical findings in the Prisma dependency graph. Non-forced `npm audit fix` made no package/lockfile changes; no unsafe override or major Prisma upgrade was applied.
- No production database was accessed, no deployment occurred, and no credentials were printed. See the [development plan](./DEVELOPMENT_PLAN.md) and runbooks for blocked tests and the exact manual setup.

## Safety

This project includes synthetic development data, has not undergone independent clinical, security, privacy, regulatory, or operational validation, and makes no compliance claim. Do not use it to make clinical decisions or handle real patient data without appropriate validation and safeguards.
