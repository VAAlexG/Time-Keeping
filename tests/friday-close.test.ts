import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { DateTime } from 'luxon';

import {
  activateFridayClose,
  correctLockedEntry,
  effectiveLockedThrough,
  previewFridayClose,
  runManualFridayClose,
  runScheduledFridayCloses,
} from '../server/friday-close';
import {
  processReportDeliveryOutbox,
  ReportDeliveryError,
  saveCloseReportVersion,
} from '../server/close-report';
import { D1TimeStore } from '../server/d1-store';
import { runScheduledReportRecovery } from '../worker';
import type { Env } from '../worker/env';

const USER = 'friday-user';
const PROJECT = 'friday-project';
const CLIENT = 'friday-client';
const TENANT = '11111111-1111-4111-8111-111111111111';

async function reset(): Promise<void> {
  // Production deliberately has no unlock/delete path. Tests temporarily remove
  // only those guards so each case starts with isolated data, then restore them.
  await env.DB.batch([
    env.DB.prepare('DROP TRIGGER time_entries_locked_update_guard'),
    env.DB.prepare('DROP TRIGGER time_entries_locked_delete_guard'),
  ]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM xero_projects_upload_outbox'),
    env.DB.prepare('DELETE FROM xero_projects_approval_items'),
    env.DB.prepare('DELETE FROM xero_projects_approvals'),
    env.DB.prepare('DELETE FROM report_delivery_outbox'),
    env.DB.prepare('DELETE FROM report_artifacts'),
    env.DB.prepare('DELETE FROM locked_entry_corrections'),
    env.DB.prepare('UPDATE report_versions SET supersedes_report_id = NULL'),
    env.DB.prepare('DELETE FROM report_versions'),
    env.DB.prepare('DELETE FROM close_audit'),
    env.DB.prepare('DELETE FROM locked_entry_write_tokens'),
    env.DB.prepare('DELETE FROM xero_projects_entry_selections'),
    env.DB.prepare('DELETE FROM close_periods'),
    env.DB.prepare('DELETE FROM time_entries'),
    env.DB.prepare('DELETE FROM xero_projects_work_links'),
    env.DB.prepare('DELETE FROM xero_projects_user_links'),
    env.DB.prepare('DELETE FROM xero_projects_client_links'),
    env.DB.prepare('DELETE FROM xero_projects_catalog WHERE tenant_id = ?').bind(TENANT),
    env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(CLIENT),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(USER),
    env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(PROJECT),
  ]);
  await env.DB.batch([
    env.DB.prepare(`CREATE TRIGGER time_entries_locked_update_guard
      BEFORE UPDATE ON time_entries
      WHEN OLD.locked_at IS NOT NULL AND (
        NEW.locked_at IS NOT OLD.locked_at OR
        NEW.close_period_id IS NOT OLD.close_period_id OR
        NOT EXISTS (
          SELECT 1 FROM locked_entry_write_tokens t
          WHERE t.entry_id = OLD.id
            AND t.expected_revision = OLD.revision
            AND t.expires_at >= unixepoch() * 1000
        )
      )
      BEGIN SELECT RAISE(ABORT, 'LOCKED_ENTRY'); END`),
    env.DB.prepare(`CREATE TRIGGER time_entries_locked_delete_guard
      BEFORE DELETE ON time_entries
      WHEN OLD.locked_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'LOCKED_ENTRY'); END`),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
         (id, access_subject, email, display_name, role, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'admin', 1, 1, 1)`,
    ).bind(USER, USER, 'friday@example.com', 'Friday Tester'),
    env.DB.prepare(
      'INSERT INTO projects (id, name, name_key, created_at) VALUES (?, ?, ?, 1)',
    ).bind(PROJECT, 'Legacy project', 'legacy project'),
    env.DB.prepare(
      'UPDATE close_control SET activated_at = NULL, closed_through = 0, updated_at = 1 WHERE id = 1',
    ),
    env.DB.prepare(
      `UPDATE close_transaction_guard
       SET asserted = 1, write_scope = NULL, write_period_id = NULL WHERE id = 1`,
    ),
    env.DB.prepare(
      `UPDATE xero_projects_connection SET tenant_id = NULL, connected = 0, paused = 1,
       mapping_revision = 0, catalogue_revision = 0, updated_at = 1 WHERE id = 1`,
    ),
  ]);
}

async function entry(input: { id: string; start: string; end?: string }): Promise<void> {
  const start = Date.parse(input.start);
  const end = input.end ? Date.parse(input.end) : null;
  await env.DB.prepare(
    `INSERT INTO time_entries
       (id, project_id, notes, start_at, end_at, active_guard, created_at, updated_at,
        user_id, work_type, billable, legacy_project_name_snapshot, client_description,
        segment_root_id, segment_index, revision)
       VALUES (?, ?, 'private note', ?, ?, ?, ?, ?, ?, 'legacy', 0, 'Legacy project',
         'client description', ?, 0, 1)`,
  )
    .bind(input.id, PROJECT, start, end, end === null ? 1 : null, start, start, USER, input.id)
    .run();
}

async function approvedXeroUpload(entryIds: string[], approvalId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE xero_projects_connection SET tenant_id = ?, connected = 1, paused = 0,
         mapping_revision = 1, catalogue_revision = 1, updated_at = 1 WHERE id = 1`,
    ).bind(TENANT),
    env.DB.prepare(
      `INSERT INTO clients
       (id, external_id, source, name, active, created_at, updated_at, synced_at)
       VALUES (?, 'friday-client-external', 'fyi', 'Friday Client', 1, 1, 1, 1)`,
    ).bind(CLIENT),
    env.DB.prepare(
      `INSERT INTO xero_projects_catalog
       (tenant_id, kind, resource_id, parent_id, data_json, active, fetched_at, catalogue_revision)
       VALUES (?, 'project', 'xero-project', '', '{}', 1, 1, 1),
              (?, 'task', 'xero-task', 'xero-project', '{}', 1, 1, 1),
              (?, 'user', 'xero-user', '', '{}', 1, 1, 1)`,
    ).bind(TENANT, TENANT, TENANT),
    env.DB.prepare(
      `INSERT INTO xero_projects_client_links
       (tenant_id, client_id, contact_id, contact_name_snapshot, revision,
        mapped_by_user_id, mapped_at)
       VALUES (?, ?, 'xero-contact', 'Friday Client', 1, ?, 1)`,
    ).bind(TENANT, CLIENT, USER),
    env.DB.prepare(
      `INSERT INTO xero_projects_user_links
       (tenant_id, user_id, xero_user_id, xero_email_snapshot, revision,
        mapped_by_user_id, mapped_at)
       VALUES (?, ?, 'xero-user', 'friday@example.com', 1, ?, 1)`,
    ).bind(TENANT, USER, USER),
    env.DB.prepare(
      `INSERT INTO xero_projects_approvals
       (id, tenant_id, state, preview_hash, snapshot_json, warnings_json,
        approved_by_user_id, approved_by_email, approved_at)
       VALUES (?, ?, 'approved', 'preview', '{}', '[]', ?, 'friday@example.com', 1)`,
    ).bind(approvalId, TENANT, USER),
  ]);
  for (const entryId of entryIds) {
    const source = await env.DB.prepare(
      'SELECT revision, end_at - start_at AS duration FROM time_entries WHERE id = ?',
    )
      .bind(entryId)
      .first<{ revision: number; duration: number }>();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO xero_projects_entry_selections
         (entry_id, tenant_id, project_id, task_id, project_name_snapshot,
          task_name_snapshot, task_charge_type_snapshot, task_rate_currency_snapshot,
          task_rate_value_snapshot, project_catalogue_revision, task_catalogue_revision,
          selection_revision, selected_by_user_id, selected_at)
         VALUES (?, ?, 'xero-project', 'xero-task', 'Project', 'Task',
          'TIME', 'AUD', 200, 1, 1, 1, ?, 1)`,
      ).bind(entryId, TENANT, USER),
      env.DB.prepare(
        `INSERT INTO xero_projects_approval_items
         (id, approval_id, tenant_id, entry_id, source_revision, selection_revision,
          client_id, client_link_revision, user_id, user_link_revision, project_id,
          task_id, xero_user_id, project_catalogue_revision, task_catalogue_revision,
          user_catalogue_revision, source_snapshot_json, mapping_revision,
          mapping_snapshot_json, exact_duration_ms, rounded_minutes,
          rounding_delta_seconds, payload_json, payload_hash, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, 1, 'xero-project', 'xero-task',
          'xero-user', 1, 1, 1, '{}', 1, '{}', ?, 60, 0, '{}', 'hash', ?, 1)`,
      ).bind(
        `${approvalId}-${entryId}`,
        approvalId,
        TENANT,
        entryId,
        source!.revision,
        CLIENT,
        USER,
        source!.duration,
        `${approvalId}-${entryId}`,
      ),
      env.DB.prepare(
        `INSERT INTO xero_projects_upload_outbox
         (id, approval_item_id, approval_id, tenant_id, project_id, entry_id,
          payload_json, payload_hash, idempotency_key, state, attempts,
          next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'xero-project', ?, '{}', 'hash', ?, 'queued', 0, 1, 1, 1)`,
      ).bind(
        `outbox-${approvalId}-${entryId}`,
        `${approvalId}-${entryId}`,
        approvalId,
        TENANT,
        entryId,
        `outbox-${approvalId}-${entryId}`,
      ),
    ]);
  }
}

beforeEach(reset);

describe('Friday 20:00 Brisbane close', () => {
  it('does not activate historical locking from an unattended scheduled run', async () => {
    await entry({
      id: 'activation-guard',
      start: '2026-08-07T07:00:00.000Z',
      end: '2026-08-07T08:00:00.000Z',
    });
    const recovery = await runScheduledReportRecovery(
      { DB: env.DB, ADMIN_EMAILS: '', REPORT_VIEWER_EMAILS: '' } as Env,
      Date.parse('2026-08-07T10:00:00.000Z'),
    );
    expect(recovery).toMatchObject({ status: 'fulfilled', value: [] });
    expect(await effectiveLockedThrough(env.DB, new Date('2026-08-07T10:00:00.000Z'))).toBeNull();
  });

  it('activates safely, splits a running timer exactly at cutoff and suppresses historical email', async () => {
    await entry({ id: 'running-1', start: '2026-08-07T09:00:00.000Z' });
    await env.DB.prepare(
      `INSERT INTO xero_projects_entry_selections
       (entry_id, tenant_id, project_id, task_id, project_name_snapshot,
        task_name_snapshot, task_charge_type_snapshot, task_rate_currency_snapshot,
        task_rate_value_snapshot, project_catalogue_revision, task_catalogue_revision,
        selection_revision, selected_by_user_id, selected_at)
       VALUES (?, 'tenant-1', 'xero-project-1', 'xero-task-1', 'Project', 'Task',
        'TIME', 'AUD', 200, 4, 5, 2, ?, ?)`,
    )
      .bind('running-1', USER, Date.parse('2026-08-07T09:30:00.000Z'))
      .run();
    const now = new Date('2026-08-07T10:00:00.000Z');
    const [result] = await runScheduledFridayCloses({
      db: env.DB,
      recipients: ['reports@example.com'],
      activateIfNeeded: true,
      now,
    });
    expect(result.period).toMatchObject({
      kind: 'initial',
      cutoffAt: now.toISOString(),
      suppressDelivery: true,
      entryCount: 1,
      totalMs: 60 * 60_000,
    });
    expect(result.report?.artifacts).toHaveLength(3);
    expect(result.report?.snapshot.totals.byEmployee).toEqual([
      { key: USER, label: 'Friday Tester (friday@example.com)', totalMs: 60 * 60_000 },
    ]);
    expect(result.report?.snapshot.totals.byWorkDay).toEqual([
      { key: '2026-08-07', label: '2026-08-07', totalMs: 60 * 60_000 },
    ]);
    expect(result.report?.snapshot.entries[0].exceptionFlags).toContain('legacy');
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM report_delivery_outbox').first<{
        count: number;
      }>(),
    ).toEqual({ count: 0 });
    const rows = await env.DB.prepare(
      'SELECT start_at, end_at, locked_at, close_period_id, active_guard, segment_root_id, segment_parent_id FROM time_entries ORDER BY start_at',
    ).all<{
      start_at: number;
      end_at: number | null;
      locked_at: number | null;
      close_period_id: string | null;
      active_guard: number | null;
      segment_root_id: string;
      segment_parent_id: string | null;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({
      end_at: now.getTime(),
      active_guard: null,
      segment_root_id: 'running-1',
    });
    expect(rows.results[0].locked_at).not.toBeNull();
    expect(rows.results[1]).toMatchObject({
      start_at: now.getTime(),
      end_at: null,
      locked_at: null,
      close_period_id: null,
      active_guard: 1,
      segment_root_id: 'running-1',
      segment_parent_id: 'running-1',
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM xero_projects_entry_selections
         WHERE project_id = 'xero-project-1' AND task_id = 'xero-task-1'
           AND selection_revision = 2`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 2 });
    expect(await effectiveLockedThrough(env.DB, now)).toEqual(now);
  });

  it('reclaims a stale pre-commit close instead of reporting unlocked data', async () => {
    await entry({
      id: 'stale-close-entry',
      start: '2026-08-07T07:00:00.000Z',
      end: '2026-08-07T08:00:00.000Z',
    });
    const now = new Date('2026-08-07T10:00:00.000Z');
    await env.DB.prepare(
      `INSERT INTO close_periods
       (id, coverage_from, cutoff_at, kind, status, reason, suppress_delivery,
        created_at, updated_at)
       VALUES ('stale-close', ?, ?, 'initial', 'closing', 'Interrupted fixture', 1, ?, ?)`,
    )
      .bind(
        Date.parse('2026-08-07T07:00:00.000Z'),
        now.getTime(),
        now.getTime() - 10 * 60_000,
        now.getTime() - 10 * 60_000,
      )
      .run();
    // A regression guard: stale recovery must never remove the only closing
    // row, because that row is also the first-activation write fence.
    await env.DB.prepare(
      `CREATE TRIGGER stale_close_must_not_be_deleted
       BEFORE DELETE ON close_periods
       WHEN OLD.id = 'stale-close'
       BEGIN SELECT RAISE(ABORT, 'STALE_CLOSE_FENCE_DELETED'); END`,
    ).run();
    const recovered = await (async () => {
      try {
        return await runScheduledReportRecovery(
          {
            DB: env.DB,
            ADMIN_EMAILS: '',
            REPORT_VIEWER_EMAILS: '',
          } as Env,
          now.getTime(),
        );
      } finally {
        await env.DB.prepare('DROP TRIGGER stale_close_must_not_be_deleted').run();
      }
    })();
    expect(recovered.status).toBe('fulfilled');
    const [closed] = recovered.status === 'fulfilled' ? recovered.value : [];
    expect(closed).toBeDefined();
    expect(closed!.period.id).toBe('stale-close');
    expect(closed!.period).toMatchObject({ status: 'closed', entryCount: 1 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM time_entries
         WHERE id = 'stale-close-entry' AND locked_at IS NOT NULL`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(closed!.report?.snapshot.entries).toHaveLength(1);
  });

  it('uses an in-progress close as a write barrier for unlocked historic time', async () => {
    const cutoff = Date.parse('2026-08-07T10:00:00.000Z');
    await entry({
      id: 'historic-before-close',
      start: '2026-08-07T08:00:00.000Z',
      end: '2026-08-07T09:00:00.000Z',
    });
    await env.DB.prepare(
      `INSERT INTO close_periods
       (id, coverage_from, cutoff_at, kind, status, reason, suppress_delivery,
        created_at, updated_at)
       VALUES ('active-close', ?, ?, 'initial', 'closing', 'Close in progress', 1, ?, ?)`,
    )
      .bind(Date.parse('2026-08-07T00:00:00.000Z'), cutoff, cutoff, cutoff)
      .run();
    await expect(
      entry({
        id: 'late-historic-write',
        start: '2026-08-07T09:00:00.000Z',
        end: '2026-08-07T09:30:00.000Z',
      }),
    ).rejects.toThrow('LOCKED_PERIOD');
    const store = new D1TimeStore(env.DB, () => new Date(cutoff));
    await expect(store.deleteEntry(USER, 'historic-before-close')).rejects.toThrow('LOCKED_ENTRY');
    await expect(
      env.DB.prepare("UPDATE time_entries SET notes = 'race won' WHERE id = ?")
        .bind('historic-before-close')
        .run(),
    ).rejects.toThrow('LOCKED_PERIOD');
    await expect(
      env.DB.prepare('DELETE FROM time_entries WHERE id = ?').bind('historic-before-close').run(),
    ).rejects.toThrow('LOCKED_PERIOD');
  });

  it('recovers missed periods once and leaves exactly one running continuation', async () => {
    await entry({ id: 'running-2', start: '2026-08-07T09:00:00.000Z' });
    await runScheduledFridayCloses({
      db: env.DB,
      recipients: ['reports@example.com'],
      activateIfNeeded: true,
      now: new Date('2026-08-07T10:00:00.000Z'),
    });
    const recovered = await runScheduledFridayCloses({
      db: env.DB,
      recipients: ['reports@example.com'],
      now: new Date('2026-08-21T10:05:00.000Z'),
    });
    expect(recovered.map((item) => item.period.kind)).toEqual(['recovery', 'scheduled']);
    expect(recovered.map((item) => item.period.cutoffAt)).toEqual([
      '2026-08-14T10:00:00.000Z',
      '2026-08-21T10:00:00.000Z',
    ]);
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM time_entries WHERE end_at IS NULL',
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
    const locked = await env.DB.prepare(
      'SELECT start_at, end_at FROM time_entries WHERE locked_at IS NOT NULL',
    ).all<{ start_at: number; end_at: number }>();
    for (const segment of locked.results) {
      const localStart = DateTime.fromMillis(segment.start_at, { zone: 'utc' }).setZone(
        'Australia/Brisbane',
      );
      const localLastMillisecond = DateTime.fromMillis(segment.end_at - 1, {
        zone: 'utc',
      }).setZone('Australia/Brisbane');
      expect(localStart.toISODate()).toBe(localLastMillisecond.toISODate());
    }
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM close_periods').first<{
        count: number;
      }>(),
    ).toEqual({ count: 3 });
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM report_delivery_outbox').first<{
        count: number;
      }>(),
    ).toEqual({ count: 2 });
    expect(
      await runScheduledFridayCloses({
        db: env.DB,
        recipients: ['reports@example.com'],
        now: new Date('2026-08-21T10:10:00.000Z'),
      }),
    ).toEqual([]);
  });

  it('requires preview-matching confirmation and lets the next scheduled close follow a manual cutoff', async () => {
    await entry({
      id: 'completed-1',
      start: '2026-08-08T00:00:00.000Z',
      end: '2026-08-08T02:00:00.000Z',
    });
    const manualCutoff = new Date('2026-08-12T02:00:00.000Z');
    const preview = await previewFridayClose({
      db: env.DB,
      cutoff: manualCutoff,
      kind: 'manual',
      now: manualCutoff,
    });
    expect(preview).toMatchObject({
      kind: 'manual',
      coverageFrom: '2026-08-07T10:00:00.000Z',
      cutoffAt: manualCutoff.toISOString(),
      willActivate: true,
      historicalEmailSuppressed: true,
      activationBaseline: { cutoffAt: '2026-08-07T10:00:00.000Z' },
    });
    await expect(
      runManualFridayClose({
        db: env.DB,
        recipients: ['reports@example.com'],
        actorUserId: USER,
        cutoff: manualCutoff,
        confirmationCutoff: 'stale',
        reason: 'Manual billing cutoff',
        now: manualCutoff,
      }),
    ).rejects.toThrow('confirmation');
    const manual = await runManualFridayClose({
      db: env.DB,
      recipients: ['reports@example.com'],
      actorUserId: USER,
      cutoff: manualCutoff,
      confirmationCutoff: manualCutoff.toISOString(),
      reason: 'Manual billing cutoff',
      now: manualCutoff,
    });
    expect(manual.activation?.period.kind).toBe('initial');
    expect(manual.close.period).toMatchObject({
      kind: 'manual',
      coverageFrom: '2026-08-07T10:00:00.000Z',
      cutoffAt: manualCutoff.toISOString(),
    });
    const next = await runScheduledFridayCloses({
      db: env.DB,
      recipients: ['reports@example.com'],
      now: new Date('2026-08-14T10:00:00.000Z'),
    });
    expect(next).toHaveLength(1);
    expect(next[0].period).toMatchObject({
      kind: 'scheduled',
      coverageFrom: manualCutoff.toISOString(),
      cutoffAt: '2026-08-14T10:00:00.000Z',
    });
  });

  it('checks report-visible source content after acquiring the manual-close fence', async () => {
    await runScheduledFridayCloses({
      db: env.DB,
      recipients: [],
      activateIfNeeded: true,
      now: new Date('2026-08-07T10:00:00.000Z'),
    });
    await entry({
      id: 'manual-fingerprint',
      start: '2026-08-08T00:00:00.000Z',
      end: '2026-08-08T01:00:00.000Z',
    });
    const cutoff = new Date('2026-08-08T02:00:00.000Z');
    const preview = await previewFridayClose({ db: env.DB, cutoff, kind: 'manual', now: cutoff });

    // Keep entry count, duration and even the revision unchanged. The exact
    // source-content fingerprint must still notice this report-visible change.
    await env.DB.prepare("UPDATE time_entries SET notes = 'changed after preview' WHERE id = ?")
      .bind('manual-fingerprint')
      .run();

    await expect(
      runManualFridayClose({
        db: env.DB,
        recipients: [],
        actorUserId: USER,
        cutoff,
        confirmationCutoff: cutoff.toISOString(),
        expectedSourceHash: preview.sourceHash,
        reason: 'Confirm the exact reviewed source state',
        now: cutoff,
      }),
    ).rejects.toThrow('source entries changed');
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM close_periods WHERE cutoff_at = ?')
        .bind(cutoff.getTime())
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT locked_at FROM time_entries WHERE id = 'manual-fingerprint'",
      ).first<{ locked_at: number | null }>(),
    ).toEqual({ locked_at: null });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM close_audit WHERE action = 'close.confirmation_mismatch'",
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('preserves the confirmed source fingerprint across first-activation splitting', async () => {
    await entry({ id: 'activation-crossing', start: '2026-08-07T09:00:00.000Z' });
    const cutoff = new Date('2026-08-07T12:00:00.000Z');
    const preview = await previewFridayClose({ db: env.DB, cutoff, kind: 'manual', now: cutoff });
    expect(preview.activationBaseline?.cutoffAt).toBe('2026-08-07T10:00:00.000Z');
    const baseline = await previewFridayClose({
      db: env.DB,
      cutoff: new Date(preview.activationBaseline!.cutoffAt),
      kind: 'manual',
      now: cutoff,
    });
    const activation = await activateFridayClose({
      db: env.DB,
      recipients: [],
      actorUserId: USER,
      expectedSourceHash: baseline.sourceHash,
      now: cutoff,
    });
    const afterActivation = await previewFridayClose({
      db: env.DB,
      cutoff,
      kind: 'manual',
      now: cutoff,
    });
    expect(afterActivation.sourceHash).toBe(preview.sourceHash);

    const result = await runManualFridayClose({
      db: env.DB,
      recipients: [],
      actorUserId: USER,
      cutoff,
      confirmationCutoff: cutoff.toISOString(),
      expectedSourceHash: preview.sourceHash,
      reason: 'Close the confirmed post-baseline interval',
      now: cutoff,
    });

    expect(activation?.period.totalMs).toBe(60 * 60_000);
    expect(result.activation).toBeNull();
    expect(result.close.period.totalMs).toBe(2 * 60 * 60_000);
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM time_entries WHERE end_at IS NULL',
      ).first<{
        count: number;
      }>(),
    ).toEqual({ count: 1 });
  });

  it('creates an audited optimistic correction and a revised immutable report', async () => {
    await entry({
      id: 'correct-me',
      start: '2026-08-07T07:00:00.000Z',
      end: '2026-08-07T08:00:00.000Z',
    });
    await runScheduledFridayCloses({
      db: env.DB,
      recipients: ['reports@example.com'],
      activateIfNeeded: true,
      now: new Date('2026-08-07T10:00:00.000Z'),
    });
    const locked = await env.DB.prepare('SELECT revision FROM time_entries WHERE id = ?')
      .bind('correct-me')
      .first<{ revision: number }>();
    const correction = await correctLockedEntry({
      db: env.DB,
      entryId: 'correct-me',
      expectedRevision: locked!.revision,
      actorUserId: USER,
      reason: 'Corrected the recorded finish time',
      patch: {
        endAt: new Date('2026-08-07T07:45:00.000Z'),
        notes: 'Audited private correction',
      },
      reportRecipients: ['reports@example.com'],
      now: new Date('2026-08-07T11:00:00.000Z'),
    });
    expect(correction.entryRevision).toBe(locked!.revision + 1);
    expect(correction.reportPending).toBe(false);
    expect(correction.report!.version).toBe(2);
    expect(correction.report!.snapshot.totals.totalMs).toBe(45 * 60_000);
    expect(
      await env.DB.prepare('SELECT revised_report_id FROM locked_entry_corrections').first<{
        revised_report_id: string;
      }>(),
    ).toEqual({ revised_report_id: correction.report!.id });
    await expect(
      correctLockedEntry({
        db: env.DB,
        entryId: 'correct-me',
        expectedRevision: locked!.revision,
        actorUserId: USER,
        reason: 'Stale concurrent correction',
        patch: { notes: 'This must not win' },
        reportRecipients: ['reports@example.com'],
      }),
    ).rejects.toThrow('ENTRY_REVISION_CONFLICT');
  });

  it('rebuilds instead of queuing a stale report when a correction commits during rendering', async () => {
    await entry({
      id: 'report-race-entry',
      start: '2026-08-07T07:00:00.000Z',
      end: '2026-08-07T08:00:00.000Z',
    });
    await runScheduledFridayCloses({
      db: env.DB,
      recipients: ['reports@example.com'],
      activateIfNeeded: true,
      now: new Date('2026-08-07T10:00:00.000Z'),
    });
    const period = await env.DB.prepare(
      'SELECT id FROM close_periods ORDER BY cutoff_at DESC LIMIT 1',
    ).first<{ id: string }>();
    const locked = await env.DB.prepare(
      "SELECT revision FROM time_entries WHERE id = 'report-race-entry'",
    ).first<{ revision: number }>();

    let correctionBatchCalls = 0;
    const correctionDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            correctionBatchCalls += 1;
            if (correctionBatchCalls === 2)
              throw new Error('Injected report persistence failure after correction commit');
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let correctionInserted = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!correctionInserted) {
              correctionInserted = true;
              const correction = await correctLockedEntry({
                db: correctionDb,
                entryId: 'report-race-entry',
                expectedRevision: locked!.revision,
                actorUserId: USER,
                reason: 'Correction committed during report rendering',
                patch: { endAt: new Date('2026-08-07T07:45:00.000Z') },
                reportRecipients: ['reports@example.com'],
                now: new Date('2026-08-07T10:30:00.000Z'),
              });
              expect(correction.reportPending).toBe(true);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const report = await saveCloseReportVersion({
      db: racingDb,
      periodId: period!.id,
      recipients: ['reports@example.com'],
      correctionReason: 'Concurrent report generation',
      createdByUserId: USER,
      now: new Date('2026-08-07T11:00:00.000Z'),
    });

    expect(correctionBatchCalls).toBe(2);
    expect(report.version).toBe(2);
    expect(report.snapshot.period.sourceRevision).toBe(1);
    expect(report.snapshot.totals.totalMs).toBe(45 * 60_000);
    expect(
      await env.DB.prepare(`SELECT source_revision, total_ms FROM close_periods WHERE id = ?`)
        .bind(period!.id)
        .first<{ source_revision: number; total_ms: number }>(),
    ).toEqual({ source_revision: 1, total_ms: 45 * 60_000 });
    expect(
      await env.DB.prepare(
        `SELECT source_revision FROM report_versions
           WHERE close_period_id = ? AND version = 2`,
      )
        .bind(period!.id)
        .first<{ source_revision: number }>(),
    ).toEqual({ source_revision: 1 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM report_delivery_outbox
           WHERE report_id = ? AND state = 'queued'`,
      )
        .bind(report.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    await expect(
      env.DB.prepare('UPDATE close_periods SET source_revision = source_revision + 2 WHERE id = ?')
        .bind(period!.id)
        .run(),
    ).rejects.toThrow('CLOSE_SOURCE_REVISION_CONFLICT');
  });

  it('rejects a correction that would recreate a cross-midnight segment', async () => {
    await entry({
      id: 'midnight-correction',
      start: '2026-08-06T12:00:00.000Z',
      end: '2026-08-06T13:00:00.000Z',
    });
    await runScheduledFridayCloses({
      db: env.DB,
      recipients: [],
      activateIfNeeded: true,
      now: new Date('2026-08-07T10:00:00.000Z'),
    });
    const locked = await env.DB.prepare(
      "SELECT revision FROM time_entries WHERE id = 'midnight-correction'",
    ).first<{ revision: number }>();
    await expect(
      correctLockedEntry({
        db: env.DB,
        entryId: 'midnight-correction',
        expectedRevision: locked!.revision,
        actorUserId: USER,
        reason: 'Attempt a cross-midnight correction',
        patch: { endAt: new Date('2026-08-06T14:30:00.000Z') },
        reportRecipients: [],
      }),
    ).rejects.toThrow('one Brisbane calendar day');
  });

  it('cancels every wholly-unsent sibling upload when one approved entry is corrected', async () => {
    await entry({
      id: 'approval-entry-1',
      start: '2026-08-07T06:00:00.000Z',
      end: '2026-08-07T07:00:00.000Z',
    });
    await entry({
      id: 'approval-entry-2',
      start: '2026-08-07T07:00:00.000Z',
      end: '2026-08-07T08:00:00.000Z',
    });
    await runScheduledFridayCloses({
      db: env.DB,
      recipients: [],
      activateIfNeeded: true,
      now: new Date('2026-08-07T10:00:00.000Z'),
    });
    await approvedXeroUpload(['approval-entry-1', 'approval-entry-2'], 'approval-multi');
    const locked = await env.DB.prepare(
      "SELECT revision FROM time_entries WHERE id = 'approval-entry-1'",
    ).first<{ revision: number }>();
    await correctLockedEntry({
      db: env.DB,
      entryId: 'approval-entry-1',
      expectedRevision: locked!.revision,
      actorUserId: USER,
      reason: 'Correct an entry before any Xero upload',
      patch: { notes: 'Corrected' },
      reportRecipients: [],
      now: new Date('2026-08-07T11:00:00.000Z'),
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM xero_projects_upload_outbox WHERE state = 'cancelled'",
      ).first<{ count: number }>(),
    ).toEqual({ count: 2 });
    expect(
      await env.DB.prepare(
        "SELECT state FROM xero_projects_approvals WHERE id = 'approval-multi'",
      ).first<{ state: string }>(),
    ).toEqual({ state: 'cancelled' });
  });

  it('cancels a later unsent segment approval when earlier lineage duration changes', async () => {
    await entry({
      id: 'lineage-root-queued',
      start: '2026-08-07T06:00:00.000Z',
      end: '2026-08-07T07:00:00.000Z',
    });
    await entry({
      id: 'lineage-later-queued',
      start: '2026-08-07T07:00:00.000Z',
      end: '2026-08-07T08:00:00.000Z',
    });
    await env.DB.prepare(
      `UPDATE time_entries
       SET segment_root_id='lineage-root-queued',segment_parent_id='lineage-root-queued',segment_index=1
       WHERE id='lineage-later-queued'`,
    ).run();
    await runScheduledFridayCloses({
      db: env.DB,
      recipients: [],
      activateIfNeeded: true,
      now: new Date('2026-08-07T10:00:00.000Z'),
    });
    await approvedXeroUpload(['lineage-later-queued'], 'approval-lineage-queued');
    const root = await env.DB.prepare(
      "SELECT revision FROM time_entries WHERE id='lineage-root-queued'",
    ).first<{ revision: number }>();

    await correctLockedEntry({
      db: env.DB,
      entryId: 'lineage-root-queued',
      expectedRevision: root!.revision,
      actorUserId: USER,
      reason: 'Correct the earlier split duration before Xero upload',
      patch: { endAt: new Date('2026-08-07T06:45:00.000Z') },
      reportRecipients: [],
      now: new Date('2026-08-07T11:00:00.000Z'),
    });

    expect(
      await env.DB.prepare(
        "SELECT state,last_error_code FROM xero_projects_upload_outbox WHERE entry_id='lineage-later-queued'",
      ).first(),
    ).toEqual({ state: 'cancelled', last_error_code: 'SOURCE_CORRECTED' });
    expect(
      await env.DB.prepare(
        "SELECT state FROM xero_projects_approvals WHERE id='approval-lineage-queued'",
      ).first(),
    ).toEqual({ state: 'cancelled' });
  });

  it('blocks an in-flight later segment and flags it for reconciliation once accepted', async () => {
    await entry({
      id: 'lineage-root-accepted',
      start: '2026-08-07T06:00:00.000Z',
      end: '2026-08-07T07:00:00.000Z',
    });
    await entry({
      id: 'lineage-later-accepted',
      start: '2026-08-07T07:00:00.000Z',
      end: '2026-08-07T08:00:00.000Z',
    });
    await env.DB.prepare(
      `UPDATE time_entries
       SET segment_root_id='lineage-root-accepted',segment_parent_id='lineage-root-accepted',segment_index=1
       WHERE id='lineage-later-accepted'`,
    ).run();
    await runScheduledFridayCloses({
      db: env.DB,
      recipients: [],
      activateIfNeeded: true,
      now: new Date('2026-08-07T10:00:00.000Z'),
    });
    await approvedXeroUpload(['lineage-later-accepted'], 'approval-lineage-accepted');
    await env.DB.prepare(
      `UPDATE xero_projects_upload_outbox
       SET state='leased',attempts=1,first_attempt_at=?,lease_token='lineage-lease',lease_until=?
       WHERE entry_id='lineage-later-accepted'`,
    )
      .bind(Date.parse('2026-08-07T10:30:00.000Z'), Date.parse('2026-08-07T12:00:00.000Z'))
      .run();
    const root = await env.DB.prepare(
      "SELECT revision FROM time_entries WHERE id='lineage-root-accepted'",
    ).first<{ revision: number }>();
    const correction = {
      db: env.DB,
      entryId: 'lineage-root-accepted',
      expectedRevision: root!.revision,
      actorUserId: USER,
      reason: 'Correct the earlier split duration after Xero upload',
      patch: { endAt: new Date('2026-08-07T06:45:00.000Z') },
      reportRecipients: [],
      now: new Date('2026-08-07T11:00:00.000Z'),
    };
    await expect(correctLockedEntry(correction)).rejects.toThrow(
      'XERO_UPLOAD_RECONCILIATION_REQUIRED',
    );
    await env.DB.prepare(
      `UPDATE xero_projects_upload_outbox
       SET state='provider_accepted',lease_token=NULL,lease_until=0,
           remote_time_entry_id='remote-lineage-time'
       WHERE entry_id='lineage-later-accepted'`,
    ).run();
    await correctLockedEntry(correction);

    const accepted = await env.DB.prepare(
      `SELECT state,source_drift,last_error_code,remote_drift_json
       FROM xero_projects_upload_outbox WHERE entry_id='lineage-later-accepted'`,
    ).first<{
      state: string;
      source_drift: number;
      last_error_code: string | null;
      remote_drift_json: string;
    }>();
    expect(accepted).toMatchObject({
      state: 'provider_accepted',
      source_drift: 1,
      last_error_code: 'SOURCE_CORRECTED',
    });
    expect(JSON.parse(accepted!.remote_drift_json)).toMatchObject({
      lineageDurationChanged: true,
      segmentRootId: 'lineage-root-accepted',
      segmentIndex: 0,
    });
  });

  it('blocks a locked correction while any sibling Xero upload may be in flight', async () => {
    await entry({
      id: 'leased-entry',
      start: '2026-08-07T07:00:00.000Z',
      end: '2026-08-07T08:00:00.000Z',
    });
    await runScheduledFridayCloses({
      db: env.DB,
      recipients: [],
      activateIfNeeded: true,
      now: new Date('2026-08-07T10:00:00.000Z'),
    });
    await approvedXeroUpload(['leased-entry'], 'approval-leased');
    await env.DB.prepare(
      `UPDATE xero_projects_upload_outbox SET state = 'leased', attempts = 1,
       lease_token = 'active-lease', lease_until = ? WHERE approval_id = 'approval-leased'`,
    )
      .bind(Date.parse('2026-08-07T12:00:00.000Z'))
      .run();
    const locked = await env.DB.prepare(
      "SELECT revision FROM time_entries WHERE id = 'leased-entry'",
    ).first<{ revision: number }>();
    await expect(
      correctLockedEntry({
        db: env.DB,
        entryId: 'leased-entry',
        expectedRevision: locked!.revision,
        actorUserId: USER,
        reason: 'Must wait for reconciliation',
        patch: { notes: 'Must not commit' },
        reportRecipients: [],
      }),
    ).rejects.toThrow('XERO_UPLOAD_RECONCILIATION_REQUIRED');
    expect(
      await env.DB.prepare(
        "SELECT state, attempts FROM xero_projects_upload_outbox WHERE approval_id = 'approval-leased'",
      ).first<{ state: string; attempts: number }>(),
    ).toEqual({ state: 'leased', attempts: 1 });
    expect(
      await env.DB.prepare("SELECT revision FROM time_entries WHERE id = 'leased-entry'").first<{
        revision: number;
      }>(),
    ).toEqual({ revision: locked!.revision });
  });

  it('delivers each immutable report version once and quarantines stale ambiguous outcomes', async () => {
    await runScheduledFridayCloses({
      db: env.DB,
      recipients: ['one@example.com', 'two@example.com'],
      activateIfNeeded: true,
      now: new Date('2026-08-07T10:00:00.000Z'),
    });
    await entry({
      id: 'delivery-entry',
      start: '2026-08-08T00:00:00.000Z',
      end: '2026-08-08T01:00:00.000Z',
    });
    const cutoff = new Date('2026-08-08T02:00:00.000Z');
    await runManualFridayClose({
      db: env.DB,
      recipients: ['one@example.com', 'two@example.com'],
      actorUserId: USER,
      cutoff,
      confirmationCutoff: cutoff.toISOString(),
      reason: 'Prepare an interim billing report',
      now: cutoff,
    });
    const sent: string[] = [];
    const result = await processReportDeliveryOutbox({
      db: env.DB,
      from: 'reports@versatile.example',
      now: cutoff,
      mailer: {
        async send(message) {
          expect(message.attachments.map((item) => item.filename).sort()).toHaveLength(3);
          sent.push(message.to);
          return `provider-${message.to}`;
        },
      },
    });
    expect(result.accepted).toBe(2);
    expect(sent.sort()).toEqual(['one@example.com', 'two@example.com']);
    expect(
      await processReportDeliveryOutbox({
        db: env.DB,
        from: 'reports@versatile.example',
        now: new Date(cutoff.getTime() + 60_000),
        mailer: {
          async send() {
            throw new Error('must not resend');
          },
        },
      }),
    ).toEqual({ accepted: 0, retried: 0, needsAttention: 0 });

    await env.DB.prepare(
      `UPDATE report_delivery_outbox SET state = 'queued', attempts = 0,
       next_attempt_at = ?, write_started_at = NULL, provider_message_id = NULL,
       accepted_at = NULL WHERE recipient = 'one@example.com'`,
    )
      .bind(cutoff.getTime())
      .run();
    const ambiguous = await processReportDeliveryOutbox({
      db: env.DB,
      from: 'reports@versatile.example',
      now: cutoff,
      mailer: {
        async send() {
          throw new ReportDeliveryError('Network timeout after request write', true, true);
        },
      },
    });
    expect(ambiguous.retried).toBe(1);
    const afterWindow = await processReportDeliveryOutbox({
      db: env.DB,
      from: 'reports@versatile.example',
      now: new Date(cutoff.getTime() + 24 * 60 * 60_000 + 1),
      mailer: {
        async send() {
          throw new Error('quarantine should prevent this');
        },
      },
    });
    expect(afterWindow).toEqual({ accepted: 0, retried: 0, needsAttention: 1 });
    expect(
      await env.DB.prepare(
        `SELECT state FROM report_delivery_outbox WHERE recipient = 'one@example.com'`,
      ).first<{ state: string }>(),
    ).toEqual({ state: 'needs_attention' });

    await env.DB.prepare(
      `UPDATE report_delivery_outbox SET state = 'queued', attempts = 0,
       next_attempt_at = ?, write_started_at = NULL, provider_message_id = NULL,
       accepted_at = NULL WHERE recipient = 'two@example.com'`,
    )
      .bind(cutoff.getTime())
      .run();
    await env.DB.prepare(
      `UPDATE report_artifacts SET content = ? WHERE format = 'csv'
       AND report_id = (SELECT report_id FROM report_delivery_outbox
                        WHERE recipient = 'two@example.com')`,
    )
      .bind(new TextEncoder().encode('tampered bytes'))
      .run();
    let corruptedSendCalls = 0;
    const corrupted = await processReportDeliveryOutbox({
      db: env.DB,
      from: 'reports@versatile.example',
      now: cutoff,
      mailer: {
        async send() {
          corruptedSendCalls += 1;
          return 'must-not-send';
        },
      },
    });
    expect(corrupted).toEqual({ accepted: 0, retried: 0, needsAttention: 1 });
    expect(corruptedSendCalls).toBe(0);
  });
});
