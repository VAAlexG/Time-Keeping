# Timekeeper

A private, shared-password timekeeping application built for Cloudflare Workers. One Worker serves the React interface and protected API, Cloudflare D1 stores all durable data, and a Cron Trigger sends the completed Monday-to-Sunday Excel report every Monday at 12:05 AM Brisbane time.

## Features

- Server-side shared-password authentication using PBKDF2-SHA256
- Random, hashed, D1-backed sessions with secure `HttpOnly` cookies and CSRF protection
- D1-backed login throttling after repeated password failures
- One database-enforced active timer, restored after refresh or reopening the site
- Reusable or newly entered projects, optional notes, and manual completed entries
- Edit and confirmed deletion of completed entries
- Brisbane-aware today, weekly, history, filtered, and per-project totals
- Correct date allocation for entries crossing Brisbane midnight
- Protected, print-ready Excel workbook downloads
- Manual test-email button with delivery records isolated from scheduled reports
- Resend HTTP email delivery with provider and D1 idempotency protection
- Cloudflare Cron execution and automatic cleanup of expired security records

## Cloudflare architecture

- **Frontend:** React, TypeScript, and Vite; served through Worker Static Assets
- **API:** Hono running in Cloudflare Workers
- **Database:** Cloudflare D1
- **Authentication:** PBKDF2 password hash stored as a Worker secret; random server-side sessions stored hashed in D1
- **Reports:** ExcelJS, bundled and executed in the Worker runtime
- **Email:** Resend HTTPS API with Excel attachment
- **Schedule:** Cloudflare Cron Trigger at `5 14 * * SUN` UTC

The Worker dry-run bundle is well under Cloudflare's compressed Worker-size limit. Because password verification and Excel generation are CPU-heavy compared with an ordinary request, the Workers Paid plan is recommended for predictable production operation.

## Required accounts

1. A Cloudflare account with Workers enabled. The Workers Paid plan is recommended.
2. A Resend account, a verified sending domain, and a sending-only API key.
3. Access to this GitHub repository or a local clone.

## Deploy today

### 1. Install and authenticate

Install Node.js 22 or later, then run:

```powershell
npm ci
npx wrangler login
```

`wrangler login` opens Cloudflare authorization in the browser. Verify the active account with:

```powershell
npx wrangler whoami
```

### 2. Create the D1 database

```powershell
npm run db:create
```

The command prints a `database_id`. Replace the placeholder UUID in `wrangler.jsonc` under `d1_databases[0].database_id` with that value.

Apply the production schema:

```powershell
npm run db:migrate
```

Wrangler records each applied file from `migrations-d1` in D1's migration table. Production migration application is transactional and captures a database backup.

### 3. Generate the requested shared-password hash

Do not put the plaintext password in the repository, a command argument, `.dev.vars`, or a Cloudflare variable. Generate the PBKDF2 hash locally without echoing the password:

```powershell
$env:TIMEKEEPING_PASSWORD = Read-Host -MaskInput "Shared password"
$passwordHash = npm run --silent password:hash
Remove-Item Env:TIMEKEEPING_PASSWORD
```

Create a temporary, ignored secrets file from the tracked placeholder:

```powershell
Copy-Item .dev.vars.example .production.secrets
```

Put the generated hash after `APP_PASSWORD_HASH=` in `.production.secrets`, then clear the shell variable:

```powershell
Remove-Variable passwordHash
```

### 4. Configure the remaining secrets

Fill the remaining blank values in `.production.secrets`.

Use:

- `EMAIL_FROM`: a sender on the domain verified by Resend, for example `Timekeeper <reports@your-domain.example>`
- `WEEKLY_REPORT_RECIPIENT`: the required production report mailbox
- `REPORT_TEST_RECIPIENT`: an inbox you can safely inspect during setup

The file is excluded by `.gitignore`. Never commit it, attach it to an issue, or share it in screenshots. The repository and Wrangler configuration contain secret names only.

### 5. Deploy

```powershell
npm run build:client
npx wrangler deploy --secrets-file .production.secrets
```

Wrangler builds the React client, bundles the API Worker, uploads the static assets, attaches D1, and configures the Cron Trigger. It prints a `workers.dev` URL when deployment succeeds.

After deployment, remove the temporary local secrets file:

```powershell
Remove-Item -LiteralPath .production.secrets
```

Cloudflare retains the encrypted secrets. Later `npm run deploy` calls preserve them. To rotate one value, run `npx wrangler secret put SECRET_NAME` and enter its new value at the prompt.

Verify the backend:

```powershell
Invoke-RestMethod https://YOUR-WORKER.workers.dev/api/health
```

Expected response:

```json
{
  "status": "ok",
  "runtime": "cloudflare-workers",
  "database": "d1",
  "timezone": "Australia/Brisbane"
}
```

### 6. Verify the complete workflow

1. Open the `workers.dev` URL and enter the shared password.
2. Enter or choose a project and clock in.
3. Clock out.
4. Edit the resulting entry.
5. Confirm the Today and This Week totals.
6. Open Reports and download the workbook.
7. Open it in Microsoft Excel and inspect its rows, totals, widths, and print layout.
8. Set `REPORT_TEST_RECIPIENT` to your inbox and click **Send test email**.
9. Click it again and confirm the application reports that no duplicate was created.

Test delivery uses `delivery_type=test`; the automated job uses `delivery_type=scheduled`. Sending a test can never consume the scheduled delivery record.

### 7. Optional custom domain

In Cloudflare Dashboard:

1. Open **Workers & Pages**.
2. Select **timekeeper**.
3. Open **Settings → Domains & Routes**.
4. Add a custom domain managed by the same Cloudflare account.

No application configuration changes are needed after the domain is attached.

## Weekly schedule

`wrangler.jsonc` defines:

```text
5 14 * * SUN
```

Cloudflare Cron uses UTC. Brisbane remains UTC+10 throughout the year, so Sunday 14:05 UTC is Monday 12:05 AM Brisbane time. The handler selects the Monday-to-Sunday week that has just ended.

Delivery safety has three layers:

1. D1 allows only one record per week and delivery type.
2. A sent record is never claimed again; a failed record may be retried.
3. Resend receives a deterministic `Idempotency-Key` for each week and delivery type.

Delivery status, attempt count, provider message ID, error message, recipient, and sent time are retained in D1. Worker observability is enabled for runtime and Cron logs.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and use non-production values. `.dev.vars` is ignored by Git.

Create the local D1 schema and start Wrangler:

```powershell
npm run db:migrate:local
npm run dev
```

The first `npm run dev` builds the frontend and starts the Worker at the URL shown by Wrangler. Local D1 state is stored below the ignored `.wrangler` directory.

Do not use the production Resend API key or production recipient for ordinary local testing.

## Environment and secret bindings

| Binding                   | Type                  | Required | Purpose                                                     |
| ------------------------- | --------------------- | -------- | ----------------------------------------------------------- |
| `DB`                      | D1 binding            | Yes      | Projects, entries, sessions, login attempts, and deliveries |
| `ASSETS`                  | Static Assets binding | Yes      | Built React application                                     |
| `APP_PASSWORD_HASH`       | Secret                | Yes      | PBKDF2 hash of the shared password                          |
| `RESEND_API_KEY`          | Secret                | Yes      | Sending-only Resend credential                              |
| `EMAIL_FROM`              | Secret                | Yes      | Verified report sender                                      |
| `WEEKLY_REPORT_RECIPIENT` | Secret                | Yes      | Production weekly recipient                                 |
| `REPORT_TEST_RECIPIENT`   | Secret                | Yes      | Safe manual-test recipient                                  |

## D1 migrations

```powershell
npm run db:migrate:local  # local Wrangler database
npm run db:migrate        # production D1 database
```

The initial migration creates:

- case-insensitive reusable projects;
- precise UTC millisecond timestamps;
- a unique active-timer guard enforced by D1;
- hashed session records;
- persisted login-attempt windows;
- idempotent weekly-delivery audit records.

Times remain precise UTC timestamps in D1. Australia/Brisbane conversion occurs only for display, filtering, date allocation, and reports.

## Backup and export

D1 Time Travel provides point-in-time recovery. Also take periodic portable exports:

```powershell
npx wrangler d1 export timekeeper --remote --output timekeeper-backup.sql
```

Store exported files encrypted outside the repository. `*.sql` backup filenames should not be committed. Excel reports are useful business exports but are not a complete database backup.

## Quality checks

```powershell
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

The test suite runs inside Cloudflare's `workerd` runtime with real local D1 migrations. It covers:

- authentication, protected routes, session recovery, CSRF, and logout;
- persisted sign-in throttling;
- clock-in/out and database-enforced active-timer exclusion;
- manual add, edit, delete, and server validation;
- Brisbane timezone and week boundaries;
- durations, weekly/project totals, and cross-midnight allocation;
- authenticated Excel creation and workbook parsing;
- Resend request construction, failed-delivery retry, and duplicate prevention;
- separation of test and scheduled delivery records.

The production dry run is `npm run build`; it compiles the client and asks Wrangler to bundle and validate the Worker without deploying it.
