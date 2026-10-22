# Xero Projects release checklist

This checklist is a gate summary. Use it with [the full runbook](./xero-projects-runbook.md). Checking a box does not grant permission to merge, deploy, close, email or upload; record each approval separately.

## 1. Review and non-deploying validation

- [ ] Release commit and pull request are reviewed; no uncommitted release changes remain.
- [ ] `npm ci` completed with the repository lockfile.
- [ ] `npx wrangler --version` matches the reviewed dependency set.
- [ ] `npm run format` passed.
- [ ] `npm run lint` passed.
- [ ] `npm run typecheck` passed.
- [ ] `npm test` passed with no unexplained skips/flakes.
- [ ] `npm run build` passed and was confirmed to use Wrangler `--dry-run`.
- [ ] Fresh local D1 migration from `0001` through `0011` passed.
- [ ] Desktop/mobile time, review and setup flows were inspected.
- [ ] Representative PDF, CSV and Excel artifacts were rendered and checked.
- [ ] Access, CSRF, role separation, locked-mutation and duplicate-prevention tests passed.

## 2. Staging isolation

- [ ] Staging Worker name differs from production.
- [ ] Staging D1 name and ID differ from production.
- [ ] Staging Access application/audience differs from production.
- [ ] Staging report recipients contain only a safe mailbox.
- [ ] Staging Xero app uses `https://STAGING_HOST/api/projects/oauth/callback` exactly.
- [ ] Xero Demo Company or other non-production organisation will be selected.
- [ ] `XERO_ENABLED=false` before first staged deployment.
- [ ] Connection/outbox processing is paused.

## 3. Migration evidence

- [ ] Cloudflare account and database identity were verified by two people.
- [ ] Remote `d1_migrations` ledger was captured before the change.
- [ ] Pending migration list was captured before the change.
- [ ] Pre-change Time Travel bookmark was captured.
- [ ] Portable D1 export was written outside Git to encrypted storage.
- [ ] Export checksum was recorded.
- [ ] Wrangler applied pending files in numeric order only.
- [ ] `0010_friday_close_and_reports.sql` precedes `0011_xero_projects_workflow.sql`.
- [ ] Post-change pending list is empty.
- [ ] Post-change ledger contains each applied filename exactly once.

## 4. Secrets and configuration

- [ ] No secret value appears in Git, chat, screenshots, logs or release evidence.
- [ ] Configured secret names were listed for the exact target Worker; all applicable Access, email, FYI and Xero names are present.
- [ ] `LOCAL_DEV_IDENTITY_EMAIL` remains local only and is not configured on the deployed Worker.
- [ ] `XERO_CLIENT_ID` is configured as a Worker secret.
- [ ] `XERO_CLIENT_SECRET` is configured as a Worker secret.
- [ ] `XERO_REDIRECT_URI` exactly matches the registered HTTPS callback.
- [ ] Independent 32-byte base64 `XERO_TOKEN_KEY` is vaulted and configured.
- [ ] No obsolete Practice Manager secret was added for the Projects workflow.
- [ ] Existing Access, Resend and FYI secrets remain available.
- [ ] `XERO_REVIEWER_EMAILS`, admin roles and report recipient list were reviewed.
- [ ] `XERO_ENABLED` remains false until smoke checks pass.

## 5. Existing-feature regression

- [ ] Cloudflare Access accepts an authorised firm user and rejects a non-firm user.
- [ ] Employee time isolation still holds.
- [ ] Timer and manual entry preserve actual start/work date and duration.
- [ ] Client-facing description and internal note stay separate.
- [ ] FYI clients/jobs still sync and remain the master data source.
- [ ] Priorities, recurring schedules, history and reports still work.
- [ ] Monday-Sunday dashboard calculations are unchanged.

## 6. Xero connection and mapping

- [ ] Projects was enabled in staging only after smoke checks.
- [ ] OAuth returned to `/api/projects/oauth/callback`.
- [ ] Intended organisation was selected and its exact name typed to confirm.
- [ ] Connection remained paused after confirmation.
- [ ] Full project/task/user catalogue refresh succeeded without partial pages.
- [ ] FYI client-to-Xero-contact mappings were reviewed.
- [ ] FYI job-to-Xero-project/task mappings were reviewed.
- [ ] Employee-to-Xero-user mappings were reviewed.
- [ ] Suzie reviewed pilot task name, charge type, currency and rate.
- [ ] The Billing Review shows the local billable classification, and both billable/non-chargeable mismatch directions require explicit acknowledgement.
- [ ] Cutover date was recorded and signed off.
- [ ] Missing/stale/ambiguous/rate-drift warnings behave as expected.
- [ ] A proven pre-write or definitive rejection can be returned to review; HTTP 408 and every other ambiguous write remain reconciliation-only.

## 7. Friday close and reports

- [ ] Cron expression is exactly `0 10 * * FRI` (Friday 20:00 Brisbane).
- [ ] Existing unrelated cron schedules remain present.
- [ ] Initial activation preview counts were reviewed.
- [ ] Initial activation is an `initial` baseline with historical delivery suppressed.
- [ ] Crossing entries split at Brisbane midnight/cutoff correctly.
- [ ] A crossing running timer leaves exactly one unlocked continuation.
- [ ] Repeated close/recovery processing is idempotent.
- [ ] Locked ordinary edit/delete attempts fail.
- [ ] Audited correction requires reason and source revision.
- [ ] Revised reports create a new immutable version.
- [ ] PDF, CSV and Excel derive from the same versioned snapshot.
- [ ] Per-recipient report delivery state is durable and independently retryable.
- [ ] No manual production close or historical email was used as a smoke test.

## 8. Genuine reviewed-time pilot

- [ ] One authorised, genuine low-risk time entry was chosen at/after cutover.
- [ ] Actual staff/date/start/duration/client/job/task/description were verified.
- [ ] Internal note is absent from Xero preview/payload.
- [ ] Suzie or an admin reviewed exact milliseconds, rounded minutes and delta.
- [ ] Exact preview hash was approved while uploads remained paused.
- [ ] One immutable outbox item was created.
- [ ] Explicit approval was recorded before unpausing.
- [ ] Exactly one remote Xero time-entry ID was accepted.
- [ ] Reprocessing did not create a duplicate.
- [ ] Refreshed remote values match the approval snapshot.
- [ ] Suzie completed the normal Xero invoice/status check.
- [ ] Evidence states that `INVOICED` is not proof of payment.

## 9. Production promotion

- [ ] Separate production migration approval is recorded.
- [ ] Separate production code-deploy approval is recorded.
- [ ] Separate first-close approval is recorded.
- [ ] Separate report-send approval is recorded.
- [ ] Separate Xero-unpause/upload approval is recorded.
- [ ] Production deploy initially retains `XERO_ENABLED=false`.
- [ ] Read-only production smoke checks passed.
- [ ] Production tenant name/ID and full catalogue counts were re-confirmed.
- [ ] Production mappings and cutover were re-approved.
- [ ] Connection remained paused until the approved pilot.
- [ ] First baseline produced no historical emails.
- [ ] Next weekly recipient list was checked before the first live send.

## 10. Monitoring and rollback readiness

- [ ] No close is stuck in `closing`; no report remains `report_failed`.
- [ ] Report and Xero outboxes have no unexplained expired leases.
- [ ] `needs_attention` count is zero or every row has a named owner.
- [ ] OAuth refresh/catalogue logs contain no tokens or internal notes.
- [ ] Previous known-good Worker version ID is recorded.
- [ ] Xero emergency-pause owner is named.
- [ ] Operators know that Worker rollback does not roll back D1.
- [ ] Rollback plan preserves audit, reports, outboxes and locks.
- [ ] No down migration, table drop, ledger edit or blanket unlock is planned.

## Go/no-go sign-off

| Decision                            | Name | Date/time (Brisbane) | Evidence link |
| ----------------------------------- | ---- | -------------------- | ------------- |
| Staging accepted                    |      |                      |               |
| Production migrations approved      |      |                      |               |
| Production code deployment approved |      |                      |               |
| Initial baseline close approved     |      |                      |               |
| Genuine Xero pilot upload approved  |      |                      |               |
| Weekly report sending approved      |      |                      |               |
| Release accepted by Suzie           |      |                      |               |

Any blank required approval is a no-go.
