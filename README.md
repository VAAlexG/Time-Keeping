# Timekeeper

Timekeeper is Versatile Accounting's private Cloudflare Workers application for staff time, priorities, recurring work, immutable weekly records, and reviewed export to Xero Projects.

FYI is the read-only source of truth for clients and jobs. Xero Projects is a separate downstream destination for time that has been locked, reviewed, and explicitly approved. Timekeeper never creates or edits FYI clients/jobs and does not create Xero projects or tasks.

> **Release status:** repository code and configuration do not prove that a Worker has been deployed, FYI or Xero has been connected, a Friday close has run, a report has been emailed, or time has been uploaded. Those are separately authorised production actions. Follow [the production runbook](./docs/xero-projects-runbook.md) and [release checklist](./docs/xero-projects-release-checklist.md).

## What the application does

- Authenticates firm users with Microsoft Entra ID through Cloudflare Access and verifies Access JWTs again in the Worker.
- Gives each employee one independently persisted running timer plus manual time entry using an actual Brisbane work date, start time, and duration.
- Records client work against FYI client/job snapshots, or non-billable internal work against controlled internal activities.
- Keeps client-facing descriptions separate from private internal notes.
- Preserves immutable historical labels and external IDs when FYI data is renamed or archived.
- Keeps staff time isolated; Alex and Brendon are administrators, while Suzie has report and Xero billing-review access without general admin access.
- Provides priorities, recurring schedules, history, exception monitoring, and calendar/dashboard summaries.
- Uses Monday-to-Sunday periods for dashboard, calendar, and ordinary exports.
- Closes time independently at Friday 20:00 Brisbane, splitting entries at Brisbane midnight and the close boundary where required.
- Prevents normal edit/delete operations on locked time. An administrator can make a reasoned, revision-checked correction that is audited and creates a new immutable report version.
- Produces PDF, CSV, and XLSX artifacts from the same versioned close snapshot.
- Queues one durable email-delivery item per approved recipient so retrying one address cannot duplicate another recipient's terminal send.
- Maps FYI clients/jobs and employees to a locally cached Xero Projects catalogue, lets Suzie or an administrator review the exact upload preview, and queues only explicitly approved immutable payloads.
- Tracks the Xero provider response and billing status without treating `INVOICED` as proof that an invoice was authorised, sent, or paid.

## Architecture

| Layer          | Implementation                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface      | React, TypeScript, Vite, and Archivo, served through Worker Static Assets                                                                     |
| API            | Hono on Cloudflare Workers                                                                                                                    |
| Identity       | Microsoft Entra ID through Cloudflare Access, with Worker-side JWT/domain validation                                                          |
| Data           | Cloudflare D1; UTC milliseconds are the source of truth and Australia/Brisbane is the display/reporting timezone                              |
| Practice data  | Nightly read-only FYI API synchronisation, plus validated admin CSV fallback                                                                  |
| Closed reports | Versioned D1 snapshots and PDF/CSV/XLSX artifacts                                                                                             |
| Email          | Resend HTTPS API with a durable per-recipient D1 outbox                                                                                       |
| Xero           | Server-side OAuth 2.0, encrypted rotating tokens, cached Projects catalogue, explicit mappings, review approvals, and a durable upload outbox |

Cloudflare Access is the outer boundary; the Worker still verifies identity, company domain, CSRF protection, employee ownership, and role permissions. Never expose the Worker API without the Access application and its matching validation values.

## Time periods and schedules

Dashboard and calendar weeks remain **Monday through Sunday**. The immutable close period is a separate half-open interval ending every **Friday at 20:00 Australia/Brisbane**.

Cloudflare Cron expressions are UTC. The tracked schedules are:

| Cron           | Brisbane purpose                                                        |
| -------------- | ----------------------------------------------------------------------- |
| `0 10 * * FRI` | Friday 20:00 close, immutable report generation, and recipient queueing |
| `5 14 * * SUN` | Monday 00:05 delivery of the completed Monday-Sunday weekly report      |
| `5 14 * * *`   | 00:05 recurring-schedule generation                                     |
| `15 16 * * *`  | 02:15 FYI client/job synchronisation                                    |
| `*/10 * * * *` | Interrupted/missed close recovery plus durable report/Xero outboxes     |

The first approved close activation establishes a baseline through the latest cutoff and suppresses historical report email. Later scheduled closes recover missed Friday cutoffs in order and are idempotent. A manual close requires a preview, exact cutoff confirmation, and reason; it is not a production smoke-test action.

## FYI client and job data

FYI remains authoritative. Timekeeper stores stable FYI external IDs, active/archive state, codes, manager/partner metadata, and the immutable snapshots needed for historic entries. Archived records remain visible in history but cannot be selected for new time.

The normal source is a nightly, read-only API sync. Administrators can run **Sync FYI now** or use the validated client/job CSV import during initial setup or an FYI outage. Configure these values without committing credentials:

- `FYI_API_BASE_URL` — tracked variable; currently the AP Southeast FYI external API base URL.
- `FYI_ACCESS_ID` — Worker secret.
- `FYI_ACCESS_SECRET` — Worker secret.
- `FYI_APPLICATION_ID` — Worker secret when issued/required by FYI.

Migration filenames `0005_xero_practice_manager.sql` and `0009_xero_accounting_verification.sql` preserve earlier connector history and compatibility. They do not change FYI's role as the current master-data source.

## Xero Projects reviewed-time workflow

The Projects integration is fail-closed by default:

- `XERO_ENABLED=false` in tracked configuration until a reviewed environment is ready.
- A newly selected organisation remains paused until an authorised operator explicitly unpauses processing.
- The OAuth callback must exactly match:

  ```text
  https://YOUR-TIMEKEEPER-HOST/api/projects/oauth/callback
  ```

- The OAuth request uses exactly `openid profile email offline_access projects accounting.contacts.read`.
- FYI clients map to Xero contacts; FYI jobs map to a Xero project/task; employees map to Xero users.
- Only locked client time can enter billing review. The reviewer approves an exact preview hash covering source revision, mappings, duration rounding, rate metadata, and payload.
- Internal notes are never included in the Xero payload.
- Approvals and upload records remain durable even when processing is paused. Ambiguous writes stop for human reconciliation instead of being blindly retried.
- Correcting locked source time cancels or invalidates unsent work and flags already accepted uploads as drift; it never erases the audit trail.

`XERO_TOKEN_KEY` must be a dedicated base64-encoded 32-byte key. Changing or losing it makes the current token envelope unreadable and requires a controlled Xero reconnect. The historical Practice Manager migrations do not require a legacy Xero secret for this workflow.

Use [the Xero Projects runbook](./docs/xero-projects-runbook.md) for staging isolation, OAuth setup, exact organisation confirmation, mapping review, cutover, a genuine one-entry pilot, monitoring, pause/disconnect, key rotation, and rollback.

## Configuration and secrets

Tracked non-secret values live in `wrangler.jsonc`; local placeholders live in `.dev.vars.example` and `.env.example`. Secret values must be entered through an approved Cloudflare secret workflow and must never be placed in Git, chat, screenshots, logs, or command arguments.

The Wrangler configuration deliberately does not use `secrets.required`: Cloudflare excludes unlisted `.dev.vars` keys when that setting is present, which would suppress the localhost-only identity and optional FYI application ID, and it would prevent an intentionally Xero-disabled version from being prepared before Projects credentials exist. Runtime checks fail closed when credentials are missing. The release checklist therefore requires an operator to verify the applicable Access, email, FYI and Xero secret names before any staged or production promotion.

| Name                                   | Kind                  | Purpose                                                    |
| -------------------------------------- | --------------------- | ---------------------------------------------------------- |
| `DB`                                   | D1 binding            | Application, audit, reports, catalogues, and outboxes      |
| `ASSETS`                               | Static Assets binding | React application                                          |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`     | Secrets               | Cloudflare Access issuer/key location and audience         |
| `ALLOWED_EMAIL_DOMAIN`                 | Variable              | Company-domain restriction                                 |
| `ADMIN_EMAILS`                         | Variable              | Administrators; currently Alex and Brendon                 |
| `REPORT_VIEWER_EMAILS`                 | Variable              | Report viewers; currently Suzie                            |
| `WEEKLY_REPORT_RECIPIENTS`             | Variable              | Explicit deduplicated weekly distribution list             |
| `LOCAL_DEV_IDENTITY_EMAIL`             | Local only            | Localhost-only development identity                        |
| `RESEND_API_KEY`, `EMAIL_FROM`         | Secrets               | Report email provider and verified sender                  |
| `WEEKLY_REPORT_RECIPIENT`              | Secret                | Legacy fallback recipient                                  |
| `REPORT_TEST_RECIPIENT`                | Secret                | Safe manual-test mailbox                                   |
| `FYI_API_BASE_URL`                     | Variable              | FYI external API base URL                                  |
| `FYI_ACCESS_ID`, `FYI_ACCESS_SECRET`   | Secrets               | FYI read-only API credentials                              |
| `FYI_APPLICATION_ID`                   | Secret/optional       | FYI application identifier when supplied                   |
| `XERO_ENABLED`                         | Variable              | Global Projects feature gate; defaults to `false`          |
| `XERO_REVIEWER_EMAILS`                 | Variable              | Additional billing reviewers; currently Suzie              |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | Secrets               | Xero OAuth application credentials                         |
| `XERO_REDIRECT_URI`                    | Secret                | Exact HTTPS callback ending `/api/projects/oauth/callback` |
| `XERO_TOKEN_KEY`                       | Secret                | Independent 32-byte encryption key for Projects tokens     |
| `RUNNING_TIMER_ALERT_HOURS`            | Variable              | Running-timer exception threshold                          |
| `LONG_ENTRY_ALERT_HOURS`               | Variable              | Completed-entry exception threshold                        |

Changing roles, recipients, feature gates, bindings, or callbacks is a reviewed configuration change. Setting a secret, applying a remote migration, deploying, closing a period, sending email, and unpausing Xero are separate operational actions.

## Local development

Node.js 22 or later is required. Create a local-only configuration, migrate the local D1 database, and start the app:

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Set `LOCAL_DEV_IDENTITY_EMAIL` to a test address in the allowed domain. It is honoured only for `localhost`/`127.0.0.1`. Keep `XERO_ENABLED=false`, use a safe test recipient, and do not copy production secrets into ordinary local development.

## D1 migrations

Migrations are forward-only and apply in filename order from `migrations-d1`:

1. `0001_initial.sql`
2. `0002_employee_identity.sql`
3. `0003_practice_time.sql`
4. `0004_priorities.sql`
5. `0005_xero_practice_manager.sql`
6. `0006_daily_report_delivery.sql`
7. `0007_finalized_reports_and_priority_descriptions.sql`
8. `0008_recurring_schedule.sql`
9. `0009_xero_accounting_verification.sql`
10. `0010_friday_close_and_reports.sql`
11. `0011_xero_projects_workflow.sql`

`0010` introduces revisioned locks, close periods, immutable report versions/artifacts, and the delivery outbox. `0011` adds the Xero Projects OAuth/catalogue, mappings, review snapshots, upload outbox, and audit data.

Do not rename or edit an applied migration, change the remote ledger, drop the additive audit tables, or blanket-unlock records. Before any authorised remote migration, identify the exact account/database, inspect pending migrations, capture a Time Travel bookmark and encrypted export, then follow the runbook's two-person procedure.

## Quality checks

The normal non-deploying validation sequence is:

```powershell
npm ci
npx wrangler --version
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run build` builds the client and runs `wrangler deploy --dry-run`; it does not publish the Worker. Tests run against the Cloudflare `workerd` runtime and a fresh local D1 migration set. They cover authentication/authorization, employee isolation, Brisbane boundaries, locking and splits, corrections, versioned report artifacts, per-recipient delivery, and the reviewed Xero workflow.

Also inspect desktop/mobile flows and representative PDF, CSV, and XLSX artifacts before a release. Passing checks do not authorise a merge, deployment, remote migration, close, email, or Xero upload.

## Production operations

Production preparation and activation are deliberately not reduced to a copy-paste deploy command here. Use:

- [Xero Projects runbook](./docs/xero-projects-runbook.md) for staging, backups, migration evidence, secrets, callbacks, Friday-close activation, the genuine pilot, monitoring, incidents, and rollback.
- [Release checklist](./docs/xero-projects-release-checklist.md) for independent approvals and acceptance evidence.

Keep `XERO_ENABLED=false` and processing paused until those gates are satisfied. A Worker rollback does not roll back D1, and D1 Time Travel is a whole-database recovery operation rather than a routine application rollback.
