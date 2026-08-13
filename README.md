# Timekeeper

Timekeeper is a private firm timekeeping application built for Cloudflare Workers. Employees sign in with their existing Versatile Accounting Microsoft 365 account, record their own time, and retain one independent running timer each. Alex and Brendon have administrator reporting access across the firm.

One Worker serves the React interface and Hono API, Cloudflare D1 stores durable data, a nightly Cron Trigger synchronises FYI clients and jobs, and a second Cron Trigger emails a consolidated Monday-to-Sunday Excel report every Monday at 12:05 AM Brisbane time.

## Features

- Microsoft Entra ID sign-in enforced by Cloudflare Access
- Worker-side verification of every Cloudflare Access JWT signature, issuer, audience, and email domain
- Automatic employee provisioning on first sign-in, using the Access subject and optional Entra object ID
- Employee isolation for timers, entries, edits, and deletion
- One database-enforced active timer per employee, restored after refresh or reopening
- Client work classified by FYI client, FYI job, billable status, and optional notes
- Shared priorities board for Alex, Brendon, and Suzie with 1–10 ranking and completion tracking
- Controlled non-billable internal activities for administration, training, leave, business development, and meetings
- Immutable client/job/activity snapshots so renamed or archived master data never rewrites history
- Nightly read-only FYI synchronisation, admin manual refresh, status audit, and validated CSV fallback import
- Brisbane-aware daily, weekly, history, client, job, billable, internal, and utilisation totals
- Correct allocation of entries crossing Brisbane midnight
- Admin-only consolidated history and employee filtering
- Admin-only exception monitoring for long/running timers, missing classifications, and legacy entries
- Admin-only branded Excel reports containing employee, client, job, external IDs, billable status, notes, daily totals, utilisation, and firm summaries
- Resend email delivery with D1 and provider idempotency protection
- Cloudflare Cron execution at the end of the Brisbane work week

## Architecture

- **Frontend:** React, TypeScript, and Vite through Worker Static Assets
- **API:** Hono on Cloudflare Workers
- **Authentication:** Microsoft Entra ID through Cloudflare Access; verified again inside the Worker with `jose`
- **Authorization:** all `@versatileaccounting.com.au` users are employees; configured admin email addresses receive reporting access
- **Database:** Cloudflare D1
- **Reports:** ExcelJS in the Worker runtime
- **Email:** Resend HTTPS API with an Excel attachment
- **Schedules:** `15 16 * * *` UTC for nightly FYI sync (2:15 AM Brisbane) and `5 14 * * SUN` UTC for weekly delivery

Cloudflare Access is the outer security boundary and the Worker validates the Access application token as defense in depth. Do not deploy this version until Access is enabled for the Worker hostname and both Access validation values have been configured.

## Required accounts and permissions

1. A Microsoft Entra administrator who can create an app registration, grant Graph consent, and create a client secret.
2. A Cloudflare account with Workers, D1, and Zero Trust Access enabled.
3. A Resend account with the sending domain verified.
4. FYI Single Practice API access for the client/job synchronisation (CSV import works while access is being arranged).
5. Node.js 22 or later and Wrangler authentication for local deployment.

## FYI client and job setup

Request Single Practice API access from `developers@fyi.app`. Timekeeper reads clients and jobs only; it never creates or updates records in FYI.

Set the issued values as encrypted Worker secrets:

```powershell
npx wrangler secret put FYI_ACCESS_ID
npx wrangler secret put FYI_ACCESS_SECRET
npx wrangler secret put FYI_APPLICATION_ID
```

The Australian API base URL is tracked as `FYI_API_BASE_URL`. The nightly sync archives local selections that disappear from FYI while retaining their snapshots on historical entries. Until credentials are configured, an administrator can import a CSV containing `client_external_id`, `client_name`, `job_external_id`, and `job_name`. Optional columns are `client_code`, `export_code`, `manager`, `partner`, `client_active`, `job_code`, `job_status`, and `job_active`.

## Microsoft Entra ID setup

Follow Cloudflare's current [Microsoft Entra ID identity-provider guide](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/entra-id/). The Microsoft administrator must:

1. In **Microsoft Entra admin center → Enterprise applications**, choose **New application → Create your own application**.
2. Name it `Timekeeper Cloudflare Access` and choose **Register an application to integrate with Microsoft Entra ID**.
3. Select a single-tenant account type for the Versatile Accounting tenant.
4. Add a **Web** redirect URI:

   ```text
   https://YOUR-CLOUDFLARE-TEAM-NAME.cloudflareaccess.com/cdn-cgi/access/callback
   ```

5. Copy the **Application (client) ID** and **Directory (tenant) ID**.
6. Under **Certificates & secrets**, create a client secret and immediately store its **Value** securely. Record its expiry date. Never place it in this repository or chat.
7. Under **API permissions → Microsoft Graph → Delegated permissions**, add:

   - `email`
   - `offline_access`
   - `openid`
   - `profile`
   - `User.Read`
   - `Directory.Read.All`
   - `GroupMember.Read.All`

8. Grant tenant-wide administrator consent.
9. Under **Token configuration**, add the `email` optional claim.

Cloudflare documents this permission set as its tested and supported configuration. Group support is not required by the current Timekeeper policy, but keeping it available makes a future Entra admin group straightforward.

## Cloudflare Access setup

### 1. Add Microsoft Entra as the identity provider

1. Open **Cloudflare Dashboard → Zero Trust → Integrations → Identity providers**.
2. Choose **Add new identity provider → Azure AD**.
3. Enter the Entra application client ID, tenant ID, and client-secret value directly in Cloudflare.
4. Enable PKCE if offered.
5. Set the email claim to `email` if it is not detected automatically.
6. Under custom OIDC claims, add `oid`. This lets Timekeeper retain the stable Entra object ID if an email address changes.
7. Save and use Cloudflare's **Test** action. Confirm the returned identity has the correct Versatile Accounting email and an `oid` field.

### 2. Protect the Worker

1. Open **Workers & Pages → timekeeper → Domains** and enable Cloudflare Access for `timekeeper.alexg-826.workers.dev`. The dashboard may direct you to the corresponding Zero Trust application.
2. Create an **Allow** policy for emails ending in `@versatileaccounting.com.au`.
3. Require the Microsoft Entra identity provider created above. Do not enable a bypass or One-time PIN fallback.
4. Choose an Access session duration appropriate for the firm, such as 12 or 24 hours.
5. Test with Alex first, then confirm another firm account can enter.

The Worker independently rejects any authenticated email outside `versatileaccounting.com.au`.

### 3. Record the Worker validation values

- **Team domain:** **Zero Trust → Settings → Team name and domain**, formatted as `https://TEAM.cloudflareaccess.com`
- **Application Audience (AUD) tag:** **Zero Trust → Access controls → Applications → Timekeeper → Configure → Additional settings**

Set both as encrypted Worker secrets without putting their values on a command line:

```powershell
npx wrangler secret put ACCESS_TEAM_DOMAIN
npx wrangler secret put ACCESS_AUD
```

Wrangler prompts for each value securely. The team domain and AUD are identifiers rather than passwords, but storing them as Worker secrets keeps environment-specific configuration out of Git.

## Production deployment

### 1. Install and authenticate

```powershell
npm ci
npx wrangler login
npx wrangler whoami
```

### 2. Configure report-delivery secrets

If not already present on the Worker, set these interactively:

```powershell
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM
npx wrangler secret put WEEKLY_REPORT_RECIPIENT
npx wrangler secret put REPORT_TEST_RECIPIENT
```

- `EMAIL_FROM` must be a sender on the domain verified by Resend.
- `WEEKLY_REPORT_RECIPIENT` is the production consolidated-report mailbox.
- `REPORT_TEST_RECIPIENT` is a safe inbox used by the manual test action.

### 3. Validate before the cutover

```powershell
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

### 4. Apply the identity migration and deploy

First enable Cloudflare Access and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Then run these commands together during the cutover:

```powershell
npm run db:migrate
npm run deploy
```

Migration `0002_employee_identity.sql` creates employees, assigns entries to employees, replaces the company-wide active timer constraint with a per-employee constraint, and removes the obsolete password-session tables. The production database was confirmed empty before this migration, so no legacy entry assignment is required.

Do not apply migration `0002` while the old shared-password Worker must remain operational: the old version expects the session tables that the migration removes.

### 5. Verify the live workflow

1. Open the Worker URL in a private browser window.
2. Confirm Cloudflare redirects to Microsoft and rejects non-firm accounts.
3. Sign in as an employee, choose or create a project, clock in, refresh, and clock out.
4. Add, edit, and delete a manual entry.
5. Confirm Today and This Week totals.
6. Sign in as Alex or Brendon and open History; confirm the employee filter and all-firm records.
7. Download a weekly workbook and inspect employee rows, Brisbane times, daily totals, employee totals, project totals, widths, and print layout in Excel.
8. Send a test email, then repeat it and confirm no duplicate is sent.
9. Inspect **Workers & Pages → timekeeper → Observability** and the `weekly_report_deliveries` records if a delivery fails.

## Environment and bindings

| Binding                     | Storage                      | Required       | Purpose                                              |
| --------------------------- | ---------------------------- | -------------- | ---------------------------------------------------- |
| `DB`                        | Wrangler D1 binding          | Yes            | Users, projects, entries, and delivery audit records |
| `ASSETS`                    | Worker Static Assets binding | Yes            | React application                                    |
| `ACCESS_TEAM_DOMAIN`        | Worker secret                | Production     | Access issuer and signing-key location               |
| `ACCESS_AUD`                | Worker secret                | Production     | Expected Access application audience                 |
| `ALLOWED_EMAIL_DOMAIN`      | Tracked Worker variable      | Yes            | Defense-in-depth company-domain restriction          |
| `ADMIN_EMAILS`              | Tracked Worker variable      | Yes            | Comma-separated reporting administrators             |
| `LOCAL_DEV_IDENTITY_EMAIL`  | Local `.dev.vars` only       | Local optional | Localhost-only development identity                  |
| `RESEND_API_KEY`            | Worker secret                | Email          | Sending-only Resend credential                       |
| `EMAIL_FROM`                | Worker secret                | Email          | Verified report sender                               |
| `WEEKLY_REPORT_RECIPIENT`   | Worker secret                | Email          | Scheduled consolidated-report recipient              |
| `REPORT_TEST_RECIPIENT`     | Worker secret                | Email          | Manual test recipient                                |
| `FYI_ACCESS_ID`             | Worker secret                | FYI sync       | Practice API access identifier                       |
| `FYI_ACCESS_SECRET`         | Worker secret                | FYI sync       | Practice API access secret                           |
| `FYI_APPLICATION_ID`        | Worker secret                | FYI sync       | FYI application identifier                           |
| `FYI_API_BASE_URL`          | Tracked Worker variable      | Yes            | Regional FYI external API base URL                   |
| `RUNNING_TIMER_ALERT_HOURS` | Tracked Worker variable      | Yes            | Admin running-timer exception threshold              |
| `LONG_ENTRY_ALERT_HOURS`    | Tracked Worker variable      | Yes            | Admin completed-entry exception threshold            |

Alex and Brendon are configured as administrators in `wrangler.jsonc`. Changing administrators requires a reviewed configuration change and redeployment; it cannot be self-escalated from the UI.

## Local development

Copy `.env.example` to `.dev.vars`. Use non-production email settings and set `LOCAL_DEV_IDENTITY_EMAIL` to a test address ending in the allowed domain. This local identity is accepted only when the request hostname is `localhost` or `127.0.0.1`; it cannot bypass authentication on the deployed Worker.

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Do not use the production Resend key or recipient during ordinary local work. `.dev.vars` is ignored by Git.

## Weekly report and email schedule

`wrangler.jsonc` defines:

```text
5 14 * * SUN
```

Cloudflare Cron uses UTC. Brisbane is UTC+10 year-round, so Sunday 14:05 UTC is Monday 12:05 AM in Brisbane. The scheduled handler selects the Monday-to-Sunday week that just ended and queries every employee's entries.

Duplicate protection has three layers:

1. D1 permits one delivery record per week and delivery type.
2. A sent record is never claimed again; a failed record can be retried.
3. Resend receives a deterministic idempotency key for the week and delivery type.

The test delivery type is independent of the scheduled type, so a manual test cannot consume the scheduled report record.

## D1 migrations

```powershell
npm run db:migrate:local
npm run db:migrate
```

Timestamps are precise UTC milliseconds in D1. Australia/Brisbane conversion occurs only for display, filters, date allocation, and reports. Decimal or formatted hours are derived summaries; start and end timestamps remain the source of truth.

## Backup and export

Cloudflare D1 Time Travel supports point-in-time recovery. Also take periodic portable exports:

```powershell
npx wrangler d1 export timekeeper --remote --output timekeeper-backup.sql
```

Store exports encrypted outside the repository. Excel reports are useful business records but are not a complete database backup.

## Quality checks

```powershell
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

The tests run inside Cloudflare's `workerd` runtime with real local D1 migrations. They cover Access-protected routes, company-domain enforcement, automatic provisioning, CSRF, per-employee active timers, employee data isolation, admin reporting, duration and Brisbane boundaries, cross-midnight allocation, Excel contents, weekly totals, failed delivery retries, and duplicate-email prevention.
