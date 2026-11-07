import { env } from 'cloudflare:workers';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import {
  finalizeCloseAmendmentWindow,
  getCurrentCloseAmendment,
  openCloseAmendmentWindow,
  recoverFinalizingCloseAmendments,
} from '../server/close-amendments';
import { D1TimeStore } from '../server/d1-store';
import { correctLockedEntry } from '../server/friday-close';

const ACTIVITY = '00000000-0000-4000-8000-000000000001';

async function fixture(offsetDays: number) {
  const now = new Date();
  const day = DateTime.fromJSDate(now, { zone: 'utc' })
    .setZone('Australia/Brisbane')
    .minus({ days: offsetDays })
    .startOf('day');
  const coverageFrom = day.minus({ days: 2 }).toUTC().toMillis();
  const cutoffAt = day.plus({ days: 2 }).toUTC().toMillis();
  const adminId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const periodId = crypto.randomUUID();
  const reportId = crypto.randomUUID();
  const timestamp = now.getTime();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
         (id,access_subject,email,display_name,role,created_at,updated_at,last_seen_at)
         VALUES(?,?,?,'Amendment Admin','admin',?,?,?)`,
    ).bind(
      adminId,
      `subject:${adminId}`,
      `${adminId}@example.com`,
      timestamp,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO users
         (id,access_subject,email,display_name,role,created_at,updated_at,last_seen_at)
         VALUES(?,?,?,'Amendment Employee','employee',?,?,?)`,
    ).bind(userId, `subject:${userId}`, `${userId}@example.com`, timestamp, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO close_periods
         (id,coverage_from,cutoff_at,kind,status,reason,suppress_delivery,entry_count,total_ms,
          source_revision,closed_at,created_at,updated_at)
         VALUES(?,?,?,'scheduled','closed','Seed close',0,0,0,0,?,?,?)`,
    ).bind(periodId, coverageFrom, cutoffAt, timestamp, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO report_versions
         (id,close_period_id,version,snapshot_json,snapshot_sha256,entry_count,total_ms,
          source_revision,correction_reason,created_by_user_id,created_at)
         VALUES(?,?,1,'{}','seed',0,0,0,'',?,?)`,
    ).bind(reportId, periodId, adminId, timestamp),
  ]);
  return { now, day, coverageFrom, cutoffAt, adminId, userId, periodId, reportId };
}

function lateEntry(day: DateTime, expectedRevision?: number) {
  return {
    workType: 'internal' as const,
    internalActivityId: ACTIVITY,
    billable: false as const,
    notes: 'Late administration time',
    startAt: day.plus({ hours: 9 }).toUTC().toJSDate(),
    endAt: day.plus({ hours: 10 }).toUTC().toJSDate(),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

async function openWindow(data: Awaited<ReturnType<typeof fixture>>) {
  return openCloseAmendmentWindow({
    db: env.DB,
    closePeriodId: data.periodId,
    userId: data.userId,
    actorUserId: data.adminId,
    reason: 'Employee needs to add omitted time',
    now: data.now,
  });
}

describe('late-entry amendment windows', () => {
  it('opens idempotently, expires from the employee view, and rejects unpublished periods', async () => {
    const data = await fixture(3);
    const opened = await openWindow(data);
    expect((await openWindow(data)).id).toBe(opened.id);
    expect(await getCurrentCloseAmendment(env.DB, data.userId, data.now)).toMatchObject({
      id: opened.id,
      status: 'open',
      draftEntryCount: 0,
    });
    expect(
      await getCurrentCloseAmendment(
        env.DB,
        data.userId,
        new Date(Date.parse(opened.expiresAt!) + 1),
      ),
    ).toBeNull();

    const unpublished = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO close_periods
         (id,coverage_from,cutoff_at,kind,status,reason,suppress_delivery,entry_count,total_ms,
          source_revision,closed_at,created_at,updated_at)
         VALUES(?,?,?,'manual','closed','',0,0,0,0,?,?,?)`,
    )
      .bind(
        unpublished,
        data.coverageFrom - 10_000,
        data.coverageFrom - 1,
        data.now.getTime(),
        data.now.getTime(),
        data.now.getTime(),
      )
      .run();
    await expect(
      openCloseAmendmentWindow({
        db: env.DB,
        closePeriodId: unpublished,
        userId: data.userId,
        actorUserId: data.adminId,
        reason: 'No published report exists',
        now: data.now,
      }),
    ).rejects.toMatchObject({ code: 'AMENDMENT_PERIOD_NOT_PUBLISHED' });
  });

  it('permits only completed same-day owner drafts and audits only successful stale-safe edits', async () => {
    const data = await fixture(4);
    await openWindow(data);
    const store = new D1TimeStore(env.DB, () => data.now);
    const created = await store.createEntry(data.userId, lateEntry(data.day));
    expect(created.lockedAt).toBeNull();

    const outsider = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users
         (id,access_subject,email,display_name,role,created_at,updated_at,last_seen_at)
         VALUES(?,?,?,'Other','employee',1,1,1)`,
    )
      .bind(outsider, `subject:${outsider}`, `${outsider}@example.com`)
      .run();
    await expect(store.createEntry(outsider, lateEntry(data.day))).rejects.toThrow('LOCKED_PERIOD');
    await expect(
      store.clockIn(
        data.userId,
        { workType: 'internal', internalActivityId: ACTIVITY, billable: false },
        '',
        data.day.plus({ hours: 11 }).toUTC().toJSDate(),
      ),
    ).rejects.toThrow('LOCKED_PERIOD');
    await expect(
      store.createEntry(data.userId, {
        ...lateEntry(data.day),
        startAt: data.day.plus({ hours: 23 }).toUTC().toJSDate(),
        endAt: data.day.plus({ days: 1, hours: 1 }).toUTC().toJSDate(),
      }),
    ).rejects.toThrow('AMENDMENT_SINGLE_DAY_REQUIRED');

    const updated = await store.updateEntry(data.userId, created.id, {
      ...lateEntry(data.day, created.revision),
      notes: 'Corrected private note',
    });
    expect(updated?.revision).toBe(created.revision + 1);
    await expect(
      store.updateEntry(data.userId, created.id, {
        ...lateEntry(data.day, created.revision),
        notes: 'Stale overwrite',
      }),
    ).rejects.toThrow('ENTRY_REVISION_CONFLICT');
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM close_amendment_audit
           WHERE entry_id=? AND action='draft.updated'`,
      )
        .bind(created.id)
        .first(),
    ).toEqual({ count: 1 });
  });

  it('serializes each period to one employee and blocks locked corrections while open', async () => {
    const data = await fixture(6);
    await openWindow(data);
    const other = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users
         (id,access_subject,email,display_name,role,created_at,updated_at,last_seen_at)
         VALUES(?,?,?,'Other employee','employee',1,1,1)`,
    )
      .bind(other, `subject:${other}`, `${other}@example.com`)
      .run();
    await expect(
      openCloseAmendmentWindow({
        db: env.DB,
        closePeriodId: data.periodId,
        userId: other,
        actorUserId: data.adminId,
        reason: 'Competing window must be rejected',
        now: data.now,
      }),
    ).rejects.toMatchObject({ code: 'AMENDMENT_PERIOD_ALREADY_ACTIVE' });

    const projectId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const startAt = data.day.plus({ hours: 12 }).toUTC().toMillis();
    const endAt = startAt + 3_600_000;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO projects (id,name,name_key,created_at) VALUES (?, ?, ?, ?)').bind(
        projectId,
        `Internal ${projectId}`,
        projectId,
        data.now.getTime(),
      ),
      env.DB.prepare(
        `INSERT INTO time_entries
           (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,user_id,
            work_type,internal_activity_id,billable,activity_name_snapshot,client_description,
            revision,locked_at,close_period_id,segment_root_id,segment_index,
            original_start_at,original_end_at)
           VALUES(?,?,'old',?,?,NULL,?,?,?,'internal',?,0,'Administration','',1,?,?,?,0,?,?)`,
      ).bind(
        entryId,
        projectId,
        startAt,
        endAt,
        startAt,
        startAt,
        data.userId,
        ACTIVITY,
        data.now.getTime(),
        data.periodId,
        entryId,
        startAt,
        endAt,
      ),
    ]);
    await expect(
      correctLockedEntry({
        db: env.DB,
        entryId,
        expectedRevision: 1,
        actorUserId: data.adminId,
        reason: 'Attempt correction during open amendment',
        patch: { notes: 'new' },
        reportRecipients: ['alex@example.com'],
        now: data.now,
      }),
    ).rejects.toThrow('AMENDMENT_CORRECTION_CONFLICT');
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM locked_entry_corrections WHERE entry_id=?',
      )
        .bind(entryId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it('rejects empty finalization and creates exactly one locked superseding report', async () => {
    const data = await fixture(5);
    const window = await openWindow(data);
    await env.DB.prepare(
      `INSERT INTO report_delivery_outbox
         (id,report_id,recipient,state,next_attempt_at,idempotency_key,
          attachment_manifest_sha256,created_at,updated_at)
         VALUES(?,?,?,'queued',? ,?,'seed-manifest',?,?)`,
    )
      .bind(
        crypto.randomUUID(),
        data.reportId,
        'old@example.com',
        data.now.getTime(),
        `seed-${crypto.randomUUID()}`,
        data.now.getTime(),
        data.now.getTime(),
      )
      .run();
    await expect(
      finalizeCloseAmendmentWindow({
        db: env.DB,
        windowId: window.id,
        actorUserId: data.adminId,
        reason: 'Finalize omitted time',
        recipients: ['alex@example.com'],
        now: data.now,
      }),
    ).rejects.toMatchObject({ code: 'AMENDMENT_NO_DRAFT_ENTRIES' });

    const store = new D1TimeStore(env.DB, () => data.now);
    const created = await store.createEntry(data.userId, lateEntry(data.day));
    const range = {
      from: new Date(data.coverageFrom),
      to: new Date(data.cutoffAt),
      userId: data.userId,
    };
    expect(await store.listEntries({ ...range, excludeAmendmentDrafts: true })).toHaveLength(0);

    const finalized = await finalizeCloseAmendmentWindow({
      db: env.DB,
      windowId: window.id,
      actorUserId: data.adminId,
      reason: 'Finalize omitted time',
      recipients: ['alex@example.com'],
      now: data.now,
    });
    expect(finalized.window).toMatchObject({ status: 'closed', reportId: finalized.report.id });
    expect(finalized.report.version).toBe(2);
    const repeated = await finalizeCloseAmendmentWindow({
      db: env.DB,
      windowId: window.id,
      actorUserId: data.adminId,
      reason: 'Finalize omitted time',
      recipients: ['alex@example.com'],
      now: data.now,
    });
    expect(repeated.report.id).toBe(finalized.report.id);
    expect(await recoverFinalizingCloseAmendments({ db: env.DB, recipients: [] })).toEqual({
      recovered: [],
      failed: [],
    });
    expect(
      await env.DB.prepare(
        'SELECT entry_count,total_ms,source_revision FROM close_periods WHERE id=?',
      )
        .bind(data.periodId)
        .first(),
    ).toEqual({ entry_count: 1, total_ms: 3_600_000, source_revision: 1 });
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM report_versions WHERE amendment_window_id=?',
      )
        .bind(window.id)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare('SELECT state,last_error FROM report_delivery_outbox WHERE report_id=?')
        .bind(data.reportId)
        .first(),
    ).toEqual({ state: 'needs_attention', last_error: 'Superseded by late-entry amendment' });
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM report_delivery_outbox WHERE report_id=?')
        .bind(finalized.report.id)
        .first(),
    ).toEqual({ count: 1 });
    expect(await store.listEntries({ ...range, excludeAmendmentDrafts: true })).toEqual([
      expect.objectContaining({ id: created.id, lockedAt: expect.any(String) }),
    ]);
    const correction = await correctLockedEntry({
      db: env.DB,
      entryId: created.id,
      expectedRevision: created.revision + 1,
      actorUserId: data.adminId,
      reason: 'Correct the finalized late-entry note',
      patch: { notes: 'Corrected after amendment finalization' },
      reportRecipients: [],
      now: new Date(data.now.getTime() + 1),
    });
    expect(correction.report?.version).toBe(3);
  });
});
