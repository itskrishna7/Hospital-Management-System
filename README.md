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

To enable patient portal email, set `RESEND_API_KEY` and a Resend-verified `RESEND_FROM` address in `server/.env`. SMS delivery is disabled.

The seed also creates repeatable synthetic demo records: 30 patients, 6 doctors, 16 beds, 18 appointments, 8 admissions, 12 medicines, 20 lab orders, and 15 invoices. Demo records use stable `DEMO-*` identifiers, so rerunning the seed updates them instead of creating duplicates.

Seeding is for development only; the seed command refuses to run with `NODE_ENV=production`. In production, deploy only reviewed Prisma migrations and configure secrets outside source control. The frontend demo fallback is development-only; production builds never show synthetic fallback data.

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
