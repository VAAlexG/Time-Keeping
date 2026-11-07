import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  finalizeCloseAmendmentWindow,
  getCurrentCloseAmendment,
  openCloseAmendmentWindow,
  recoverFinalizingCloseAmendments,
} from '../server/close-amendments';
import { D1TimeStore } from '../server/d1-store';
import { correctLockedEntry, runScheduledFridayCloses } from '../server/friday-close';
import { buildWeeklyWorkbook } from '../server/report';
import { createApp } from '../worker';
import type { AccessIdentity } from '../worker/access';
import type { Env } from '../worker/env';

const ADMIN = '10000000-0000-4000-8000-000000000001';
const OWNER = '10000000-0000-4000-8000-000000000002';
const OTHER = '10000000-0000-4000-8000-000000000003';
const PERIOD = '20000000-0000-4000-8000-000000000001';
const BASELINE_REPORT = '30000000-0000-4000-8000-000000000001';
const PROJECT = '40000000-0000-4000-8000-000000000001';
const LOCKED_ENTRY = '50000000-0000-4000-8000-000000000001';
const TRAINING = '00000000-0000-4000-8000-000000000002';

const COVERAGE_FROM = Date.parse('2026-10-30T10:00:00.000Z'); // Friday 20:00 Brisbane
const CUTOFF_AT = Date.parse('2026-11-06T10:00:00.000Z'); // Friday 20:00 Brisbane
const NOW = new Date('2026-11-07T02:00:00.000Z');
const EXPIRES_AT = new Date('2026-11-08T02:00:00.000Z');
const NEXT_CUTOFF = Date.parse('2026-11-13T10:00:00.000Z');
const NEXT_NOW = new Date('2026-11-14T02:00:00.000Z');
const RECIPIENTS = [
  'alexg@versatileaccounting.com.au',
  'brendong@versatileaccounting.com.au',
  'suzieg@versatileaccounting.com.au',
];
const INTERNAL_WORK = {
  workType: 'internal' as const,
  internalActivityId: TRAINING,
  billable: false as const,
};

beforeEach(async () => {
  // This suite deliberately creates immutable, cyclic window/report records.
  // Test cleanup temporarily removes only delete guards, then restores them.
  await env.DB.batch([
    env.DB.prepare('DROP TRIGGER close_amendment_audit_delete_guard'),
    env.DB.prepare('DROP TRIGGER close_amendment_windows_delete_guard'),
    env.DB.prepare('DROP TRIGGER time_entries_locked_delete_guard'),
  ]);
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys = ON'),
    env.DB.prepare('DELETE FROM xero_projects_upload_outbox'),
    env.DB.prepare('DELETE FROM xero_projects_approval_items'),
    env.DB.prepare('DELETE FROM xero_projects_approvals'),
    env.DB.prepare('DELETE FROM report_delivery_outbox'),
    env.DB.prepare('DELETE FROM report_artifacts'),
    env.DB.prepare('DELETE FROM close_amendment_audit'),
    env.DB.prepare('DELETE FROM close_audit'),
    env.DB.prepare('DELETE FROM locked_entry_corrections'),
    env.DB.prepare('DELETE FROM locked_entry_write_tokens'),
    env.DB.prepare('DELETE FROM xero_projects_entry_selections'),
    env.DB.prepare('DELETE FROM time_entries'),
    env.DB.prepare('UPDATE report_versions SET supersedes_report_id = NULL'),
    env.DB.prepare('DELETE FROM report_versions'),
    env.DB.prepare('DELETE FROM close_amendment_windows'),
    env.DB.prepare('DELETE FROM close_periods'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM projects'),
    env.DB.prepare(
      `UPDATE close_control
       SET activated_at = NULL, closed_through = 0, updated_at = 1 WHERE id = 1`,
    ),
    env.DB.prepare(
      `UPDATE close_transaction_guard
       SET asserted = 1, write_scope = NULL, write_period_id = NULL WHERE id = 1`,
    ),
  ]);
  await env.DB.batch([
    env.DB.prepare(`CREATE TRIGGER close_amendment_audit_delete_guard
      BEFORE DELETE ON close_amendment_audit
      BEGIN SELECT RAISE(ABORT, 'AMENDMENT_AUDIT_IMMUTABLE'); END`),
    env.DB.prepare(`CREATE TRIGGER close_amendment_windows_delete_guard
      BEFORE DELETE ON close_amendment_windows
      BEGIN SELECT RAISE(ABORT, 'AMENDMENT_WINDOW_IMMUTABLE'); END`),
    env.DB.prepare(`CREATE TRIGGER time_entries_locked_delete_guard
      BEFORE DELETE ON time_entries
      WHEN OLD.locked_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'LOCKED_ENTRY'); END`),
  ]);
});

async function seedUsersAndPeriod(input: { published?: boolean; lockedEntry?: boolean } = {}) {
  const { published = true, lockedEntry = false } = input;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
           (id, access_subject, email, display_name, role, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ADMIN,
      'subject:admin',
      'admin@versatileaccounting.com.au',
      'Admin',
      'admin',
      COVERAGE_FROM,
      COVERAGE_FROM,
      COVERAGE_FROM,
    ),
    env.DB.prepare(
      `INSERT INTO users
           (id, access_subject, email, display_name, role, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      OWNER,
      'subject:owner',
      'owner@versatileaccounting.com.au',
      'Alex',
      'employee',
      COVERAGE_FROM,
      COVERAGE_FROM,
      COVERAGE_FROM,
    ),
    env.DB.prepare(
      `INSERT INTO users
           (id, access_subject, email, display_name, role, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      OTHER,
      'subject:other',
      'other@versatileaccounting.com.au',
      'Other employee',
      'employee',
      COVERAGE_FROM,
      COVERAGE_FROM,
      COVERAGE_FROM,
    ),
    env.DB.prepare(
      `INSERT INTO close_periods
           (id, coverage_from, cutoff_at, kind, status, reason, initiated_by_user_id,
            suppress_delivery, entry_count, total_ms, source_revision, closed_at,
            created_at, updated_at)
         VALUES (?, ?, ?, 'scheduled', 'closed', 'Published weekly close', ?,
           0, ?, ?, 0, ?, ?, ?)`,
    ).bind(
      PERIOD,
      COVERAGE_FROM,
      CUTOFF_AT,
      ADMIN,
      lockedEntry ? 1 : 0,
      lockedEntry ? 60 * 60_000 : 0,
      CUTOFF_AT,
      COVERAGE_FROM,
      CUTOFF_AT,
    ),
    env.DB.prepare(
      `UPDATE close_control
         SET activated_at = ?, closed_through = ?, updated_at = ? WHERE id = 1`,
    ).bind(COVERAGE_FROM, CUTOFF_AT, CUTOFF_AT),
  ]);
  if (lockedEntry) {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO projects (id, name, name_key, created_at) VALUES (?, ?, ?, ?)',
      ).bind(PROJECT, 'Legacy project', 'legacy project', COVERAGE_FROM),
      env.DB.prepare(
        `INSERT INTO time_entries
             (id, project_id, notes, client_description, start_at, end_at, active_guard,
              created_at, updated_at, user_id, work_type, billable,
              legacy_project_name_snapshot, revision, locked_at, close_period_id,
              segment_root_id, segment_parent_id, segment_index,
              original_start_at, original_end_at)
           VALUES (?, ?, 'Original note', '', ?, ?, NULL, ?, ?, ?, 'legacy', 0,
             'Legacy project', 1, ?, ?, ?, NULL, 0, ?, ?)`,
      ).bind(
        LOCKED_ENTRY,
        PROJECT,
        Date.parse('2026-11-02T00:00:00.000Z'),
        Date.parse('2026-11-02T01:00:00.000Z'),
        COVERAGE_FROM,
        COVERAGE_FROM,
        OWNER,
        CUTOFF_AT,
        PERIOD,
        LOCKED_ENTRY,
        Date.parse('2026-11-02T00:00:00.000Z'),
        Date.parse('2026-11-02T01:00:00.000Z'),
      ),
    ]);
  }
  if (published) await insertBaselineReport(lockedEntry ? 1 : 0, lockedEntry ? 60 * 60_000 : 0);
}

async function insertBaselineReport(entryCount = 0, totalMs = 0) {
  await env.DB.prepare(
    `INSERT INTO report_versions
       (id, close_period_id, version, supersedes_report_id, snapshot_json,
        snapshot_sha256, entry_count, total_ms, source_revision, correction_reason,
        created_by_user_id, created_at)
     VALUES (?, ?, 1, NULL, '{}', 'baseline-sha', ?, ?, 0, '', ?, ?)`,
  )
    .bind(BASELINE_REPORT, PERIOD, entryCount, totalMs, ADMIN, CUTOFF_AT)
    .run();
}

async function openWindow(input: { now?: Date; expiresAt?: Date } = {}) {
  return openCloseAmendmentWindow({
    db: env.DB,
    closePeriodId: PERIOD,
    userId: OWNER,
    actorUserId: ADMIN,
    reason: 'Alex omitted completed time from the published week.',
    expiresAt: input.expiresAt ?? EXPIRES_AT,
    now: input.now ?? NOW,
  });
}

function timeStore(now = NOW) {
  return new D1TimeStore(env.DB, () => now);
}

async function createDraft(
  start = new Date('2026-11-02T00:00:00.000Z'),
  end = new Date('2026-11-02T01:00:00.000Z'),
) {
  return timeStore().createEntry(OWNER, {
    ...INTERNAL_WORK,
    notes: 'Late training entry',
    startAt: start,
    endAt: end,
  });
}

async function rowCount(table: string, where = '', bindings: unknown[] = []) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS value FROM ${table} ${where}`)
    .bind(...bindings)
    .first<{ value: number }>();
  return row?.value ?? 0;
}

describe('audited late-entry amendment acceptance', () => {
  it('enforces the published period, owner, exact boundaries, one Brisbane day, and no clock-in', async () => {
    await seedUsersAndPeriod({ published: false });
    await expect(openWindow()).rejects.toMatchObject({
      code: 'AMENDMENT_PERIOD_NOT_PUBLISHED',
      status: 400,
    });
    await insertBaselineReport();
    const window = await openWindow();
    expect((await openWindow()).id).toBe(window.id);

    const ownerStore = timeStore();
    const coverageBoundary = await ownerStore.createEntry(OWNER, {
      ...INTERNAL_WORK,
      notes: 'Coverage boundary',
      startAt: new Date(COVERAGE_FROM),
      endAt: new Date(COVERAGE_FROM + 60 * 60_000),
    });
    const cutoffBoundary = await ownerStore.createEntry(OWNER, {
      ...INTERNAL_WORK,
      notes: 'Cutoff boundary',
      startAt: new Date(CUTOFF_AT - 60 * 60_000),
      endAt: new Date(CUTOFF_AT),
    });
    expect(coverageBoundary.lockedAt).toBeNull();
    expect(cutoffBoundary.lockedAt).toBeNull();

    await expect(
      ownerStore.createEntry(OTHER, {
        ...INTERNAL_WORK,
        notes: 'Wrong owner',
        startAt: new Date(COVERAGE_FROM),
        endAt: new Date(COVERAGE_FROM + 60 * 60_000),
      }),
    ).rejects.toThrow('LOCKED_PERIOD');
    await expect(
      ownerStore.createEntry(OWNER, {
        ...INTERNAL_WORK,
        notes: 'Before coverage',
        startAt: new Date(COVERAGE_FROM - 60_000),
        endAt: new Date(COVERAGE_FROM + 60_000),
      }),
    ).rejects.toThrow('LOCKED_PERIOD');
    await expect(
      ownerStore.createEntry(OWNER, {
        ...INTERNAL_WORK,
        notes: 'Crosses cutoff',
        startAt: new Date(CUTOFF_AT - 60_000),
        endAt: new Date(CUTOFF_AT + 60_000),
      }),
    ).rejects.toThrow('LOCKED_PERIOD');
    await expect(
      ownerStore.createEntry(OWNER, {
        ...INTERNAL_WORK,
        notes: 'Crosses Brisbane midnight',
        startAt: new Date('2026-10-31T13:30:00.000Z'),
        endAt: new Date('2026-10-31T14:30:00.000Z'),
      }),
    ).rejects.toThrow('AMENDMENT_SINGLE_DAY_REQUIRED');
    await expect(
      ownerStore.clockIn(
        OWNER,
        INTERNAL_WORK,
        'Historic timers are forbidden',
        new Date('2026-11-02T00:00:00.000Z'),
      ),
    ).rejects.toThrow('LOCKED_PERIOD');
    await expect(
      env.DB.prepare('UPDATE time_entries SET user_id = ? WHERE id = ?')
        .bind(OTHER, coverageBoundary.id)
        .run(),
    ).rejects.toThrow(/LOCKED_PERIOD|INVALID_AMENDMENT_DRAFT/);
    expect(await rowCount('time_entries', 'WHERE amendment_window_id = ?', [window.id])).toBe(2);
  });

  it('keeps mutation audits atomic under CAS and blocks all writes after expiry', async () => {
    await seedUsersAndPeriod();
    const window = await openWindow();
    const first = await createDraft();
    const second = await createDraft(
      new Date('2026-11-03T00:00:00.000Z'),
      new Date('2026-11-03T01:00:00.000Z'),
    );
    const store = timeStore();
    const updated = await store.updateEntry(OWNER, first.id, {
      ...INTERNAL_WORK,
      notes: 'Corrected late training entry',
      startAt: new Date(first.startAt),
      endAt: new Date(first.endAt!),
      expectedRevision: first.revision,
    });
    expect(updated?.revision).toBe(first.revision + 1);
    expect(
      await rowCount('close_amendment_audit', "WHERE window_id = ? AND action = 'draft.updated'", [
        window.id,
      ]),
    ).toBe(1);

    await expect(
      store.updateEntry(OWNER, first.id, {
        ...INTERNAL_WORK,
        notes: 'Stale overwrite',
        startAt: new Date(first.startAt),
        endAt: new Date(first.endAt!),
        expectedRevision: first.revision,
      }),
    ).rejects.toThrow('ENTRY_REVISION_CONFLICT');
    expect(
      await rowCount('close_amendment_audit', "WHERE window_id = ? AND action = 'draft.updated'", [
        window.id,
      ]),
    ).toBe(1);

    expect(await store.deleteEntry(OWNER, second.id)).toBe(true);
    expect(
      await rowCount(
        'close_amendment_audit',
        "WHERE window_id = ? AND action = 'draft.deleted' AND entry_id = ?",
        [window.id, second.id],
      ),
    ).toBe(1);
    await expect(
      env.DB.prepare('DELETE FROM close_amendment_audit WHERE window_id = ?').bind(window.id).run(),
    ).rejects.toThrow(/AMENDMENT_AUDIT_IMMUTABLE/);

    const expiredStore = timeStore(new Date(EXPIRES_AT.getTime() + 1));
    expect(
      await getCurrentCloseAmendment(env.DB, OWNER, new Date(EXPIRES_AT.getTime() + 1)),
    ).toBeNull();
    await expect(
      expiredStore.createEntry(OWNER, {
        ...INTERNAL_WORK,
        notes: 'Expired create',
        startAt: new Date('2026-11-04T00:00:00.000Z'),
        endAt: new Date('2026-11-04T01:00:00.000Z'),
      }),
    ).rejects.toThrow('LOCKED_PERIOD');
    await expect(
      expiredStore.updateEntry(OWNER, first.id, {
        ...INTERNAL_WORK,
        notes: 'Expired edit',
        startAt: new Date(first.startAt),
        endAt: new Date(first.endAt!),
        expectedRevision: updated!.revision,
      }),
    ).rejects.toThrow('LOCKED_ENTRY');
    await expect(expiredStore.deleteEntry(OWNER, first.id)).rejects.toThrow('LOCKED_ENTRY');
  });

  it('finalizes once into one superseding report and one delivery per recipient', async () => {
    await seedUsersAndPeriod();
    const window = await openWindow();
    await expect(
      finalizeCloseAmendmentWindow({
        db: env.DB,
        windowId: window.id,
        actorUserId: ADMIN,
        reason: 'Alex confirmed all missing entries are complete.',
        recipients: RECIPIENTS,
        now: NOW,
      }),
    ).rejects.toMatchObject({
      code: 'AMENDMENT_NO_DRAFT_ENTRIES',
      status: 400,
    });

    const draft = await createDraft();
    expect(await rowCount('report_versions')).toBe(1);
    expect(await rowCount('report_delivery_outbox')).toBe(0);
    const finalized = await finalizeCloseAmendmentWindow({
      db: env.DB,
      windowId: window.id,
      actorUserId: ADMIN,
      reason: 'Alex confirmed all missing entries are complete.',
      recipients: RECIPIENTS,
      now: NOW,
    });
    expect(finalized.window).toMatchObject({ status: 'closed', reportId: finalized.report.id });
    expect(finalized.report).toMatchObject({ version: 2, entryCount: 1, totalMs: 60 * 60_000 });
    expect(
      await env.DB.prepare(
        'SELECT source_revision, entry_count, total_ms FROM close_periods WHERE id = ?',
      )
        .bind(PERIOD)
        .first(),
    ).toEqual({ source_revision: 1, entry_count: 1, total_ms: 60 * 60_000 });
    expect(
      await env.DB.prepare('SELECT locked_at, close_period_id FROM time_entries WHERE id = ?')
        .bind(draft.id)
        .first(),
    ).toEqual({ locked_at: NOW.getTime(), close_period_id: PERIOD });

    const reports = await env.DB.prepare(
      `SELECT id, version, supersedes_report_id, source_revision, amendment_window_id
       FROM report_versions WHERE close_period_id = ? ORDER BY version`,
    )
      .bind(PERIOD)
      .all<{
        id: string;
        version: number;
        supersedes_report_id: string | null;
        source_revision: number;
        amendment_window_id: string | null;
      }>();
    expect(reports.results).toEqual([
      {
        id: BASELINE_REPORT,
        version: 1,
        supersedes_report_id: null,
        source_revision: 0,
        amendment_window_id: null,
      },
      {
        id: finalized.report.id,
        version: 2,
        supersedes_report_id: BASELINE_REPORT,
        source_revision: 1,
        amendment_window_id: window.id,
      },
    ]);
    expect(await rowCount('report_artifacts', 'WHERE report_id = ?', [finalized.report.id])).toBe(
      3,
    );
    const deliveries = await env.DB.prepare(
      `SELECT recipient, state FROM report_delivery_outbox
       WHERE report_id = ? ORDER BY recipient`,
    )
      .bind(finalized.report.id)
      .all<{ recipient: string; state: string }>();
    expect(deliveries.results).toEqual(
      [...RECIPIENTS].sort().map((recipient) => ({ recipient, state: 'queued' })),
    );

    const repeated = await finalizeCloseAmendmentWindow({
      db: env.DB,
      windowId: window.id,
      actorUserId: ADMIN,
      reason: 'Alex confirmed all missing entries are complete.',
      recipients: RECIPIENTS,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(repeated.report.id).toBe(finalized.report.id);
    expect(await rowCount('report_versions')).toBe(2);
    expect(await rowCount('report_delivery_outbox')).toBe(RECIPIENTS.length);
    expect(
      await rowCount('close_amendment_audit', "WHERE window_id = ? AND action = 'window.closed'", [
        window.id,
      ]),
    ).toBe(1);
  });

  it('recovers a finalizing crash idempotently without any pre-recovery report or email', async () => {
    await seedUsersAndPeriod();
    const window = await openWindow();
    const draft = await createDraft();
    const timestamp = NOW.getTime();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE close_amendment_windows
           SET status = 'finalizing', finalized_by_user_id = ?, finalizing_at = ?,
             finalize_reason = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
      ).bind(ADMIN, timestamp, 'Alex confirmed recovered finalization.', timestamp, window.id),
      env.DB.prepare(
        `UPDATE time_entries SET locked_at = ?, close_period_id = ?,
             revision = revision + 1, updated_at = ?
           WHERE id = ? AND amendment_window_id = ?`,
      ).bind(timestamp, PERIOD, timestamp, draft.id, window.id),
      env.DB.prepare(
        `UPDATE close_periods SET entry_count = 1, total_ms = ?,
             source_revision = source_revision + 1, updated_at = ? WHERE id = ?`,
      ).bind(60 * 60_000, timestamp, PERIOD),
      env.DB.prepare(
        `INSERT INTO close_amendment_audit
             (id, window_id, actor_user_id, action, entry_id, details_json, created_at)
           VALUES ('recovery-finalizing-audit', ?, ?, 'window.finalizing', NULL, '{}', ?)`,
      ).bind(window.id, ADMIN, timestamp),
    ]);
    expect(await rowCount('report_versions')).toBe(1);
    expect(await rowCount('report_delivery_outbox')).toBe(0);

    const recovered = await recoverFinalizingCloseAmendments({
      db: env.DB,
      recipients: RECIPIENTS,
      now: NOW,
    });
    expect(recovered.failed).toEqual([]);
    expect(recovered.recovered).toHaveLength(1);
    expect(recovered.recovered[0].window.status).toBe('closed');
    expect(recovered.recovered[0].report.version).toBe(2);
    expect(
      await recoverFinalizingCloseAmendments({
        db: env.DB,
        recipients: RECIPIENTS,
        now: new Date(NOW.getTime() + 60_000),
      }),
    ).toEqual({ recovered: [], failed: [] });
    expect(await rowCount('report_versions', 'WHERE amendment_window_id = ?', [window.id])).toBe(1);
    expect(await rowCount('report_delivery_outbox')).toBe(RECIPIENTS.length);
  });

  it('interlocks locked corrections and excludes drafts from scheduled and weekly reports', async () => {
    await seedUsersAndPeriod({ lockedEntry: true });
    const window = await openWindow();
    const draft = await createDraft();
    await expect(
      correctLockedEntry({
        db: env.DB,
        entryId: LOCKED_ENTRY,
        expectedRevision: 1,
        actorUserId: ADMIN,
        reason: 'Correction attempted while late entries are open.',
        patch: { notes: 'Must not commit' },
        reportRecipients: RECIPIENTS,
        now: NOW,
      }),
    ).rejects.toThrow(/AMENDMENT_CORRECTION_CONFLICT/);
    expect(
      await env.DB.prepare('SELECT revision, notes FROM time_entries WHERE id = ?')
        .bind(LOCKED_ENTRY)
        .first(),
    ).toEqual({ revision: 1, notes: 'Original note' });
    expect(await rowCount('locked_entry_corrections')).toBe(0);
    expect(await rowCount('report_versions')).toBe(1);
    expect(await rowCount('report_delivery_outbox')).toBe(0);

    const weekly = await buildWeeklyWorkbook(timeStore(), '2026-11-02', NEXT_NOW);
    expect(weekly.totalMs).toBe(60 * 60_000);
    const scheduled = await runScheduledFridayCloses({
      db: env.DB,
      recipients: [],
      now: NEXT_NOW,
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].period).toMatchObject({
      cutoffAt: new Date(NEXT_CUTOFF).toISOString(),
      entryCount: 0,
      totalMs: 0,
    });
    expect(
      await env.DB.prepare('SELECT locked_at, close_period_id FROM time_entries WHERE id = ?')
        .bind(draft.id)
        .first(),
    ).toEqual({ locked_at: null, close_period_id: null });
    expect((await getCurrentCloseAmendment(env.DB, OWNER))?.id).toBe(window.id);
  });
});

const apiApp = createApp(async (request): Promise<AccessIdentity> => {
  const email = request.headers.get('x-test-email');
  if (!email) throw new Error('missing test identity');
  return {
    subject: `subject:${email}`,
    entraObjectId: `oid:${email}`,
    email,
    displayName: email.split('@')[0],
  };
});

function bindings(): Env {
  return {
    DB: env.DB,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
    ACCESS_AUD: 'test-audience',
    ALLOWED_EMAIL_DOMAIN: 'versatileaccounting.com.au',
    ADMIN_EMAILS: 'alexg@versatileaccounting.com.au',
    REPORT_VIEWER_EMAILS: 'suzieg@versatileaccounting.com.au',
    WEEKLY_REPORT_RECIPIENTS: RECIPIENTS.join(','),
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'Timekeeper <reports@example.com>',
    WEEKLY_REPORT_RECIPIENT: 'weekly@example.com',
    REPORT_TEST_RECIPIENT: 'test@example.com',
  };
}

async function apiCall(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await apiApp.fetch(
    new Request(`https://timekeeper.example${path}`, init),
    bindings(),
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function signIn(email: string) {
  const response = await apiCall('/api/session', { headers: { 'X-Test-Email': email } });
  const body = (await response.json()) as {
    csrfToken: string;
    user: { id: string; email: string; role: string };
  };
  return {
    email,
    user: body.user,
    csrf: body.csrfToken,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
  };
}

function apiHeaders(session: Awaited<ReturnType<typeof signIn>>, csrf = true) {
  return {
    'X-Test-Email': session.email,
    Cookie: session.cookie,
    ...(csrf ? { 'X-CSRF-Token': session.csrf } : {}),
    'Content-Type': 'application/json',
  };
}

describe('late-entry amendment API authorization', () => {
  it('requires admin+CSRF for mutation and reveals only the actor-owned current window', async () => {
    const admin = await signIn('alexg@versatileaccounting.com.au');
    const owner = await signIn('employee@versatileaccounting.com.au');
    const other = await signIn('other@versatileaccounting.com.au');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO close_periods
             (id, coverage_from, cutoff_at, kind, status, reason, initiated_by_user_id,
              suppress_delivery, entry_count, total_ms, source_revision, closed_at,
              created_at, updated_at)
           VALUES (?, ?, ?, 'scheduled', 'closed', 'Published weekly close', ?,
             0, 0, 0, 0, ?, ?, ?)`,
      ).bind(PERIOD, COVERAGE_FROM, CUTOFF_AT, admin.user.id, CUTOFF_AT, COVERAGE_FROM, CUTOFF_AT),
      env.DB.prepare(
        `INSERT INTO report_versions
             (id, close_period_id, version, supersedes_report_id, snapshot_json,
              snapshot_sha256, entry_count, total_ms, source_revision, correction_reason,
              created_by_user_id, created_at)
           VALUES (?, ?, 1, NULL, '{}', 'baseline-sha', 0, 0, 0, '', ?, ?)`,
      ).bind(BASELINE_REPORT, PERIOD, admin.user.id, CUTOFF_AT),
    ]);
    const body = JSON.stringify({
      closePeriodId: PERIOD,
      userId: owner.user.id,
      reason: 'Employee omitted completed time from this closed week.',
      expiresAt: EXPIRES_AT.toISOString(),
    });
    expect(
      (
        await apiCall('/api/admin/close-amendments', {
          method: 'POST',
          headers: apiHeaders(admin, false),
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await apiCall('/api/admin/close-amendments', {
          method: 'POST',
          headers: apiHeaders(owner),
          body,
        })
      ).status,
    ).toBe(403);
    const opened = await apiCall('/api/admin/close-amendments', {
      method: 'POST',
      headers: apiHeaders(admin),
      body,
    });
    expect(opened.status).toBe(201);
    const openedBody = (await opened.json()) as { window: { id: string; userId: string } };
    expect(openedBody.window.userId).toBe(owner.user.id);

    const ownerCurrent = await apiCall('/api/close-amendments/current', {
      headers: apiHeaders(owner, false),
    });
    expect(await ownerCurrent.json()).toMatchObject({
      window: { id: openedBody.window.id, userId: owner.user.id },
    });
    const otherCurrent = await apiCall('/api/close-amendments/current', {
      headers: apiHeaders(other, false),
    });
    expect(await otherCurrent.json()).toEqual({ window: null });
  });
});
