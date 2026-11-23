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

Set `DATABASE_URL`, a random `SESSION_SECRET` of at least 32 characters, and `SEED_ADMIN_PASSWORD` in `server/.env`. `SESSION_SECRET` is required in all modes and is used to protect MFA secrets. Create the database, then run:

```powershell
npm run prisma:migrate --workspace server
npm run prisma:seed --workspace server
npm run dev
```

The client runs at `http://localhost:5173`; the API connects to PostgreSQL through Prisma. Sensitive reads and all writes require an authenticated session. The development seed creates repeatable synthetic records and an administrator account whose password is set through `SEED_ADMIN_PASSWORD`.

For local development, set both `DATABASE_URL` and `DIRECT_URL` to your local PostgreSQL connection. `DATABASE_URL` is used by the application; `DIRECT_URL` is used by Prisma migrations.

To enable patient portal email, set `RESEND_API_KEY` and a Resend-verified `RESEND_FROM` address in `server/.env`. SMS delivery is disabled.

The seed also creates repeatable synthetic demo records: 30 patients, 6 doctors, 16 beds, 18 appointments, 8 admissions, 12 medicines, 20 lab orders, and 15 invoices. Demo records use stable `DEMO-*` identifiers, so rerunning the seed updates them instead of creating duplicates.

Seeding is for development only; the seed command refuses to run with `NODE_ENV=production`. In production, deploy only reviewed Prisma migrations and configure secrets outside source control. The frontend demo fallback is development-only; production builds never show synthetic fallback data.

## Vercel and hosted PostgreSQL deployment

Vercel cannot connect to PostgreSQL running on a developer's computer or to a `localhost` URL. Create a hosted PostgreSQL database first; this project does not provision one automatically. To keep local development unchanged, configure the hosted URLs only in the Vercel Production environment:

- `DATABASE_URL`: Neon `DATABASE_URL`, the pooled connection URL for application requests.
- `DIRECT_URL`: Neon `DATABASE_URL_UNPOOLED`, the direct connection URL for Prisma migrations.
- `SESSION_SECRET`: a unique random value of at least 32 characters.
- `CLIENT_ORIGIN`: the deployed site's exact HTTPS origin, without a trailing slash.

The Neon CLI keeps its connection variables in the ignored root `.env.local`. `server/.env` remains dedicated to local PostgreSQL. Run `npm run prisma:neon:status --workspace server` to inspect the Neon branch and `npm run prisma:neon:deploy --workspace server` to apply the checked-in migrations using the pooled and direct Neon URLs. These commands do not copy local records. Never use `prisma migrate reset` or `db push --force-reset`. Do not run the development seed in production.

For an empty hosted database, create the initial administrator only after migrations are applied. Set `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME`, and a unique `BOOTSTRAP_ADMIN_PASSWORD` only in the local environment used for `npm run auth:bootstrap-admin --workspace server`; the bootstrap script refuses to run unless the `User` table is empty. Do not put bootstrap credentials in the client or commit them.

The API health endpoint performs a database query and returns HTTP 503 when PostgreSQL is unreachable. Verify it, authentication, and protected routes after migrations and administrator bootstrap. Integration tests create and remove temporary records, so run them only against a disposable test database or isolated test branch, not against a database containing records you need to preserve.

## API

All application endpoints use `/api/v1`. The API returns `{ data }` for success and `{ error: { code, message } }` for failures. The API includes authenticated account/MFA and role-based administration, clinical-care workflows, and patient portal features for family grants, appointment access, QR check-in, and queues.

Patients can be updated with `PATCH /api/v1/patients/:id`. Operational records are available from `/appointments`, `/admissions`, `/lab-orders`, and `/invoices`; their status can be changed through each resource's `PATCH /:id/status` endpoint. Discharging an admission also releases its bed.

## Database and Tests

```powershell
npm run prisma:deploy --workspace server
npm test
npm run build
```

`prisma:deploy` applies pending migrations without resetting the database. `npm test` includes unit tests and PostgreSQL integration tests that create and remove uniquely named test accounts and records.

## Safety

This project includes synthetic development data, has not undergone independent clinical, security, privacy, regulatory, or operational validation, and makes no compliance claim. Do not use it to make clinical decisions or handle real patient data without appropriate validation and safeguards.
