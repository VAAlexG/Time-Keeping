# Timekeeper

A private, shared-password timekeeping application for an individual or small firm. It records precise UTC timestamps in PostgreSQL, presents them in `Australia/Brisbane`, restores a running timer after refresh, and produces print-ready Monday-to-Sunday Excel reports.

## Features

- Server-side shared-password authentication, persistent secure sessions, logout, CSRF protection, and sign-in rate limiting
- One recoverable running timer, project/activity reuse or creation, optional notes, and manual entries
- Edit and confirmed deletion of completed entries
- Today, current-week, date-filtered history, weekly totals, and per-project totals
- Correct allocation of cross-midnight entries to Brisbane calendar days
- Authenticated `.xlsx` report download with daily details/totals, project totals, and a weekly total
- Idempotent scheduled/test email deliveries with success/failure records in PostgreSQL
- Responsive desktop and mobile interface

## Architecture

- React, TypeScript, and Vite client
- Express API and server-side sessions
- PostgreSQL persistence and SQL migrations
- ExcelJS workbook generation
- SMTP delivery through Nodemailer (Resend SMTP is the recommended provider)
- Docker deployment to Render, Neon PostgreSQL, and GitHub Actions scheduling

The application never uses browser local storage as its source of truth. Timestamps remain UTC in PostgreSQL; Brisbane conversion occurs at API/report boundaries.

## Local setup

Requirements: Node.js 22+, npm, and PostgreSQL 15+.

1. Install packages:

   ```powershell
   npm ci
   ```

2. Copy `.env.example` to an untracked `.env` and provide the variables below. Node does not load `.env` automatically; load the values in your shell or use your preferred local environment loader.

3. Generate the password hash without adding the plaintext password to a file or command argument:

   ```powershell
   $env:TIMEKEEPING_PASSWORD = Read-Host -MaskInput "Shared password"
   $env:APP_PASSWORD_HASH = npm run --silent password:hash
   Remove-Item Env:TIMEKEEPING_PASSWORD
   ```

4. Generate a strong session secret (at least 32 characters), for example:

   ```powershell
   $bytes = New-Object byte[] 48
   [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
   $env:SESSION_SECRET = [Convert]::ToBase64String($bytes)
   ```

5. Set `DATABASE_URL`, apply migrations, and run the API:

   ```powershell
   npm run migrate
   npm run dev
   ```

6. In another terminal, run the Vite client and open `http://localhost:5173`:

   ```powershell
   npm run dev:client
   ```

For a production-style local run, use `npm run build` followed by `npm start`, then open the API port (default `http://localhost:3000`). Startup also applies pending migrations safely.

## Environment variables

| Variable                  | Required      | Purpose                                                                               |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | Yes           | PostgreSQL connection string; must be reachable by the web service and GitHub Actions |
| `APP_PASSWORD_HASH`       | Yes           | Output of `npm run password:hash`; never the plaintext password                       |
| `SESSION_SECRET`          | Yes           | Random value of at least 32 characters used to sign session cookies                   |
| `PORT`                    | Host-defined  | HTTP port; defaults to `3000`                                                         |
| `SMTP_HOST`               | Email jobs    | SMTP hostname, such as `smtp.resend.com`                                              |
| `SMTP_PORT`               | Email jobs    | Usually `587` (STARTTLS) or `465` (implicit TLS)                                      |
| `SMTP_SECURE`             | Email jobs    | `true` for implicit TLS/465, otherwise `false`                                        |
| `SMTP_USER`               | Email jobs    | SMTP user/provider identifier                                                         |
| `SMTP_PASSWORD`           | Email jobs    | SMTP/API credential                                                                   |
| `SMTP_FROM`               | Email jobs    | Verified sender, such as `Timekeeper <reports@your-domain.example>`                   |
| `WEEKLY_REPORT_RECIPIENT` | Scheduled job | Production report recipient                                                           |
| `REPORT_TEST_RECIPIENT`   | Test job      | Safe inbox for test delivery                                                          |

`.env.example` contains blank placeholders only. Do not commit `.env`, passwords, database URLs, session secrets, or SMTP credentials.

## Database and migrations

Run:

```powershell
npm run migrate
```

The migration creates projects, precise time entries, PostgreSQL-backed sessions, delivery audit records, and a unique partial index that enforces only one active timer even under concurrent requests. Applied migration filenames are recorded in `schema_migrations`.

## Weekly Excel reports

The Reports screen accepts any date and normalizes it to that Brisbane week’s Monday. The workbook contains each applicable date, clock-in/out, duration, project, notes, daily totals, project totals, and the entire-week total. Cross-midnight entries are split at Brisbane midnight while retaining the original timestamps in the database.

The authenticated endpoint is:

```text
GET /api/reports/weekly.xlsx?weekStart=YYYY-MM-DD
```

## Email configuration and testing

The recommended provider is Resend SMTP: verify a sending domain, create an SMTP credential, then map it to `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Generic TLS-enabled SMTP providers work as well.

To send a test delivery for the previous completed week:

```powershell
npm run report:test-email
```

To test a specific week:

```powershell
npm run report:test-email -- --week=2026-08-03
```

Test deliveries use `REPORT_TEST_RECIPIENT` and a separate `delivery_type=test` idempotency record, so they cannot consume or duplicate the scheduled delivery. A successful repeated test for the same week is skipped. Failed deliveries are recorded and may be retried. When Resend SMTP is used, the sender also supplies a deterministic `Resend-Idempotency-Key` for provider-side retry protection.

In GitHub, **Actions → Weekly time report → Run workflow** provides the same test path. Keep `delivery` set to `test`. Choosing `scheduled` intentionally uses the production recipient and production idempotency record.

## Brisbane weekly schedule

`.github/workflows/weekly-report.yml` runs at `5 14 * * 0` UTC. Brisbane is UTC+10 without daylight saving, so this is Monday 12:05 AM Brisbane time, after the Sunday week has ended. The script automatically selects the Monday-to-Sunday week that just finished.

The job and database both enforce duplicate protection:

- GitHub Actions uses one non-cancelling concurrency group.
- PostgreSQL has one delivery record per `(week_start, delivery_type)`.
- Resend receives a stable provider-side idempotency key for each week and delivery type.
- A sent report is never sent again by a retry; a failed report can be retried.
- Status, attempts, recipient, error message, and sent timestamp are retained.

GitHub Actions is appropriate here only because the selected Neon database accepts secure external connections. If a future database is private to its hosting network, move the same `npm run report:send` command to that provider’s scheduled-job service.

## Deployment: Render + Neon + Resend

1. Create a Neon PostgreSQL project in an Australian or nearby region. Copy its pooled connection string.
2. In Render, create a **Web Service** from this repository and select **Docker**. The included `Dockerfile` builds and starts the app; health path is `/api/health`.
3. In Render, add `DATABASE_URL`, `APP_PASSWORD_HASH`, and `SESSION_SECRET` as secret environment values. Set `NODE_ENV=production`. Do not add the SMTP values to Render unless you also plan to run email jobs there.
4. Deploy. The service applies migrations before accepting requests. Render supplies `PORT` automatically and terminates HTTPS; production cookies are `Secure`, `HttpOnly`, and `SameSite=Strict`.
5. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add:
   - `DATABASE_URL`
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
   - `WEEKLY_REPORT_RECIPIENT` (set to the required production mailbox)
   - `REPORT_TEST_RECIPIENT` (set to an inbox you can safely inspect)
6. Run the workflow manually with `delivery=test`. Confirm receipt and inspect the workbook before relying on the weekly schedule.
7. Clock a short entry through the deployed site, then download its report to verify that the web service and scheduled job share the same database.

On Render’s free tier the web service may sleep, but GitHub Actions connects directly to Neon, so scheduled reporting does not depend on the web service being awake. Review current provider plans, retention, and regional availability before production use.

## Backup and export

- Treat the Excel report as a convenient business export, not the only backup.
- Enable Neon’s point-in-time restore/retention appropriate to the plan.
- Periodically take a PostgreSQL backup with `pg_dump "$env:DATABASE_URL" --format=custom --file timekeeper.backup` and store it encrypted outside the repository.
- Verify a restore periodically in a separate database.
- Download weekly Excel files for normal recordkeeping.

## Quality checks

```powershell
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

Tests cover protected routes and sessions, clock-in/out, the one-active-timer rule, manual validation/edit/delete, duration clipping, Brisbane week boundaries, cross-midnight allocation, Excel workbook contents, weekly totals, failed-email retry, and duplicate-email prevention.
