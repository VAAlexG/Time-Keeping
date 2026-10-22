import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1TimeStore } from '../server/d1-store';
import { base64, decrypt, encrypt, sha256 } from '../server/xero/crypto';
import {
  accessToken,
  beginConnection,
  disconnectConnection,
  finishConnection,
  saveControls,
  XERO_SCOPES,
} from '../server/xero/oauth';
import { refreshCatalogue, saveEntrySelection } from '../server/xero/catalog';
import {
  billingLabel,
  claimUpload,
  listBillingReview,
  processNextUpload,
  quarantineExpiredUploadLeases,
  reconcileUpload,
  refreshAcceptedStatuses,
} from '../server/xero/outbox';
import {
  approveReview,
  brisbaneWorkDate,
  cancelApproval,
  localBillableConflictsWithChargeType,
  previewReview,
  roundDurationToWholeMinutes,
  roundLineageSegmentToWholeMinutes,
} from '../server/xero/review';
import type { Actor, XeroEnv } from '../server/xero/types';
import { billingReviewData } from '../worker/xero-projects-view';

const LOCAL_USER = '10000000-0000-4000-8000-000000000001';
const LOCAL_CLIENT = '20000000-0000-4000-8000-000000000001';
const LOCAL_JOB = '30000000-0000-4000-8000-000000000001';
const LEGACY_PROJECT = '40000000-0000-4000-8000-000000000001';
const ENTRY = '50000000-0000-4000-8000-000000000001';
const ENTRY_TWO = '50000000-0000-4000-8000-000000000002';
const ENTRY_PRIOR = '50000000-0000-4000-8000-000000000003';
const ENTRY_THREE = '50000000-0000-4000-8000-000000000004';
const ENTRY_LINEAGE = '50000000-0000-4000-8000-000000000005';
const TENANT = '60000000-0000-4000-8000-000000000001';
const CONTACT = '70000000-0000-4000-8000-000000000001';
const XERO_PROJECT = '80000000-0000-4000-8000-000000000001';
const XERO_TASK = '90000000-0000-4000-8000-000000000001';
const XERO_USER = 'a0000000-0000-4000-8000-000000000001';
const START = Date.parse('2026-10-20T23:30:00.000Z'); // 21 Oct in Brisbane.
const END = START + 90_500;
const NOW = Date.parse('2026-10-22T00:00:00.000Z');
const key = base64(new Uint8Array(32).fill(13));

const actor: Actor = {
  id: LOCAL_USER,
  email: 'alexg@versatileaccounting.com.au',
  displayName: 'Alex',
  role: 'admin',
};

function bindings(): XeroEnv {
  return {
    DB: env.DB,
    XERO_ENABLED: 'true',
    XERO_CLIENT_ID: 'client-id',
    XERO_CLIENT_SECRET: 'client-secret',
    XERO_REDIRECT_URI: 'https://timekeeper.example/api/projects/oauth/callback',
    XERO_TOKEN_KEY: key,
    XERO_REVIEWER_EMAILS: 'suzieg@versatileaccounting.com.au',
    ALLOWED_EMAIL_DOMAIN: 'versatileaccounting.com.au',
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM xero_projects_upload_outbox'),
    env.DB.prepare('DELETE FROM xero_projects_approval_items'),
    env.DB.prepare('DELETE FROM xero_projects_approvals'),
    env.DB.prepare('DELETE FROM xero_projects_entry_selections'),
    env.DB.prepare('DELETE FROM xero_projects_work_links'),
    env.DB.prepare('DELETE FROM xero_projects_user_links'),
    env.DB.prepare('DELETE FROM xero_projects_client_links'),
    env.DB.prepare('DELETE FROM xero_projects_catalog'),
    env.DB.prepare('DELETE FROM xero_projects_audit'),
    env.DB.prepare('DELETE FROM xero_projects_oauth_states'),
  ]);
  await env.DB.prepare(
    `UPDATE xero_projects_connection
       SET tenant_id=NULL,tenant_name=NULL,connection_id=NULL,
           encrypted_tokens=NULL,expires_at=0,pending_connections_json=NULL,
           pending_actor_id=NULL,connected=0,paused=1,cutover_at=NULL,
           refresh_lease_token=NULL,refresh_lease_until=0,
           catalogue_lease_token=NULL,catalogue_lease_until=0,
            throttle_until=0,token_revision=1,connection_revision=1,catalogue_revision=0,
           mapping_revision=0,updated_at=0 WHERE id=1`,
  ).run();
});

async function seedReviewedEntry(
  options: { billable?: boolean; chargeType?: 'TIME' | 'FIXED' | 'NON_CHARGEABLE' } = {},
): Promise<void> {
  const billable = options.billable ?? true;
  const chargeType = options.chargeType ?? 'TIME';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO users
         (id,access_subject,email,display_name,role,created_at,updated_at,last_seen_at)
         VALUES(?,?,'alexg@versatileaccounting.com.au','Alex','admin',?,?,?)`,
    ).bind(LOCAL_USER, `subject:${LOCAL_USER}`, NOW, NOW, NOW),
    env.DB.prepare(
      `INSERT OR IGNORE INTO clients
         (id,external_id,source,name,active,created_at,updated_at,synced_at)
         VALUES(?,'client-1','fyi','Example Client',1,?,?,?)`,
    ).bind(LOCAL_CLIENT, NOW, NOW, NOW),
    env.DB.prepare(
      `INSERT OR IGNORE INTO jobs
         (id,external_id,client_id,source,name,active,default_billable,
          created_at,updated_at,synced_at)
         VALUES(?,'job-1',?,'fyi','Annual accounts',1,1,?,?,?)`,
    ).bind(LOCAL_JOB, LOCAL_CLIENT, NOW, NOW, NOW),
    env.DB.prepare(
      `INSERT OR IGNORE INTO projects(id,name,name_key,created_at)
         VALUES(?,'Legacy','legacy',?)`,
    ).bind(LEGACY_PROJECT, NOW),
    env.DB.prepare(
      `INSERT OR IGNORE INTO time_entries
         (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,
          user_id,work_type,client_id,job_id,billable,client_name_snapshot,
          client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
          client_description,revision,locked_at,segment_root_id,segment_index,
          original_start_at,original_end_at)
         VALUES(?,?,'INTERNAL: do not upload',?,?,NULL,?,?,?,'client',?,?,?,
                'Example Client','client-1','Annual accounts','job-1',
                'Prepare annual financial statements',1,?,?,0,?,?)`,
    ).bind(
      ENTRY,
      LEGACY_PROJECT,
      START,
      END,
      NOW,
      NOW,
      LOCAL_USER,
      LOCAL_CLIENT,
      LOCAL_JOB,
      Number(billable),
      NOW,
      ENTRY,
      START,
      END,
    ),
  ]);
  const encryptedTokens = await encrypt(
    { access_token: 'access-token', refresh_token: 'refresh-token' },
    key,
    'timekeeper:xero-projects:connection:v1',
  );
  const project = {
    projectId: XERO_PROJECT,
    contactId: CONTACT,
    name: 'Annual accounts 2026',
    status: 'INPROGRESS',
  };
  const task = {
    taskId: XERO_TASK,
    projectId: XERO_PROJECT,
    name: 'Compliance work',
    chargeType,
    rate: { currency: 'AUD', value: 225 },
    status: 'ACTIVE',
  };
  const user = {
    userId: XERO_USER,
    name: 'Alex',
    email: 'alexg@versatileaccounting.com.au',
  };
  const contact = {
    ContactID: CONTACT,
    Name: 'Example Client',
    ContactStatus: 'ACTIVE',
  };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE xero_projects_connection
         SET tenant_id=?,tenant_name='Versatile Accounting',connection_id=?,
             encrypted_tokens=?,expires_at=?,connected=1,paused=0,cutover_at=?,
             catalogue_revision=3,mapping_revision=4,updated_at=? WHERE id=1`,
    ).bind(TENANT, CONTACT, encryptedTokens, NOW + 3_600_000, START - 1, NOW),
    env.DB.prepare(
      `INSERT INTO xero_projects_client_links
         VALUES(?,?,?,'Example Client',1,?,?)`,
    ).bind(TENANT, LOCAL_CLIENT, CONTACT, LOCAL_USER, NOW),
    env.DB.prepare(
      `INSERT INTO xero_projects_user_links
         VALUES(?,?,?,'alexg@versatileaccounting.com.au',1,?,?)`,
    ).bind(TENANT, LOCAL_USER, XERO_USER, LOCAL_USER, NOW),
    ...[
      ['project', XERO_PROJECT, CONTACT, project],
      ['task', XERO_TASK, XERO_PROJECT, task],
      ['user', XERO_USER, '', user],
      ['contact', CONTACT, '', contact],
    ].map(([kind, id, parent, data]) =>
      env.DB.prepare(
        `INSERT INTO xero_projects_catalog
           VALUES(?,?,?,?,?,1,?,3)`,
      ).bind(TENANT, kind, id, parent, JSON.stringify(data), NOW),
    ),
    env.DB.prepare(
      `INSERT INTO xero_projects_entry_selections
         VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    ).bind(
      ENTRY,
      TENANT,
      XERO_PROJECT,
      XERO_TASK,
      project.name,
      task.name,
      task.chargeType,
      task.rate.currency,
      task.rate.value,
      3,
      3,
      LOCAL_USER,
      NOW,
    ),
  ]);
}

async function cloneUnlockedReviewedEntry(): Promise<string> {
  const entryId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO time_entries
       (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,
        user_id,work_type,client_id,job_id,billable,client_name_snapshot,
        client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
        client_description,revision,locked_at,segment_root_id,segment_index,
        original_start_at,original_end_at)
       SELECT ?,project_id,notes,start_at,end_at,NULL,created_at,updated_at,
        user_id,work_type,client_id,job_id,billable,client_name_snapshot,
        client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
        client_description,revision,NULL,?,segment_index,original_start_at,original_end_at
       FROM time_entries WHERE id=?`,
    ).bind(entryId, entryId, ENTRY),
    env.DB.prepare(
      `INSERT INTO xero_projects_entry_selections
       (entry_id,tenant_id,project_id,task_id,project_name_snapshot,
        task_name_snapshot,task_charge_type_snapshot,task_rate_currency_snapshot,
        task_rate_value_snapshot,project_catalogue_revision,task_catalogue_revision,
        selection_revision,selected_by_user_id,selected_at)
       SELECT ?,tenant_id,project_id,task_id,project_name_snapshot,
        task_name_snapshot,task_charge_type_snapshot,task_rate_currency_snapshot,
        task_rate_value_snapshot,project_catalogue_revision,task_catalogue_revision,
        selection_revision,selected_by_user_id,selected_at
       FROM xero_projects_entry_selections WHERE entry_id=?`,
    ).bind(entryId, ENTRY),
  ]);
  return entryId;
}

async function approveSeededEntry(): Promise<{ approvalId: string }> {
  await seedReviewedEntry();
  const preview = await previewReview(bindings(), actor, [ENTRY], NOW);
  expect(preview.ready).toBe(true);
  return approveReview(
    bindings(),
    actor,
    {
      entryIds: [ENTRY],
      expectedPreviewHash: preview.previewHash,
      acknowledgedWarnings: preview.warnings.map((warning) => warning.code),
    },
    NOW,
  );
}

async function seedSecondReviewedEntry(entryId = ENTRY_TWO): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO time_entries
         (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,
          user_id,work_type,client_id,job_id,billable,client_name_snapshot,
          client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
          client_description,revision,locked_at,segment_root_id,segment_index,
          original_start_at,original_end_at)
       SELECT ?,project_id,notes,start_at,end_at,NULL,created_at,updated_at,
          user_id,work_type,client_id,job_id,billable,client_name_snapshot,
          client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
          client_description,revision,locked_at,?,0,original_start_at,original_end_at
         FROM time_entries WHERE id=?`,
    ).bind(entryId, entryId, ENTRY),
    env.DB.prepare(
      `INSERT INTO xero_projects_entry_selections
         (entry_id,tenant_id,project_id,task_id,project_name_snapshot,
          task_name_snapshot,task_charge_type_snapshot,task_rate_currency_snapshot,
          task_rate_value_snapshot,project_catalogue_revision,task_catalogue_revision,
          selection_revision,selected_by_user_id,selected_at)
       SELECT ?,tenant_id,project_id,task_id,project_name_snapshot,
          task_name_snapshot,task_charge_type_snapshot,task_rate_currency_snapshot,
          task_rate_value_snapshot,project_catalogue_revision,task_catalogue_revision,
          selection_revision,selected_by_user_id,selected_at
         FROM xero_projects_entry_selections WHERE entry_id=?`,
    ).bind(entryId, ENTRY),
  ]);
}

function remoteTime(timeEntryId: string) {
  return {
    timeEntryId,
    projectId: XERO_PROJECT,
    userId: XERO_USER,
    taskId: XERO_TASK,
    dateUtc: '2026-10-21T00:00:00.000Z',
    duration: 2,
    description: 'Prepare annual financial statements',
    status: 'ACTIVE',
  };
}

describe('reviewed Xero Projects workflow', () => {
  it('detects both directions of local billable and Xero charge-type mismatch', () => {
    expect(localBillableConflictsWithChargeType(true, 'NON_CHARGEABLE')).toBe(true);
    expect(localBillableConflictsWithChargeType(false, 'TIME')).toBe(true);
    expect(localBillableConflictsWithChargeType(false, 'FIXED')).toBe(true);
    expect(localBillableConflictsWithChargeType(true, 'TIME')).toBe(false);
    expect(localBillableConflictsWithChargeType(true, 'FIXED')).toBe(false);
    expect(localBillableConflictsWithChargeType(false, 'NON_CHARGEABLE')).toBe(false);
  });

  it('uses confidential OAuth state without putting PKCE or secrets in the URL', async () => {
    const result = await beginConnection(bindings(), actor, 'https://timekeeper.example', NOW);
    const url = new URL(result.authorisationUrl);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.href).not.toContain('client-secret');
    expect(
      await env.DB.prepare('SELECT state_hash FROM xero_projects_oauth_states').first(),
    ).not.toEqual({ state_hash: url.searchParams.get('state') });
  });

  it('disconnects fail-closed while preserving the selected tenant and audit', async () => {
    await env.DB.prepare(
      `UPDATE xero_projects_connection
         SET tenant_id=?,tenant_name='Versatile Accounting',connected=1,paused=0,
             encrypted_tokens='encrypted-fixture',expires_at=?,updated_at=? WHERE id=1`,
    )
      .bind(TENANT, NOW + 60_000, NOW)
      .run();
    await expect(disconnectConnection(bindings(), actor, false, NOW)).rejects.toMatchObject({
      code: 'DISCONNECT_CONFIRMATION',
    });
    await expect(
      disconnectConnection({ ...bindings(), XERO_ENABLED: 'false' }, actor, true, NOW),
    ).resolves.toEqual({ disconnected: true });
    expect(
      await env.DB.prepare(
        `SELECT tenant_id,connected,paused,encrypted_tokens
           FROM xero_projects_connection WHERE id=1`,
      ).first(),
    ).toEqual({
      tenant_id: TENANT,
      connected: 0,
      paused: 1,
      encrypted_tokens: null,
    });
    expect(
      await env.DB.prepare(
        `SELECT action FROM xero_projects_audit
           WHERE action='connection_disconnected'`,
      ).first(),
    ).toEqual({ action: 'connection_disconnected' });
  });

  it('rejects an OAuth token response when required scopes are missing or empty', async () => {
    const started = await beginConnection(bindings(), actor, 'https://timekeeper.example', NOW);
    const state = new URL(started.authorisationUrl).searchParams.get('state');
    const callback = new URL('https://timekeeper.example/api/projects/oauth/callback');
    callback.searchParams.set('state', state!);
    callback.searchParams.set('code', 'authorisation-code');
    await expect(
      finishConnection(
        bindings(),
        actor,
        callback,
        async () =>
          Response.json({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 1800,
          }),
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'MISSING_SCOPE' });
  });

  it('keeps a rotated refresh token when an administrator pauses during refresh', async () => {
    await seedReviewedEntry();
    await env.DB.prepare(
      `UPDATE xero_projects_connection
          SET expires_at=0,token_revision=7,connection_revision=11 WHERE id=1`,
    ).run();
    const result = await accessToken(
      bindings(),
      async () => {
        await saveControls(bindings(), actor, { cutoverAt: START - 1, paused: true }, NOW + 1);
        return Response.json({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 1800,
          scope: XERO_SCOPES,
        });
      },
      NOW,
    );
    expect(result).toMatchObject({ token: 'rotated-access', revision: 8 });
    const saved = await env.DB.prepare(
      `SELECT encrypted_tokens,paused,token_revision,connection_revision
         FROM xero_projects_connection WHERE id=1`,
    ).first<{
      encrypted_tokens: string;
      paused: number;
      token_revision: number;
      connection_revision: number;
    }>();
    expect(saved).toMatchObject({ paused: 1, token_revision: 8, connection_revision: 12 });
    expect(
      await decrypt<{ access_token: string; refresh_token: string }>(
        saved!.encrypted_tokens,
        key,
        'timekeeper:xero-projects:connection:v1',
      ),
    ).toEqual({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
  });

  it('uses deterministic visible minute rounding and Brisbane work dates', () => {
    expect(roundDurationToWholeMinutes(90_500)).toEqual({
      roundedMinutes: 2,
      roundingDeltaSeconds: 29.5,
    });
    expect(brisbaneWorkDate(START)).toBe('2026-10-21');
    expect(billingLabel('INVOICED')).toContain('not payment proof');
    const lineageAllocations = [0, 20_000, 40_000].map(
      (before) => roundLineageSegmentToWholeMinutes(20_000, before).roundedMinutes,
    );
    expect(lineageAllocations).toEqual([0, 1, 0]);
    expect(lineageAllocations.reduce((sum, value) => sum + value, 0)).toBe(
      roundDurationToWholeMinutes(60_000).roundedMinutes,
    );
  });

  it('activates a complete paginated project, task and user catalogue', async () => {
    const encryptedTokens = await encrypt(
      { access_token: 'access-token', refresh_token: 'refresh-token' },
      key,
      'timekeeper:xero-projects:connection:v1',
    );
    await env.DB.prepare(
      `UPDATE xero_projects_connection
         SET tenant_id=?,tenant_name='Versatile Accounting',connection_id=?,
             encrypted_tokens=?,expires_at=?,connected=1,paused=1,updated_at=?
         WHERE id=1`,
    )
      .bind(TENANT, CONTACT, encryptedTokens, NOW + 3_600_000, NOW)
      .run();
    const project = {
      projectId: XERO_PROJECT,
      contactId: CONTACT,
      name: 'Annual accounts 2026',
      status: 'INPROGRESS',
    };
    const task = {
      taskId: XERO_TASK,
      projectId: XERO_PROJECT,
      name: 'Compliance work',
      chargeType: 'TIME',
      rate: { currency: 'AUD', value: 225 },
    };
    const user = {
      userId: XERO_USER,
      name: 'Alex',
      email: 'alexg@versatileaccounting.com.au',
    };
    const contact = {
      ContactID: CONTACT,
      Name: 'Example Client',
      ContactStatus: 'ACTIVE',
      BankAccountDetails: 'must-never-be-stored',
      TaxNumber: 'must-never-be-stored',
    };
    const result = await refreshCatalogue(
      bindings(),
      actor,
      async (input) => {
        const url = new URL(String(input));
        const response = url.pathname.endsWith('/Projects')
          ? [project]
          : url.pathname.endsWith('/ProjectsUsers')
            ? [user]
            : url.pathname.endsWith(`/Projects/${XERO_PROJECT}/Tasks`)
              ? [task]
              : url.pathname.endsWith('/Contacts')
                ? [contact]
                : null;
        if (!response) return new Response(null, { status: 404 });
        return Response.json(
          url.pathname.endsWith('/Contacts')
            ? { Contacts: response }
            : {
                items: response,
                pagination: { page: 1, pageCount: 1 },
              },
        );
      },
      NOW,
    );
    expect(result).toMatchObject({ projects: 1, tasks: 1, users: 1, contacts: 1 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM xero_projects_catalog
           WHERE tenant_id=? AND active=1`,
      )
        .bind(TENANT)
        .first<{ count: number }>(),
    ).toEqual({ count: 4 });
    const storedContact = await env.DB.prepare(
      `SELECT data_json FROM xero_projects_catalog
         WHERE tenant_id=? AND kind='contact' AND resource_id=?`,
    )
      .bind(TENANT, CONTACT)
      .first<{ data_json: string }>();
    expect(storedContact?.data_json).not.toContain('must-never-be-stored');
  });

  it('hard-blocks review when the active contact catalogue is missing or over 24 hours old', async () => {
    await seedReviewedEntry();
    await env.DB.prepare(
      `UPDATE xero_projects_catalog SET fetched_at=?
       WHERE tenant_id=? AND kind='contact' AND resource_id=?`,
    )
      .bind(NOW - 24 * 60 * 60_000 - 1, TENANT, CONTACT)
      .run();
    const stale = await previewReview(bindings(), actor, [ENTRY], NOW);
    expect(stale.ready).toBe(false);
    expect(stale.blockingIssues).toContainEqual(
      expect.objectContaining({ code: 'CATALOGUE_STALE' }),
    );
    expect(stale.warnings.map((warning) => warning.code)).not.toContain('CATALOGUE_STALE');

    await env.DB.prepare(
      `UPDATE xero_projects_catalog SET active=0,fetched_at=?
       WHERE tenant_id=? AND kind='contact' AND resource_id=?`,
    )
      .bind(NOW, TENANT, CONTACT)
      .run();
    const inactive = await previewReview(bindings(), actor, [ENTRY], NOW);
    expect(inactive.ready).toBe(false);
    expect(inactive.blockingIssues).toContainEqual(
      expect.objectContaining({ code: 'CATALOGUE_MISSING' }),
    );
  });

  it('aborts approval atomically if the active contact changes after preview validation', async () => {
    await seedReviewedEntry();
    const preview = await previewReview(bindings(), actor, [ENTRY], NOW);
    expect(preview.ready).toBe(true);
    const raceDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare(
          `UPDATE xero_projects_catalog SET active=0
           WHERE tenant_id=? AND kind='contact' AND resource_id=?`,
        )
          .bind(TENANT, CONTACT)
          .run();
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    await expect(
      approveReview(
        { ...bindings(), DB: raceDb },
        actor,
        {
          entryIds: [ENTRY],
          expectedPreviewHash: preview.previewHash,
          acknowledgedWarnings: preview.warnings.map((warning) => warning.code),
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM xero_projects_approvals').first(),
    ).toEqual({ count: 0 });
  });

  it('does not save a project selection when a close fences the entry mid-request', async () => {
    await seedReviewedEntry();
    const entryId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO time_entries
         (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,
          user_id,work_type,client_id,job_id,billable,client_name_snapshot,
          client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
          client_description,revision,locked_at,segment_root_id,segment_index,
          original_start_at,original_end_at)
         SELECT ?,project_id,notes,start_at,end_at,NULL,created_at,updated_at,
          user_id,work_type,client_id,job_id,billable,client_name_snapshot,
          client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
          client_description,revision,NULL,?,segment_index,original_start_at,original_end_at
         FROM time_entries WHERE id=?`,
      ).bind(entryId, entryId, ENTRY),
      env.DB.prepare(
        `INSERT INTO xero_projects_entry_selections
         (entry_id,tenant_id,project_id,task_id,project_name_snapshot,
          task_name_snapshot,task_charge_type_snapshot,task_rate_currency_snapshot,
          task_rate_value_snapshot,project_catalogue_revision,task_catalogue_revision,
          selection_revision,selected_by_user_id,selected_at)
         SELECT ?,tenant_id,project_id,task_id,project_name_snapshot,
          task_name_snapshot,task_charge_type_snapshot,task_rate_currency_snapshot,
          task_rate_value_snapshot,project_catalogue_revision,task_catalogue_revision,
          selection_revision,selected_by_user_id,selected_at
         FROM xero_projects_entry_selections WHERE entry_id=?`,
      ).bind(entryId, ENTRY),
    ]);

    const periodId = crypto.randomUUID();
    const cutoff = START + 1;
    let fenced = false;
    const raceDb = {
      prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (
          !fenced &&
          sql.includes('UPDATE xero_projects_entry_selections') &&
          sql.includes('selection_revision=selection_revision+1')
        ) {
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                run: async () => {
                  fenced = true;
                  await env.DB.prepare(
                    `INSERT INTO close_periods
                     (id,coverage_from,cutoff_at,kind,status,reason,suppress_delivery,
                      entry_count,total_ms,closed_at,created_at,updated_at)
                     VALUES(?,?,?,'scheduled','closing','',1,0,0,NULL,?,?)`,
                  )
                    .bind(periodId, START - 1, cutoff, NOW, NOW)
                    .run();
                  return bound.run();
                },
              } as unknown as D1PreparedStatement;
            },
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch: env.DB.batch.bind(env.DB),
    } as unknown as D1Database;

    await expect(
      saveEntrySelection(
        { ...bindings(), DB: raceDb },
        actor,
        {
          entryId,
          projectId: XERO_PROJECT,
          taskId: XERO_TASK,
          expectedSourceRevision: 1,
          expectedSelectionRevision: 1,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'ENTRY_LOCKED' });
    expect(fenced).toBe(true);
    expect(
      await env.DB.prepare(
        'SELECT selection_revision FROM xero_projects_entry_selections WHERE entry_id=?',
      )
        .bind(entryId)
        .first(),
    ).toEqual({ selection_revision: 1 });
    await env.DB.prepare('DELETE FROM close_periods WHERE id=?').bind(periodId).run();
  });

  it('does not save a project selection against a concurrently edited source entry', async () => {
    await seedReviewedEntry();
    const entryId = await cloneUnlockedReviewedEntry();
    let edited = false;
    const raceDb = {
      prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (
          !edited &&
          sql.includes('UPDATE xero_projects_entry_selections') &&
          sql.includes('selection_revision=selection_revision+1')
        ) {
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                run: async () => {
                  edited = true;
                  await env.DB.prepare('UPDATE time_entries SET revision=revision+1 WHERE id=?')
                    .bind(entryId)
                    .run();
                  return bound.run();
                },
              } as unknown as D1PreparedStatement;
            },
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch: env.DB.batch.bind(env.DB),
    } as unknown as D1Database;

    await expect(
      saveEntrySelection(
        { ...bindings(), DB: raceDb },
        actor,
        {
          entryId,
          projectId: XERO_PROJECT,
          taskId: XERO_TASK,
          expectedSourceRevision: 1,
          expectedSelectionRevision: 1,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(edited).toBe(true);
    expect(
      await env.DB.prepare(
        'SELECT task_id,selection_revision FROM xero_projects_entry_selections WHERE entry_id=?',
      )
        .bind(entryId)
        .first(),
    ).toEqual({ task_id: XERO_TASK, selection_revision: 1 });
  });

  it('rejects a selection from an earlier entry-edit revision before saving', async () => {
    await seedReviewedEntry();
    const entryId = await cloneUnlockedReviewedEntry();
    await env.DB.prepare('UPDATE time_entries SET revision=revision+1 WHERE id=?')
      .bind(entryId)
      .run();

    await expect(
      saveEntrySelection(
        bindings(),
        actor,
        {
          entryId,
          projectId: XERO_PROJECT,
          taskId: XERO_TASK,
          expectedSourceRevision: 1,
          expectedSelectionRevision: 1,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(
      await env.DB.prepare(
        'SELECT task_id,selection_revision FROM xero_projects_entry_selections WHERE entry_id=?',
      )
        .bind(entryId)
        .first(),
    ).toEqual({ task_id: XERO_TASK, selection_revision: 1 });
  });

  it('does not save a selection from a catalogue row archived mid-request', async () => {
    await seedReviewedEntry();
    const entryId = await cloneUnlockedReviewedEntry();
    let archived = false;
    const raceDb = {
      prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (
          !archived &&
          sql.includes('UPDATE xero_projects_entry_selections') &&
          sql.includes('selection_revision=selection_revision+1')
        ) {
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                run: async () => {
                  archived = true;
                  await env.DB.prepare(
                    `UPDATE xero_projects_catalog SET active=0,catalogue_revision=catalogue_revision+1
                     WHERE tenant_id=? AND kind='task' AND resource_id=?`,
                  )
                    .bind(TENANT, XERO_TASK)
                    .run();
                  return bound.run();
                },
              } as unknown as D1PreparedStatement;
            },
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch: env.DB.batch.bind(env.DB),
    } as unknown as D1Database;

    await expect(
      saveEntrySelection(
        { ...bindings(), DB: raceDb },
        actor,
        {
          entryId,
          projectId: XERO_PROJECT,
          taskId: XERO_TASK,
          expectedSourceRevision: 1,
          expectedSelectionRevision: 1,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'CATALOGUE_CHANGED' });
    expect(archived).toBe(true);
    expect(
      await env.DB.prepare(
        'SELECT task_id,selection_revision FROM xero_projects_entry_selections WHERE entry_id=?',
      )
        .bind(entryId)
        .first(),
    ).toEqual({ task_id: XERO_TASK, selection_revision: 1 });
  });

  it('invalidates a prior Xero selection only after a completed-entry edit succeeds', async () => {
    await seedReviewedEntry();
    const entryId = await cloneUnlockedReviewedEntry();
    const store = new D1TimeStore(env.DB, () => new Date(NOW));
    const input = {
      workType: 'client' as const,
      clientId: LOCAL_CLIENT,
      jobId: LOCAL_JOB,
      billable: true,
      notes: 'updated internal note',
      internalNote: 'updated internal note',
      clientDescription: 'Updated client-safe description',
      startAt: new Date(START),
      endAt: new Date(END),
    };

    expect(
      await store.updateEntry(LOCAL_USER, entryId, { ...input, expectedRevision: 999 }),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        'SELECT selection_revision FROM xero_projects_entry_selections WHERE entry_id=?',
      )
        .bind(entryId)
        .first(),
    ).toEqual({ selection_revision: 1 });

    expect(
      await store.updateEntry(LOCAL_USER, entryId, { ...input, expectedRevision: 1 }),
    ).toMatchObject({
      id: entryId,
      revision: 2,
      clientDescription: 'Updated client-safe description',
    });
    expect(
      await env.DB.prepare(
        'SELECT selection_revision FROM xero_projects_entry_selections WHERE entry_id=?',
      )
        .bind(entryId)
        .first(),
    ).toBeNull();
  });

  it('re-checks active fresh catalogue state at dispatch without making a remote request', async () => {
    await approveSeededEntry();
    await env.DB.prepare(
      `UPDATE xero_projects_catalog SET active=0
       WHERE tenant_id=? AND kind='contact' AND resource_id=?`,
    )
      .bind(TENANT, CONTACT)
      .run();
    let requestCount = 0;
    const result = await processNextUpload(
      bindings(),
      async () => {
        requestCount += 1;
        return Response.json({});
      },
      NOW,
    );
    expect(result?.state).toBe('needs_attention');
    expect(requestCount).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT last_error_code FROM xero_projects_upload_outbox WHERE entry_id=?',
      )
        .bind(ENTRY)
        .first(),
    ).toEqual({ last_error_code: 'REVIEW_CONTEXT_CHANGED' });
  });

  it('returns a proven pre-write context failure to a fresh audited review', async () => {
    const first = await approveSeededEntry();
    await env.DB.prepare(
      `UPDATE xero_projects_connection
          SET mapping_revision=mapping_revision+1,updated_at=? WHERE id=1`,
    )
      .bind(NOW + 1)
      .run();

    let requestCount = 0;
    expect(
      await processNextUpload(
        bindings(),
        async () => {
          requestCount += 1;
          return Response.json({});
        },
        NOW + 2,
      ),
    ).toMatchObject({ state: 'needs_attention' });
    expect(requestCount).toBe(0);
    const attention = await billingReviewData(
      bindings() as unknown as Parameters<typeof billingReviewData>[0],
      { state: 'needs_attention' },
    );
    expect(attention.items).toContainEqual(
      expect.objectContaining({
        entryId: ENTRY,
        billable: true,
        canReturnToReview: true,
        reviewState: 'approved',
      }),
    );

    await cancelApproval(
      bindings(),
      actor,
      first.approvalId,
      'Global mappings changed before any Xero write',
      NOW + 3,
    );
    expect(
      await env.DB.prepare(
        `SELECT a.state AS approval_state,o.state AS outbox_state,o.attempts,
                o.last_error_code,o.remote_time_entry_id
           FROM xero_projects_approvals a
           JOIN xero_projects_upload_outbox o ON o.approval_id=a.id
          WHERE a.id=?`,
      )
        .bind(first.approvalId)
        .first(),
    ).toEqual({
      approval_state: 'cancelled',
      outbox_state: 'cancelled',
      attempts: 1,
      last_error_code: 'REVIEW_REQUIRED_NO_WRITE',
      remote_time_entry_id: null,
    });
    const auditRow = await env.DB.prepare(
      `SELECT details_json FROM xero_projects_audit
        WHERE entity_id=? AND action='approval_cancelled'
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(first.approvalId)
      .first<{ details_json: string }>();
    expect(JSON.parse(auditRow!.details_json)).toMatchObject({
      transition: 'review_required',
      proof: 'no_xero_write_created',
      priorOutcomes: [
        {
          state: 'needs_attention',
          last_error_code: 'REVIEW_CONTEXT_CHANGED',
          attempts: 1,
        },
      ],
    });

    const reviewRequired = await billingReviewData(
      bindings() as unknown as Parameters<typeof billingReviewData>[0],
      { state: 'eligible' },
    );
    expect(reviewRequired.items).toContainEqual(
      expect.objectContaining({
        entryId: ENTRY,
        billable: true,
        canReturnToReview: false,
        reviewState: 'eligible',
      }),
    );

    const fresh = await previewReview(bindings(), actor, [ENTRY], NOW + 4);
    expect(fresh.ready).toBe(true);
    const second = await approveReview(
      bindings(),
      actor,
      {
        entryIds: [ENTRY],
        expectedPreviewHash: fresh.previewHash,
        acknowledgedWarnings: fresh.warnings.map((warning) => warning.code),
      },
      NOW + 5,
    );
    expect(second.approvalId).not.toBe(first.approvalId);
  });

  it('allows a definitive provider rejection to return to review', async () => {
    const approved = await approveSeededEntry();
    const result = await processNextUpload(
      bindings(),
      async (_input, init) =>
        (init?.method ?? 'GET') === 'POST'
          ? new Response('{"error":"invalid task"}', { status: 400 })
          : Response.json({ items: [], pagination: { page: 1, pageCount: 1 } }),
      NOW,
    );
    expect(result?.state).toBe('failed');
    expect(
      await env.DB.prepare(
        `SELECT state,last_error_code FROM xero_projects_upload_outbox WHERE approval_id=?`,
      )
        .bind(approved.approvalId)
        .first(),
    ).toEqual({ state: 'failed', last_error_code: 'XERO_HTTP_400' });

    await expect(
      cancelApproval(
        bindings(),
        actor,
        approved.approvalId,
        'Correct the rejected task mapping',
        NOW + 1,
      ),
    ).resolves.toBeUndefined();
    expect(
      await env.DB.prepare(
        `SELECT state,last_error_code FROM xero_projects_upload_outbox WHERE approval_id=?`,
      )
        .bind(approved.approvalId)
        .first(),
    ).toEqual({ state: 'cancelled', last_error_code: 'REVIEW_REQUIRED_NO_WRITE' });
  });

  it('treats a POST HTTP 408 as ambiguous and keeps it reconciliation-only', async () => {
    const approved = await approveSeededEntry();
    const result = await processNextUpload(
      bindings(),
      async (_input, init) =>
        (init?.method ?? 'GET') === 'POST'
          ? new Response(null, { status: 408 })
          : Response.json({ items: [], pagination: { page: 1, pageCount: 1 } }),
      NOW,
    );
    expect(result?.state).toBe('needs_attention');
    expect(
      await env.DB.prepare(
        `SELECT state,last_error_code FROM xero_projects_upload_outbox WHERE approval_id=?`,
      )
        .bind(approved.approvalId)
        .first(),
    ).toEqual({ state: 'needs_attention', last_error_code: 'AMBIGUOUS_WRITE' });
    await expect(
      cancelApproval(
        bindings(),
        actor,
        approved.approvalId,
        'Do not bypass reconciliation',
        NOW + 1,
      ),
    ).rejects.toMatchObject({ code: 'CANNOT_CANCEL' });
  });

  it('blocks dispatch when an approved catalogue snapshot becomes older than 24 hours', async () => {
    await approveSeededEntry();
    await env.DB.prepare(
      `UPDATE xero_projects_catalog SET fetched_at=?
       WHERE tenant_id=? AND kind='contact' AND resource_id=?`,
    )
      .bind(NOW - 24 * 60 * 60_000 - 1, TENANT, CONTACT)
      .run();
    let requestCount = 0;
    const result = await processNextUpload(
      bindings(),
      async () => {
        requestCount += 1;
        return Response.json({});
      },
      NOW,
    );
    expect(result?.state).toBe('needs_attention');
    expect(requestCount).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT last_error_code FROM xero_projects_upload_outbox WHERE entry_id=?',
      )
        .bind(ENTRY)
        .first(),
    ).toEqual({ last_error_code: 'REVIEW_CONTEXT_CHANGED' });
  });

  it('checks Xero for exact remote duplicates and never posts when a match exists', async () => {
    await approveSeededEntry();
    let postCount = 0;
    const duplicateResponse = () =>
      Response.json({
        items: [
          {
            timeEntryId: 'b0000000-0000-4000-8000-000000000002',
            projectId: XERO_PROJECT,
            userId: XERO_USER,
            taskId: XERO_TASK,
            dateUtc: '2026-10-21T00:00:00.000Z',
            duration: 2,
            description: 'Prepare annual financial statements',
            status: 'ACTIVE',
          },
        ],
        pagination: { page: 1, pageCount: 1 },
      });
    const result = await processNextUpload(
      bindings(),
      async (_input, init) => {
        if ((init?.method ?? 'GET') === 'POST') postCount += 1;
        return duplicateResponse();
      },
      NOW,
    );
    expect(result?.state).toBe('needs_attention');
    expect(postCount).toBe(0);
    const blocked = await env.DB.prepare(
      `SELECT id,last_error_code,remote_drift_json
       FROM xero_projects_upload_outbox WHERE entry_id=?`,
    )
      .bind(ENTRY)
      .first<{ id: string; last_error_code: string; remote_drift_json: string }>();
    expect(blocked).toMatchObject({ last_error_code: 'REMOTE_DUPLICATE_FOUND' });
    expect(
      (
        await billingReviewData(bindings() as unknown as Parameters<typeof billingReviewData>[0], {
          state: 'needs_attention',
        })
      ).items,
    ).toContainEqual(expect.objectContaining({ entryId: ENTRY, canReturnToReview: false }));
    await expect(
      cancelApproval(
        bindings(),
        actor,
        (await env.DB.prepare('SELECT approval_id FROM xero_projects_upload_outbox WHERE id=?')
          .bind(blocked!.id)
          .first<{ approval_id: string }>())!.approval_id,
        'This exact Xero match requires reconciliation',
        NOW + 1,
      ),
    ).rejects.toMatchObject({ code: 'CANNOT_CANCEL' });
    await expect(
      reconcileUpload(bindings(), actor, blocked!.id, { outcome: 'not_found' }, NOW, async () =>
        duplicateResponse(),
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_DUPLICATE_FOUND' });
  });

  it('does not post when the remote duplicate scan is incomplete', async () => {
    await approveSeededEntry();
    let postCount = 0;
    const result = await processNextUpload(
      bindings(),
      async (_input, init) => {
        if ((init?.method ?? 'GET') === 'POST') postCount += 1;
        return Response.json({
          items: [{ timeEntryId: 'b0000000-0000-4000-8000-000000000003' }],
          pagination: { page: 1, pageCount: 1 },
        });
      },
      NOW,
    );
    expect(result?.state).toBe('needs_attention');
    expect(postCount).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT last_error_code FROM xero_projects_upload_outbox WHERE entry_id=?',
      )
        .bind(ENTRY)
        .first(),
    ).toEqual({ last_error_code: 'DUPLICATE_CHECK_FAILED' });
  });

  it('safely requeues a duplicate scan when another request owns the token refresh', async () => {
    await approveSeededEntry();
    await env.DB.prepare(
      `UPDATE xero_projects_connection
          SET expires_at=0,refresh_lease_token='another-request',refresh_lease_until=?
        WHERE id=1`,
    )
      .bind(NOW + 60_000)
      .run();
    let requests = 0;
    const result = await processNextUpload(
      bindings(),
      async () => {
        requests += 1;
        return Response.json({});
      },
      NOW,
    );
    expect(result?.state).toBe('retry_wait');
    expect(requests).toBe(0);
    expect(
      await env.DB.prepare(
        `SELECT state,last_error_code FROM xero_projects_upload_outbox WHERE entry_id=?`,
      )
        .bind(ENTRY)
        .first(),
    ).toEqual({ state: 'retry_wait', last_error_code: 'REFRESH_BUSY' });
  });

  it('renews its lease immediately before posting after a long paginated duplicate scan', async () => {
    await approveSeededEntry();
    let clockNow = NOW;
    let getCount = 0;
    let quarantinedAtPost = -1;
    const unmatchedPage = Array.from({ length: 500 }, (_, index) => ({
      ...remoteTime(`b1000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`),
      description: `Different existing entry ${index}`,
    }));
    const result = await processNextUpload(
      bindings(),
      async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          getCount += 1;
          clockNow = NOW + 59_000;
          return getCount === 1
            ? Response.json({
                items: unmatchedPage,
                pagination: { page: 1, pageCount: 2 },
              })
            : Response.json({ items: [], pagination: { page: 2, pageCount: 2 } });
        }
        clockNow = NOW + 61_000;
        quarantinedAtPost = await quarantineExpiredUploadLeases(env.DB, clockNow);
        return Response.json(remoteTime('b0000000-0000-4000-8000-000000000020'));
      },
      NOW,
      () => clockNow,
    );
    expect(result?.state).toBe('provider_accepted');
    expect(getCount).toBe(2);
    expect(quarantinedAtPost).toBe(0);
    expect(
      await env.DB.prepare('SELECT state FROM xero_projects_upload_outbox WHERE entry_id=?')
        .bind(ENTRY)
        .first(),
    ).toEqual({ state: 'provider_accepted' });
  });

  it('refuses to post when the duplicate scan outlives and loses its lease', async () => {
    await approveSeededEntry();
    let clockNow = NOW;
    let postCount = 0;
    const result = await processNextUpload(
      bindings(),
      async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          clockNow = NOW + 61_000;
          return Response.json({ items: [], pagination: { page: 1, pageCount: 1 } });
        }
        postCount += 1;
        return Response.json(remoteTime('b0000000-0000-4000-8000-000000000021'));
      },
      NOW,
      () => clockNow,
    );
    expect(result?.state).toBe('retry_wait');
    expect(postCount).toBe(0);
    expect(
      await env.DB.prepare(
        `SELECT state,last_error_code FROM xero_projects_upload_outbox WHERE entry_id=?`,
      )
        .bind(ENTRY)
        .first(),
    ).toEqual({ state: 'retry_wait', last_error_code: 'LEASE_LOST_BEFORE_WRITE' });
  });

  it('quarantines and audits a lost local acceptance commit after Xero responds', async () => {
    await approveSeededEntry();
    let clockNow = NOW;
    let postCount = 0;
    const remoteId = 'b0000000-0000-4000-8000-000000000022';
    const result = await processNextUpload(
      bindings(),
      async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return Response.json({ items: [], pagination: { page: 1, pageCount: 1 } });
        }
        postCount += 1;
        // Simulate a delayed provider response which arrives only after the
        // freshly renewed lease has expired.
        clockNow = NOW + 61_000;
        return Response.json(remoteTime(remoteId));
      },
      NOW,
      () => clockNow,
    );
    expect(result?.state).toBe('needs_attention');
    expect(postCount).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT state,last_error_code,remote_drift_json
         FROM xero_projects_upload_outbox WHERE entry_id=?`,
      )
        .bind(ENTRY)
        .first(),
    ).toEqual({
      state: 'needs_attention',
      last_error_code: 'LOCAL_COMMIT_RACE',
      remote_drift_json: JSON.stringify({
        returnedTimeEntryId: remoteId,
        reason: 'provider_response_received_but_lease_commit_failed',
      }),
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM xero_projects_audit
         WHERE entity_id=(SELECT id FROM xero_projects_upload_outbox WHERE entry_id=?)
           AND action='upload_local_commit_race'`,
      )
        .bind(ENTRY)
        .first(),
    ).toEqual({ count: 1 });
  });

  it('allows distinct identical local entries after accounting for an already-linked remote ID', async () => {
    await seedReviewedEntry();
    await seedSecondReviewedEntry();
    const preview = await previewReview(bindings(), actor, [ENTRY, ENTRY_TWO], NOW);
    expect(preview.ready).toBe(true);
    await approveReview(
      bindings(),
      actor,
      {
        entryIds: [ENTRY, ENTRY_TWO],
        expectedPreviewHash: preview.previewHash,
        acknowledgedWarnings: preview.warnings.map((warning) => warning.code),
      },
      NOW,
    );
    const firstRemoteId = 'b0000000-0000-4000-8000-000000000010';
    const secondRemoteId = 'b0000000-0000-4000-8000-000000000011';
    let posts = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts += 1;
        return Response.json(remoteTime(posts === 1 ? firstRemoteId : secondRemoteId));
      }
      return Response.json({
        items: posts === 0 ? [] : [remoteTime(firstRemoteId.toUpperCase())],
        pagination: { page: 1, pageCount: 1 },
      });
    };
    expect((await processNextUpload(bindings(), fetcher, NOW))?.state).toBe('provider_accepted');
    await env.DB.prepare(
      `UPDATE xero_projects_upload_outbox
       SET remote_time_entry_id=upper(remote_time_entry_id)
       WHERE state='provider_accepted'`,
    ).run();
    expect((await processNextUpload(bindings(), fetcher, NOW + 1))?.state).toBe(
      'provider_accepted',
    );
    expect(posts).toBe(2);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(DISTINCT remote_time_entry_id) AS count
           FROM xero_projects_upload_outbox WHERE state='provider_accepted'`,
      ).first(),
    ).toEqual({ count: 2 });
  });

  it('rejects assigning one remote time-entry ID to two local outbox records', async () => {
    await seedReviewedEntry();
    await seedSecondReviewedEntry(ENTRY_THREE);
    const preview = await previewReview(bindings(), actor, [ENTRY, ENTRY_THREE], NOW);
    const approved = await approveReview(
      bindings(),
      actor,
      {
        entryIds: [ENTRY, ENTRY_THREE],
        expectedPreviewHash: preview.previewHash,
        acknowledgedWarnings: preview.warnings.map((warning) => warning.code),
      },
      NOW,
    );
    const rows = await env.DB.prepare(
      `SELECT id FROM xero_projects_upload_outbox WHERE approval_id=? ORDER BY id`,
    )
      .bind(approved.approvalId)
      .all<{ id: string }>();
    const remoteId = 'b0000000-0000-4000-8000-000000000012';
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE xero_projects_upload_outbox
            SET state='provider_accepted',remote_time_entry_id=? WHERE id=?`,
      ).bind(remoteId, rows.results[0].id),
      env.DB.prepare(
        `UPDATE xero_projects_upload_outbox SET state='needs_attention' WHERE id=?`,
      ).bind(rows.results[1].id),
    ]);
    await expect(
      reconcileUpload(
        bindings(),
        actor,
        rows.results[1].id,
        { outcome: 'found', remoteTimeEntryId: remoteId },
        NOW,
        async () => Response.json(remoteTime(remoteId)),
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_ID_CONFLICT' });
  });

  it('detects source drift when a prior lineage segment changes after upload', async () => {
    await seedReviewedEntry();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO time_entries
           (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,
            user_id,work_type,client_id,job_id,billable,client_name_snapshot,
            client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
            client_description,revision,locked_at,segment_root_id,segment_index,
            original_start_at,original_end_at)
         SELECT ?,project_id,notes,start_at,end_at,NULL,created_at,updated_at,
            user_id,work_type,client_id,job_id,billable,client_name_snapshot,
            client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
            client_description,1,locked_at,?,1,original_start_at,original_end_at
           FROM time_entries WHERE id=?`,
      ).bind(ENTRY_LINEAGE, ENTRY_LINEAGE, ENTRY),
      env.DB.prepare(
        `INSERT INTO xero_projects_entry_selections
           (entry_id,tenant_id,project_id,task_id,project_name_snapshot,
            task_name_snapshot,task_charge_type_snapshot,task_rate_currency_snapshot,
            task_rate_value_snapshot,project_catalogue_revision,task_catalogue_revision,
            selection_revision,selected_by_user_id,selected_at)
         SELECT ?,tenant_id,project_id,task_id,project_name_snapshot,
            task_name_snapshot,task_charge_type_snapshot,task_rate_currency_snapshot,
            task_rate_value_snapshot,project_catalogue_revision,task_catalogue_revision,
            selection_revision,selected_by_user_id,selected_at
           FROM xero_projects_entry_selections WHERE entry_id=?`,
      ).bind(ENTRY_LINEAGE, ENTRY),
      env.DB.prepare(
        `INSERT INTO time_entries
           (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,
            user_id,work_type,client_id,job_id,billable,client_name_snapshot,
            client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
            client_description,revision,locked_at,segment_root_id,segment_index,
            original_start_at,original_end_at)
         SELECT ?,project_id,notes,start_at-60000,start_at,NULL,created_at,updated_at,
            user_id,work_type,client_id,job_id,billable,client_name_snapshot,
            client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
            client_description,1,NULL,?,0,start_at-60000,start_at
           FROM time_entries WHERE id=?`,
      ).bind(ENTRY_PRIOR, ENTRY_LINEAGE, ENTRY),
    ]);
    const preview = await previewReview(bindings(), actor, [ENTRY_LINEAGE], NOW);
    await approveReview(
      bindings(),
      actor,
      {
        entryIds: [ENTRY_LINEAGE],
        expectedPreviewHash: preview.previewHash,
        acknowledgedWarnings: preview.warnings.map((warning) => warning.code),
      },
      NOW,
    );
    const remoteId = 'b0000000-0000-4000-8000-000000000013';
    const upload = await processNextUpload(
      bindings(),
      async (_input, init) =>
        (init?.method ?? 'GET') === 'POST'
          ? Response.json(remoteTime(remoteId))
          : Response.json({ items: [], pagination: { page: 1, pageCount: 1 } }),
      NOW,
    );
    expect(upload?.state).toBe('provider_accepted');
    await env.DB.prepare(`UPDATE time_entries SET start_at=start_at-60000 WHERE id=?`)
      .bind(ENTRY_PRIOR)
      .run();
    await refreshAcceptedStatuses(
      bindings(),
      25,
      async () => Response.json(remoteTime(remoteId)),
      NOW + 1,
    );
    expect(
      await env.DB.prepare(`SELECT source_drift FROM xero_projects_upload_outbox WHERE entry_id=?`)
        .bind(ENTRY_LINEAGE)
        .first(),
    ).toEqual({ source_drift: 1 });
  });

  it('snapshots review data, excludes internal notes and uploads only after approval', async () => {
    await seedReviewedEntry();
    const preview = await previewReview(bindings(), actor, [ENTRY], NOW);
    expect(preview.ready).toBe(true);
    expect(preview.items[0].exactDurationMs).toBe(90_500);
    expect(preview.items[0].roundedMinutes).toBe(2);
    expect(preview.items[0].payload.description).toBe('Prepare annual financial statements');
    expect(preview.items[0].payloadJson).not.toContain('INTERNAL');
    expect(preview.warnings.map((warning) => warning.code)).toContain('ROUNDING_APPLIED');

    await env.DB.prepare(
      'UPDATE xero_projects_connection SET mapping_revision=mapping_revision+1 WHERE id=1',
    ).run();
    await expect(
      approveReview(
        bindings(),
        actor,
        {
          entryIds: [ENTRY],
          expectedPreviewHash: preview.previewHash,
          acknowledgedWarnings: preview.warnings.map((warning) => warning.code),
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' });
    const currentPreview = await previewReview(bindings(), actor, [ENTRY], NOW);

    const approved = await approveReview(
      bindings(),
      actor,
      {
        entryIds: [ENTRY],
        expectedPreviewHash: currentPreview.previewHash,
        acknowledgedWarnings: currentPreview.warnings.map((warning) => warning.code),
      },
      NOW,
    );
    expect(approved.itemCount).toBe(1);
    const duplicatePreview = await previewReview(bindings(), actor, [ENTRY], NOW);
    expect(duplicatePreview.ready).toBe(false);
    expect(duplicatePreview.blockingIssues).toContainEqual(
      expect.objectContaining({ code: 'ALREADY_APPROVED' }),
    );
    const outbox = await env.DB.prepare(
      'SELECT payload_json,payload_hash,state,idempotency_key FROM xero_projects_upload_outbox',
    ).first<{
      payload_json: string;
      payload_hash: string;
      state: string;
      idempotency_key: string;
    }>();
    expect(outbox?.state).toBe('queued');
    expect(await sha256(outbox!.payload_json)).toBe(outbox?.payload_hash);
    expect(outbox?.payload_json).not.toContain('INTERNAL');

    await env.DB.prepare(
      `UPDATE xero_projects_approvals
         SET state='cancelled',cancelled_by_user_id=?,cancelled_by_email=?,
             cancelled_at=?,cancellation_reason='claim guard test' WHERE id=?`,
    )
      .bind(LOCAL_USER, actor.email, NOW, approved.approvalId)
      .run();
    expect(await claimUpload(bindings(), NOW)).toBeNull();
    await env.DB.prepare(
      `UPDATE xero_projects_approvals
         SET state='approved',cancelled_by_user_id=NULL,cancelled_by_email=NULL,
             cancelled_at=NULL,cancellation_reason=NULL WHERE id=?`,
    )
      .bind(approved.approvalId)
      .run();

    let sentBody = '';
    let sentKey = '';
    const result = await processNextUpload(
      bindings(),
      async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return Response.json({ items: [], pagination: { page: 1, pageCount: 1 } });
        }
        sentBody = String(init?.body ?? '');
        sentKey = new Headers(init?.headers).get('Idempotency-Key') ?? '';
        return Response.json({
          timeEntryId: 'b0000000-0000-4000-8000-000000000001',
          projectId: XERO_PROJECT,
          userId: XERO_USER,
          taskId: XERO_TASK,
          dateUtc: '2026-10-21T00:00:00.000Z',
          duration: 2,
          description: 'Prepare annual financial statements',
        });
      },
      NOW,
    );
    expect(result?.state).toBe('provider_accepted');
    expect(sentBody).toBe(outbox?.payload_json);
    expect(sentBody).not.toContain('INTERNAL');
    expect(sentKey).toBe(outbox?.idempotency_key);
    expect(
      await env.DB.prepare(
        'SELECT remote_status_raw,billing_label FROM xero_projects_upload_outbox',
      ).first(),
    ).toEqual({
      remote_status_raw: 'UNKNOWN',
      billing_label: 'Recorded in Xero — status, invoicing and payment unknown',
    });
  });

  it('requires acknowledgement when local billable conflicts with the Xero charge type', async () => {
    const billable = true;
    const chargeType = 'NON_CHARGEABLE' as const;
    await seedReviewedEntry({ billable, chargeType });

    const preview = await previewReview(bindings(), actor, [ENTRY], NOW);
    expect(preview.ready).toBe(true);
    expect(preview.items[0].billable).toBe(billable);
    expect(preview.items[0].sourceSnapshot).toMatchObject({ billable });
    expect(preview.warnings).toContainEqual(
      expect.objectContaining({ code: 'BILLABLE_CHARGE_MISMATCH', entryId: ENTRY }),
    );
    await expect(
      approveReview(
        bindings(),
        actor,
        {
          entryIds: [ENTRY],
          expectedPreviewHash: preview.previewHash,
          acknowledgedWarnings: preview.warnings
            .map((warning) => warning.code)
            .filter((code) => code !== 'BILLABLE_CHARGE_MISMATCH'),
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'WARNING_ACKNOWLEDGEMENT' });

    const approved = await approveReview(
      bindings(),
      actor,
      {
        entryIds: [ENTRY],
        expectedPreviewHash: preview.previewHash,
        acknowledgedWarnings: preview.warnings.map((warning) => warning.code),
      },
      NOW,
    );
    const stored = await env.DB.prepare(
      `SELECT source_snapshot_json FROM xero_projects_approval_items WHERE approval_id=?`,
    )
      .bind(approved.approvalId)
      .first<{ source_snapshot_json: string }>();
    expect(JSON.parse(stored!.source_snapshot_json)).toMatchObject({ billable });
  });

  it('safely reactivates the same immutable approval after a wholly-unsent cancellation', async () => {
    const first = await approveSeededEntry();
    await cancelApproval(
      bindings(),
      actor,
      first.approvalId,
      'Reviewer selected the wrong batch',
      NOW + 1,
    );
    expect(
      await env.DB.prepare('SELECT state FROM xero_projects_upload_outbox WHERE approval_id=?')
        .bind(first.approvalId)
        .first(),
    ).toEqual({ state: 'cancelled' });

    const preview = await previewReview(bindings(), actor, [ENTRY], NOW + 2);
    expect(preview.ready).toBe(true);
    const reviewerId = '10000000-0000-4000-8000-000000000002';
    await env.DB.prepare(
      `INSERT INTO users
         (id,access_subject,email,display_name,role,created_at,updated_at,last_seen_at)
       VALUES(?,'subject:suzie','suzieg@versatileaccounting.com.au','Suzie','employee',?,?,?)`,
    )
      .bind(reviewerId, NOW, NOW, NOW)
      .run();
    const reviewer: Actor = {
      id: reviewerId,
      email: 'suzieg@versatileaccounting.com.au',
      displayName: 'Suzie',
      role: 'employee',
    };
    const second = await approveReview(
      bindings(),
      reviewer,
      {
        entryIds: [ENTRY],
        expectedPreviewHash: preview.previewHash,
        acknowledgedWarnings: preview.warnings.map((warning) => warning.code),
      },
      NOW + 3,
    );

    expect(second.approvalId).toBe(first.approvalId);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM xero_projects_approvals').first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        `SELECT a.state AS approval_state,o.state AS outbox_state,o.attempts,
                a.cancelled_at,a.cancellation_reason,a.approved_by_user_id,
                a.approved_by_email,a.approved_at
         FROM xero_projects_approvals a
         JOIN xero_projects_upload_outbox o ON o.approval_id=a.id
         WHERE a.id=?`,
      )
        .bind(first.approvalId)
        .first(),
    ).toEqual({
      approval_state: 'approved',
      outbox_state: 'queued',
      attempts: 0,
      cancelled_at: null,
      cancellation_reason: null,
      approved_by_user_id: reviewerId,
      approved_by_email: 'suzieg@versatileaccounting.com.au',
      approved_at: NOW + 3,
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM xero_projects_audit
         WHERE entity_id=? AND action='approval_reapproved'`,
      )
        .bind(first.approvalId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it('creates a new approval generation after catalogue evidence changes', async () => {
    const first = await approveSeededEntry();
    await cancelApproval(bindings(), actor, first.approvalId, 'Refresh catalogue first', NOW + 1);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE xero_projects_catalog
         SET catalogue_revision=catalogue_revision+1,fetched_at=?`,
      ).bind(NOW + 2),
      env.DB.prepare(
        `UPDATE xero_projects_connection
         SET catalogue_revision=catalogue_revision+1,updated_at=? WHERE id=1`,
      ).bind(NOW + 2),
    ]);

    const preview = await previewReview(bindings(), actor, [ENTRY], NOW + 3);
    expect(preview.ready).toBe(true);
    const second = await approveReview(
      bindings(),
      actor,
      {
        entryIds: [ENTRY],
        expectedPreviewHash: preview.previewHash,
        acknowledgedWarnings: preview.warnings.map((warning) => warning.code),
      },
      NOW + 4,
    );

    expect(second.approvalId).not.toBe(first.approvalId);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM xero_projects_approvals').first(),
    ).toEqual({ count: 2 });
  });

  it('quarantines a remotely deleted accepted entry without retaining a stale billing status', async () => {
    await approveSeededEntry();
    const remoteId = 'b0000000-0000-4000-8000-000000000030';
    const uploaded = await processNextUpload(
      bindings(),
      async (_input, init) =>
        (init?.method ?? 'GET') === 'POST'
          ? Response.json(remoteTime(remoteId))
          : Response.json({ items: [], pagination: { page: 1, pageCount: 1 } }),
      NOW,
    );
    expect(uploaded?.state).toBe('provider_accepted');
    const acceptedAt = await env.DB.prepare(
      'SELECT last_status_checked_at FROM xero_projects_upload_outbox WHERE entry_id=?',
    )
      .bind(ENTRY)
      .first<{ last_status_checked_at: number }>();

    expect(
      await refreshAcceptedStatuses(
        bindings(),
        25,
        async () => new Response(null, { status: 404 }),
        NOW + 1_000,
      ),
    ).toEqual({ checked: 0, failed: 1 });

    expect(
      await env.DB.prepare(
        `SELECT state,remote_time_entry_id,remote_status_raw,billing_label,
                last_status_checked_at,remote_drift_json,last_error_code
           FROM xero_projects_upload_outbox WHERE entry_id=?`,
      )
        .bind(ENTRY)
        .first(),
    ).toEqual({
      state: 'needs_attention',
      remote_time_entry_id: remoteId,
      remote_status_raw: null,
      billing_label: 'Missing in Xero — reconciliation required',
      last_status_checked_at: acceptedAt?.last_status_checked_at,
      remote_drift_json: JSON.stringify({ missing: true }),
      last_error_code: 'XERO_HTTP_404',
    });
    expect(
      await env.DB.prepare(
        `SELECT action,details_json FROM xero_projects_audit
         WHERE action='remote_time_entry_missing' LIMIT 1`,
      ).first(),
    ).toEqual({
      action: 'remote_time_entry_missing',
      details_json: JSON.stringify({
        remoteTimeEntryId: remoteId,
        projectId: XERO_PROJECT,
        tenantId: TENANT,
        previousRawStatus: 'ACTIVE',
      }),
    });
  });

  it('keeps the last successful status timestamp and surfaces staleness after a failed read', async () => {
    await approveSeededEntry();
    const remoteId = 'b0000000-0000-4000-8000-000000000031';
    await processNextUpload(
      bindings(),
      async (_input, init) =>
        (init?.method ?? 'GET') === 'POST'
          ? Response.json(remoteTime(remoteId))
          : Response.json({ items: [], pagination: { page: 1, pageCount: 1 } }),
      NOW,
    );
    await refreshAcceptedStatuses(
      bindings(),
      25,
      async () => Response.json({ ...remoteTime(remoteId), status: 'LOCKED' }),
      NOW + 1_000,
    );
    expect(
      await refreshAcceptedStatuses(
        bindings(),
        25,
        async () => new Response(null, { status: 503 }),
        NOW + 2_000,
      ),
    ).toEqual({ checked: 0, failed: 1 });

    expect(
      await env.DB.prepare(
        `SELECT state,remote_status_raw,last_status_checked_at,last_error_code
           FROM xero_projects_upload_outbox WHERE entry_id=?`,
      )
        .bind(ENTRY)
        .first(),
    ).toEqual({
      state: 'provider_accepted',
      remote_status_raw: 'LOCKED',
      last_status_checked_at: NOW + 1_000,
      last_error_code: 'XERO_HTTP_503',
    });
    expect(await listBillingReview(bindings(), actor, {}, NOW + 7 * 60 * 60_000)).toContainEqual(
      expect.objectContaining({
        entryId: ENTRY,
        rawStatus: 'LOCKED',
        lastCheckedAt: NOW + 1_000,
        statusStale: true,
        lastErrorCode: 'XERO_HTTP_503',
      }),
    );
  });
});
