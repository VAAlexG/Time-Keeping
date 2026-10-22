# Xero Projects reviewed-time runbook

## Purpose and safety boundary

This runbook covers the controlled release and operation of Timekeeper's reviewed-time workflow into Xero Projects. It is deliberately conservative because the workflow can lock time, send immutable weekly reports and create Xero time entries.

The release operator must not treat a successful build as authority to merge, deploy, close a live period, send a report or upload time. Each of those is a separate, recorded decision. The normal safe state is:

- `XERO_ENABLED=false` in a newly prepared environment;
- the Xero connection disconnected or processing paused;
- a separate staging Worker and D1 database;
- a Xero Demo Company or other non-production organisation in staging;
- only a controlled test mailbox in the staging report-recipient list; and
- no production Friday-close activation until the release owner explicitly approves it.

FYI remains the source of truth for practice clients and jobs. The existing FYI synchronisation, stable FYI identifiers and historic snapshots must be retained. Xero Projects is a downstream, reviewed-time destination: client-to-contact, job-to-project/task and employee-to-Xero-user links are explicit mappings. Timekeeper does not create Xero projects or tasks and never writes back to FYI.

## Named owners

Record real names in the release ticket before starting:

| Responsibility                                   | Required owner                                  |
| ------------------------------------------------ | ----------------------------------------------- |
| Release and Cloudflare operator                  | Alex or Brendon                                 |
| Xero organisation and project/task confirmation  | Alex or Brendon                                 |
| Billing review, cutover and invoice/status check | Suzie                                           |
| Independent post-release check                   | A second person who did not execute the release |

No person should approve their own unreviewed production upload.

## Prerequisites

### Isolated staging

Before a remote test, configure a Wrangler `staging` environment with all of the following:

1. A Worker name distinct from production.
2. A new D1 database, for example `timekeeper-staging`, with a different database ID from `timekeeper`.
3. A distinct Cloudflare Access application/audience for the staging hostname.
4. A safe Resend recipient controlled by the release team. Do not include the normal Alex/Brendon/Suzie distribution in staging.
5. A Xero OAuth web app whose staging redirect URI is the staging host plus the exact path `/api/projects/oauth/callback`.
6. A Xero Demo Company, or another organisation that cannot affect live billing, selected as the staging tenant.

Wrangler environment bindings are non-inheritable in important cases. Inspect the resolved staging configuration and stop if its D1 database ID, Worker name or hostname matches production. Never point a preview or staging Worker at the production D1 database.

### Xero application

Create a server-side OAuth 2.0 web application in the Xero developer portal. Register the complete HTTPS URI exactly; Xero does not support redirect-URI wildcards:

```text
https://YOUR-TIMEKEEPER-HOST/api/projects/oauth/callback
```

The deployed value of `XERO_REDIRECT_URI` must be byte-for-byte the same URI. It must have no query string, fragment, credentials or alternate path. The application requests exactly `openid profile email offline_access projects accounting.contacts.read`. Xero tenant data uses an organisation connection selected after OAuth; confirm the intended Projects organisation by its exact name and tenant ID.

The application encrypts rotating OAuth tokens in D1 with a dedicated 32-byte `XERO_TOKEN_KEY`. Historical Practice Manager migration tables remain for compatibility, but this Worker workflow does not require or activate a legacy Practice Manager secret.

Primary references: [Xero OAuth 2.0 overview](https://developer.xero.com/documentation/guides/oauth2/overview), [Xero tenant connections](https://developer.xero.com/documentation/guides/oauth2/tenants), [Xero token types](https://developer.xero.com/documentation/guides/oauth2/token-types), [Xero Projects API](https://developer.xero.com/documentation/api/projects/overview).

### Cloudflare and email

- Use the repository's pinned Wrangler version and authenticate the intended Cloudflare account.
- Confirm Cloudflare Access protects both the staging and production hostnames.
- Confirm the Resend sending domain and `EMAIL_FROM` identity are verified.
- Confirm D1 Time Travel support with `npx wrangler d1 info <DATABASE_NAME>`.
- Keep encrypted portable database exports outside the repository.

Cloudflare Cron expressions run in UTC. `0 10 * * FRI` is Friday 20:00 in Brisbane (UTC+10, with no daylight-saving change). See [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Configuration and secrets

### Non-secret controls

Review these tracked variables for each environment:

| Name                       | Safe initial value or rule                                                     |
| -------------------------- | ------------------------------------------------------------------------------ |
| `XERO_ENABLED`             | `false` until the environment has passed migrations and smoke checks           |
| `XERO_REVIEWER_EMAILS`     | Suzie's authorised firm address; admins remain reviewers                       |
| `WEEKLY_REPORT_RECIPIENTS` | staging: one safe mailbox; production: the approved, deduplicated distribution |
| `ADMIN_EMAILS`             | Alex and Brendon only unless a reviewed access change is approved              |
| `REPORT_VIEWER_EMAILS`     | narrow report access, including Suzie as currently approved                    |
| `ALLOWED_EMAIL_DOMAIN`     | the firm domain                                                                |

Enabling `XERO_ENABLED` makes the Projects feature available, but it must not itself unpause an existing connection. Selecting an organisation starts the connection in the paused state. Treat both controls as required: enabled **and** explicitly unpaused.

### Secret names

The Xero Projects flow requires:

- `XERO_CLIENT_ID`
- `XERO_CLIENT_SECRET`
- `XERO_REDIRECT_URI`
- `XERO_TOKEN_KEY`

Existing platform functions also rely on:

- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `WEEKLY_REPORT_RECIPIENT`
- `REPORT_TEST_RECIPIENT`
- `FYI_ACCESS_ID`
- `FYI_ACCESS_SECRET`
- `FYI_APPLICATION_ID` when issued by FYI

`wrangler.jsonc` intentionally does not declare `secrets.required`. When that property is present, Wrangler excludes unlisted `.dev.vars` keys, including Timekeeper's localhost-only identity and optional FYI application ID; it would also block preparation of an intentionally Xero-disabled Worker version before Projects credentials exist. The application fails closed when a required credential is unavailable, but that does not replace the release gate: before uploading or deploying a version, list the configured secret **names** for the exact staging or production Worker and confirm every applicable name above. Never inspect, copy or record secret values.

Never put values in Git, a release ticket, terminal history, chat, screenshots or logs. Enter them only at Wrangler's hidden prompt or through the Cloudflare dashboard's encrypted-secret control. `wrangler secret put` creates and immediately deploys a new Worker version; use it only inside an approved deployment window. `wrangler versions secret put` creates a version without routing traffic and is safer while preparing a release. See [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Commands intentionally show names only:

```powershell
npx wrangler versions secret put XERO_CLIENT_ID --env staging
npx wrangler versions secret put XERO_CLIENT_SECRET --env staging
npx wrangler versions secret put XERO_REDIRECT_URI --env staging
npx wrangler versions secret put XERO_TOKEN_KEY --env staging
```

During an approved production change window, omit `--env staging` only after confirming the active Cloudflare account, Worker name and production release ticket.

### Generate `XERO_TOKEN_KEY` locally

Generate 32 random bytes locally, pass the base64 text directly to Wrangler through standard input and remove the shell variables. Do not print or save the key:

```powershell
$xeroTokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($xeroTokenBytes)
$xeroTokenKey = [Convert]::ToBase64String($xeroTokenBytes)
$xeroTokenKey | npx wrangler versions secret put XERO_TOKEN_KEY --env staging
Remove-Variable xeroTokenKey, xeroTokenBytes
```

Store the production key in the practice's approved secrets vault. Losing or replacing it makes the stored token envelope unreadable and requires a controlled Xero reconnect.

## Non-deploying validation

Run from a clean checkout of the reviewed release commit. These checks do not authorise a deployment:

```powershell
npm ci
npx wrangler --version
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

In this repository, `npm run build` builds the client and invokes Wrangler with `--dry-run`; verify that script still contains `--dry-run` before running it. Save the commit SHA, tool versions and complete pass/fail result in the release ticket. Any ignored, skipped or flaky test needs an explicit disposition.

Also apply all migrations to a disposable local database from zero and run the tests against it:

```powershell
npm run db:migrate:local
```

Review the rendered desktop and mobile workflow, one representative PDF, CSV and Excel workbook, and accessibility checks before a remote staging change.

## D1 migration procedure

### Required order

The configured migration directory is `migrations-d1`. A new database receives these files in this exact order:

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

Never rename an applied migration, edit its remote ledger entry or manually replay its SQL. On an existing database, apply only the files Wrangler reports as pending. `0010` must precede `0011`: it introduces revisioned/locked time segments and immutable report infrastructure used by the reviewed-time workflow.

Cloudflare records applied filenames in `d1_migrations`, applies remaining files sequentially and rolls back a migration that errors. Cloudflare also captures a backup when migrations are applied. See [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) and [Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/).

### Staging

First prove that the names resolve to a distinct staging database:

```powershell
npx wrangler whoami
npx wrangler d1 info timekeeper-staging --env staging
npx wrangler d1 migrations list timekeeper-staging --remote --env staging
npx wrangler d1 execute timekeeper-staging --remote --env staging --command "SELECT * FROM d1_migrations ORDER BY id;"
```

Capture a Time Travel bookmark and an encrypted portable export before applying pending migrations:

```powershell
npx wrangler d1 time-travel info timekeeper-staging --env staging
npx wrangler d1 export timekeeper-staging --remote --env staging --output "<ENCRYPTED_BACKUP_DIRECTORY>\timekeeper-staging-before-xero-projects.sql"
```

Apply, then re-check both the ledger and the pending list:

```powershell
npx wrangler d1 migrations apply timekeeper-staging --remote --env staging
npx wrangler d1 migrations list timekeeper-staging --remote --env staging
npx wrangler d1 execute timekeeper-staging --remote --env staging --command "SELECT * FROM d1_migrations ORDER BY id;"
```

Expected result: no pending migrations, exactly one ordered ledger row for every applied filename, and both `0010_friday_close_and_reports.sql` and `0011_xero_projects_workflow.sql` present. Keep the bookmark and export checksum with the release evidence; do not store the export in Git.

### Production

Repeat the same procedure with the immutable production database name `timekeeper`, but only during an approved change window:

```powershell
npx wrangler whoami
npx wrangler d1 info timekeeper
npx wrangler d1 migrations list timekeeper --remote
npx wrangler d1 execute timekeeper --remote --command "SELECT * FROM d1_migrations ORDER BY id;"
npx wrangler d1 time-travel info timekeeper
npx wrangler d1 export timekeeper --remote --output "<ENCRYPTED_BACKUP_DIRECTORY>\timekeeper-before-xero-projects.sql"
```

Have the second operator verify the account, database ID, bookmark and export checksum. Only then:

```powershell
npx wrangler d1 migrations apply timekeeper --remote
npx wrangler d1 migrations list timekeeper --remote
npx wrangler d1 execute timekeeper --remote --command "SELECT * FROM d1_migrations ORDER BY id;"
```

Do not combine migration approval with approval to deploy Worker code.

## Staged release sequence

1. **Prepare without traffic.** Keep `XERO_ENABLED=false`. Apply migrations to staging and upload a Worker version without routing production traffic. A Worker version does not version or roll back D1.
2. **Smoke-test staging identity and existing features.** Confirm Access login, employee isolation, timer/manual entry, FYI client/job selection, priorities, schedules, history and existing reports still work.
3. **Enable Projects in staging only.** Change staging `XERO_ENABLED` to `true` in a reviewed configuration version. Keep report recipients safe and processing paused.
4. **Authorise Xero.** From an authenticated Alex/Brendon admin session, start OAuth. Select the Xero Demo organisation. Type the displayed organisation name exactly to confirm it. Record the non-secret tenant name and tenant ID in release evidence. Never confirm by position in a list.
5. **Refresh the catalogue.** Verify the complete project, task and Xero-user counts. Spot-check first and last pages and archived/closed handling. A partial catalogue is a stop condition.
6. **Create explicit mappings.** Link FYI client to Xero contact, FYI job to one Xero project/task and each participating employee to the matching Xero user. Resolve email mismatches rather than overriding them casually.
7. **Review rates and task types.** Suzie confirms every pilot task's name, charge type, currency and rate. The review shows Timekeeper's local billable classification separately and requires an explicit acknowledgement when billable time points to a `NON_CHARGEABLE` task, or non-billable time points to a `TIME`/`FIXED` task. A stale catalogue, rate drift, missing map or ambiguous duplicate remains visible and blocks or warns as designed.
8. **Set the cutover.** Suzie and an admin agree the first work date eligible for Xero upload. Record it in the release ticket. Once an approval exists, treat the cutover as frozen.
9. **Exercise the Friday baseline in staging.** Preview first. The first activation establishes a baseline through the latest Friday 20:00 Brisbane cutoff, locks/splits covered time and stores an immutable snapshot, but suppresses all historical report email. Verify no historical delivery row was sent. Do not perform this step in production without separate close approval.
10. **Run the approved pilot below.** Do not broadly unpause uploads.
11. **Promote production separately.** Reconfirm recipients, callback host, tenant and D1 identity. Deploy code with `XERO_ENABLED=false`, smoke-test, then enable connection setup in a second reviewed change. Keep uploads paused until the production mappings and cutover have been signed off.

## One genuine approved pilot

The integration is not accepted on mocked responses alone. Run one controlled, genuine entry end to end with explicit authorisation:

1. Choose one real, low-risk piece of client work at or after the agreed cutover. Record the actual staff member, work date, actual start time, duration, mapped client/job/task and client-facing description. Keep the internal note private; it must never appear in the Xero payload.
2. Close the applicable staging period, or use the separately approved production close when the release owner has authorised it. Confirm the entry is locked and the snapshot contains exact source milliseconds.
3. As Suzie (or an admin reviewer), preview the upload and inspect tenant, staff, project, task, description, exact duration, rounded integer minutes, rounding delta, current rate and all warnings.
4. Approve the exact preview hash. Approval must persist an immutable source/mapping/payload snapshot before any network write.
5. Unpause only after the approval record exists. Process the one queued outbox item.
6. Confirm exactly one Xero time entry ID is recorded, the request payload hash is unchanged, and the row is `provider_accepted`. Re-run processing and confirm it does not create another Xero time entry.
7. Refresh status from Xero and compare staff, task, date, description and integer minutes with the approval snapshot. Any timeout or ambiguous response goes to `needs_attention`; inspect Xero before retrying.
8. Suzie performs the ordinary invoice workflow in Xero and then refreshes billing status in Timekeeper. Confirm the raw Xero status and the application's billing label are both visible.

`INVOICED` means Xero associates the time with invoicing; it is **not proof that the invoice has been authorised, sent or paid**. Payment reconciliation remains in Xero and is outside this workflow.

Xero retains API idempotency keys for only six minutes. Resend retains email idempotency keys for 24 hours. The D1 approval/outbox records, immutable payload hashes, remote IDs and terminal states are therefore the long-lived duplicate-prevention source of truth; provider idempotency is only an additional short-window safeguard. See [Xero idempotent requests](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/) and [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

## Friday-close operation

The close period is independent from the Monday-Sunday dashboard week. Each scheduled period is the half-open interval from the previous Friday 20:00 Brisbane cutoff up to, but not including, the current Friday 20:00 cutoff. The required Cron Trigger is:

```text
0 10 * * FRI
```

Before enabling it in production:

- confirm the existing non-close cron jobs remain present;
- confirm the scheduled handler recognises the exact expression above;
- preview the initial activation and record entry/split/running-continuation counts;
- confirm the first activation is marked `initial` with delivery suppressed;
- confirm the distribution list is correct before the next non-suppressed weekly close; and
- never use the manual close merely to test a button in production.

The initial baseline may lock historical records and split entries or a running timer at the cutoff. It must create exactly one unlocked continuation for a running timer. It must not email historical reports. Later scheduled runs recover every missed Friday in order and are idempotent for an already-closed cutoff.

A manual close requires a preview, explicit ISO cutoff confirmation and a reason. It is an operational write, not a smoke test.

## Smoke checks

Run these after each staged deployment and again, read-only, after production promotion:

### Existing application

- Access rejects a non-firm account and accepts the authorised firm account.
- Alex and Brendon have admin controls; Suzie has billing/report review without admin data-management rights.
- A staff user can see and mutate only their own unlocked time.
- Both timer and manual entry require actual work date/start time and retain separate client description/internal note.
- FYI clients and jobs still load; Xero setup does not rename, archive or replace them.
- Monday-Sunday dashboard totals remain unchanged by Friday close boundaries.

### Close and reports

- Close preview is read-only and shows crossing/running splits.
- Locked time rejects ordinary edit/delete routes.
- The audited correction route requires a reason and optimistic revision, produces a new report version and does not blanket-unlock the period.
- PDF, CSV and Excel share the same report/version snapshot and hashes.
- CSV and Excel retain original Unicode. If the compact embedded Archivo PDF fonts do not contain a character, the PDF shows its reversible `[U+CODEPOINT]` value instead of failing the close or silently dropping text.
- Each approved recipient has one delivery row; retries never create a second terminal accepted delivery.
- A provider-accepted email is labelled provider accepted, not delivered-to-inbox.

### Xero Projects

- The selected tenant is the intended organisation.
- Connection is paused after tenant confirmation.
- Catalogue counts and last-success time are present.
- Mapping screens do not expose cross-tenant or stale IDs.
- Internal notes are absent from preview payloads and Xero.
- Approving while paused creates durable queue state without a network upload.
- Cancellation only affects unsent approval items.
- A correction invalidates/cancels unsent work and flags already accepted source drift without deleting history.

## Monitoring and incident triage

Use the admin UI first. The following remote SQL is read-only and may be used during an incident after confirming the database name. Avoid copying snapshot JSON, email addresses, descriptions or encrypted tokens into tickets.

```powershell
npx wrangler d1 execute timekeeper --remote --command "SELECT activated_at, closed_through, updated_at FROM close_control WHERE id=1;"
npx wrangler d1 execute timekeeper --remote --command "SELECT id, kind, status, cutoff_at, entry_count, total_ms, suppress_delivery, updated_at FROM close_periods ORDER BY cutoff_at DESC LIMIT 8;"
npx wrangler d1 execute timekeeper --remote --command "SELECT state, COUNT(*) AS count FROM report_delivery_outbox GROUP BY state ORDER BY state;"
npx wrangler d1 execute timekeeper --remote --command "SELECT state, COUNT(*) AS count FROM xero_projects_upload_outbox GROUP BY state ORDER BY state;"
npx wrangler d1 execute timekeeper --remote --command "SELECT id, state, projects_count, tasks_count, users_count, error_code, started_at, finished_at FROM xero_projects_catalog_runs ORDER BY started_at DESC LIMIT 10;"
npx wrangler d1 execute timekeeper --remote --command "SELECT connected, paused, tenant_id, tenant_name, expires_at, throttle_until, catalogue_revision, mapping_revision, updated_at FROM xero_projects_connection WHERE id=1;"
```

Normal operational states:

- `queued`, `leased` and `retry_wait` are non-terminal and should progress under the outbox processor;
- `provider_accepted` means the provider accepted the exact immutable request;
- `failed` means a classified failure is awaiting the application's retry policy or operator action;
- `needs_attention` means automated retry must stop until a human reconciles provider state; and
- `cancelled` means an approved upload was deliberately returned for a fresh review only after Timekeeper proved that no Xero write was created. This includes queued/pre-write outcomes and definitive provider rejection; the audit stores the prior outcome evidence.

Alert on a close stuck in `closing`, a report in `report_failed`, expired leases, growing retry counts, any `needs_attention`, repeated OAuth refresh failures, catalogue failures, tenant mismatch, rate/mapping drift or a scheduled close that does not appear after the cutoff. Use Workers Observability with structured event fields; never log OAuth tokens, encryption keys, full report bytes or internal notes.

For an ambiguous Xero write, leave the item in `needs_attention`, search Xero using the intended project/user/task/date and compare the exact description and rounded minutes. Attach the existing remote ID if one matching entry exists. Do not generate a fresh idempotency key and blindly retry after Xero's six-minute window.

HTTP `408`, lost responses, expired in-flight leases and unreadable successful responses are ambiguous writes. They cannot use **Return to review**; reconciliation is mandatory.

For an ambiguous report email, inspect the Resend message log and the stored provider ID. Because Resend's idempotency window is only 24 hours, do not clear the D1 terminal/attention state to force a resend.

## Pause, disconnect and key rotation

### Emergency pause

1. Use the admin control to pause Xero processing. Confirm `paused=1` in the safe connection-status view.
2. Set `XERO_ENABLED=false` in a reviewed Worker configuration if the entire Projects surface must fail closed.
3. Leave approvals, outbox rows, reports, locks and audit tables intact.
4. Do not revoke the Xero connection until an ambiguous in-flight write has been reconciled.

Pausing Xero must not stop ordinary time entry, FYI catalogue synchronisation, Friday locks or report retention. If report delivery also needs to stop, treat that as a separate incident and change; do not infer it from the Xero pause.

### Disconnect

Disconnect only after processing is paused and no lease is active. Use the application disconnect action and, where incident policy requires it, remove the connection in Xero's Connected Apps. Preserve the local tenant name/ID, approvals, accepted remote IDs, status history and audit trail. A reconnect must repeat exact organisation confirmation; never silently bind to the first returned tenant.

### Rotate `XERO_TOKEN_KEY`

There is no safe value-only rotation of the AES key around an existing encrypted token envelope. Use this sequence:

1. Pause processing and reconcile every leased or ambiguous outbox item.
2. Disconnect/revoke the Xero OAuth connection while retaining local history.
3. Generate a new independent 32-byte key and place it in the approved secrets vault.
4. Set `XERO_TOKEN_KEY` through an approved version/configuration change.
5. Reauthorise, select and type-confirm the same organisation.
6. Refresh the full catalogue and revalidate tenant-bound mappings before unpausing.

Do not alter or delete historical Practice Manager data as part of this procedure; it is outside the Projects token-key rotation.

## Rollback

### Worker rollback

1. Pause Xero uploads first if the new UI/API is still reachable.
2. Record the current and prior Worker version IDs with `npx wrangler deployments list`.
3. Use the Cloudflare dashboard or `npx wrangler rollback <KNOWN_GOOD_VERSION_ID>` only with explicit incident approval. A Wrangler rollback immediately changes live traffic.
4. Verify Access, time entry, locks and read-only reports after rollback.

Cloudflare Worker versions do not include D1 state. Older code may not understand newer schema or lock rules; evaluate compatibility before rollback. See [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

### Database recovery

Do **not** drop `close_*`, `report_*` or `xero_projects_*` tables, delete outbox rows, clear locks, rewrite migration ledger rows or run a blanket unlock. The migrations are intentionally forward-only, and the audit/report/upload records are business evidence.

D1 Time Travel is a destructive, whole-database restore. It can erase legitimate time and audit changes made after the restore point, so use it only for a confirmed database incident with executive approval, an export of the current damaged state and a reconciliation plan. Retrieve a bookmark before and after any restore. See [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/).

The preferred rollback for an integration fault is code rollback plus `XERO_ENABLED=false`/paused processing while retaining the additive schema and all immutable records.

## Evidence required for production acceptance

Retain these items without secrets or personal report content:

- reviewed commit SHA and pull-request approval;
- exact check commands and passing output summary;
- desktop/mobile and report-render evidence;
- staging/production Worker names, D1 IDs and migration-ledger filenames;
- pre-migration Time Travel bookmark and encrypted-export checksum;
- Xero app name, exact callback URI, selected tenant ID/name and catalogue counts;
- mapping and cutover sign-off by Suzie and an admin;
- initial baseline preview/result showing `suppress_delivery=1` and no historical email;
- genuine pilot approval ID, immutable payload hash, outbox ID, one remote time-entry ID and refreshed raw status;
- report version/hash and per-recipient provider-accepted state for the first authorised live weekly close; and
- an incident owner and rollback version ID.

Never include tokens, secrets, encrypted token blobs, report bytes, client-facing descriptions or internal notes in release evidence.
