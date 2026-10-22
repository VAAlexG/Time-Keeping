import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../worker';
import type { AccessIdentity } from '../worker/access';
import type { Env } from '../worker/env';

const ALEX = 'alexg@versatileaccounting.com.au';
const SUZIE = 'suzieg@versatileaccounting.com.au';
const EMPLOYEE = 'employee.projects@versatileaccounting.com.au';
const CLIENT_ID = '10000000-0000-4000-8000-000000000101';
const JOB_ID = '20000000-0000-4000-8000-000000000101';
const PROJECT_ID = '30000000-0000-4000-8000-000000000101';
const XERO_PROJECT_ID = '40000000-0000-4000-8000-000000000101';
const XERO_TASK_ID = '50000000-0000-4000-8000-000000000101';
const XERO_TENANT_ID = '80000000-0000-4000-8000-000000000101';
const XERO_CONTACT_ID = '90000000-0000-4000-8000-000000000101';

const app = createApp(async (request): Promise<AccessIdentity> => {
  const email = request.headers.get('x-test-email');
  if (!email) throw new Error('missing test identity');
  return {
    subject: `subject:${email}`,
    entraObjectId: `oid:${email}`,
    email,
    displayName: email.split('@')[0],
  };
});

function bindings(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
    ACCESS_AUD: 'test-audience',
    ALLOWED_EMAIL_DOMAIN: 'versatileaccounting.com.au',
    ADMIN_EMAILS: ALEX,
    REPORT_VIEWER_EMAILS: `${ALEX},${SUZIE}`,
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'Timekeeper <reports@example.com>',
    WEEKLY_REPORT_RECIPIENT: 'weekly@example.com',
    REPORT_TEST_RECIPIENT: 'test@example.com',
    XERO_ENABLED: 'false',
    XERO_CLIENT_ID: 'test-xero-client',
    XERO_CLIENT_SECRET: 'test-xero-secret',
    XERO_REDIRECT_URI: 'https://timekeeper.example/api/projects/oauth/callback',
    XERO_TOKEN_KEY: btoa('01234567890123456789012345678901'),
    XERO_REVIEWER_EMAILS: SUZIE,
    ...overrides,
  };
}

async function call(
  path: string,
  init: RequestInit = {},
  overrides: Partial<Env> = {},
): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://timekeeper.example${path}`, init),
    bindings(overrides),
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function signIn(email: string, overrides: Partial<Env> = {}) {
  const response = await call('/api/session', { headers: { 'X-Test-Email': email } }, overrides);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    csrfToken: string;
    user: {
      id: string;
      email: string;
      role: string;
      canReviewBilling: boolean;
    };
  };
  return {
    email,
    user: body.user,
    csrf: body.csrfToken,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
  };
}

function headers(session: Awaited<ReturnType<typeof signIn>>, json = true) {
  return {
    'X-Test-Email': session.email,
    Cookie: session.cookie,
    'X-CSRF-Token': session.csrf,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
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
    env.DB.prepare('DELETE FROM xero_projects_catalog_staging'),
    env.DB.prepare('DELETE FROM xero_projects_catalog_runs'),
    env.DB.prepare('DELETE FROM xero_projects_catalog'),
    env.DB.prepare('DELETE FROM xero_projects_audit'),
    env.DB.prepare('DELETE FROM xero_projects_oauth_states'),
    env.DB.prepare('DELETE FROM time_entries WHERE locked_at IS NULL'),
    env.DB.prepare('DELETE FROM jobs'),
    env.DB.prepare('DELETE FROM clients'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM projects'),
  ]);
  await env.DB.prepare(
    `UPDATE xero_projects_connection
       SET tenant_id=NULL,tenant_name=NULL,connection_id=NULL,
           encrypted_tokens=NULL,expires_at=0,pending_connections_json=NULL,
           pending_actor_id=NULL,connected=0,paused=1,cutover_at=NULL,
           refresh_lease_token=NULL,refresh_lease_until=0,
           catalogue_lease_token=NULL,catalogue_lease_until=0,
           throttle_until=0,connection_revision=1,catalogue_revision=0,
           mapping_revision=0,updated_at=0 WHERE id=1`,
  ).run();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO clients
         (id,external_id,source,name,active,created_at,updated_at,synced_at)
       VALUES(?,'fyi-route-client','fyi','Route Test Client',1,?,?,?)`,
    ).bind(CLIENT_ID, now, now, now),
    env.DB.prepare(
      `INSERT INTO jobs
         (id,external_id,client_id,source,name,active,default_billable,
          created_at,updated_at,synced_at)
       VALUES(?,'fyi-route-job',?,'fyi','Route Test Job',1,1,?,?,?)`,
    ).bind(JOB_ID, CLIENT_ID, now, now, now),
    env.DB.prepare(
      `INSERT INTO projects(id,name,name_key,created_at)
       VALUES(?,'Route Test Legacy Project','route test legacy project',?)`,
    ).bind(PROJECT_ID, now),
  ]);
});

describe('Xero Projects Worker route permissions', () => {
  it('denies setup, connection, mapping and processing routes to an employee', async () => {
    const employee = await signIn(EMPLOYEE);
    const requests: Array<[string, RequestInit]> = [
      ['/api/projects/setup', { headers: headers(employee, false) }],
      ['/api/projects/oauth/start', { method: 'POST', headers: headers(employee), body: '{}' }],
      [
        `/api/projects/mappings/client/${CLIENT_ID}`,
        {
          method: 'PUT',
          headers: headers(employee),
          body: JSON.stringify({ xeroContactId: XERO_PROJECT_ID }),
        },
      ],
      ['/api/projects/outbox/process', { method: 'POST', headers: headers(employee), body: '{}' }],
    ];

    for (const [path, init] of requests) {
      const response = await call(path, init);
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toMatchObject({
        error: 'Administrator access is required.',
      });
    }
  });

  it('allows Suzie to review billing but not administer setup or process the outbox', async () => {
    const suzie = await signIn(SUZIE);
    expect(suzie.user).toMatchObject({ role: 'employee', canReviewBilling: true });

    const review = await call('/api/projects/review', {
      headers: headers(suzie, false),
    });
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({
      items: [],
      uploadsEnabled: false,
      processingPaused: true,
    });

    const setup = await call('/api/projects/setup', {
      headers: headers(suzie, false),
    });
    expect(setup.status).toBe(403);

    const process = await call('/api/projects/outbox/process', {
      method: 'POST',
      headers: headers(suzie),
      body: '{}',
    });
    expect(process.status).toBe(403);
    expect(await process.json()).toMatchObject({
      error: 'Administrator access is required.',
    });

    const malformedReconciliation = await call('/api/projects/outbox/not-a-uuid/reconcile', {
      method: 'POST',
      headers: headers(suzie),
      body: JSON.stringify({ outcome: 'not_found' }),
    });
    expect(malformedReconciliation.status).toBe(400);
    expect(await malformedReconciliation.json()).toMatchObject({
      error: 'Choose a valid upload and confirmed reconciliation outcome.',
    });
  });
});

describe('Xero Projects Worker route request safety', () => {
  it('rejects project mutations without the session CSRF token', async () => {
    await signIn(ALEX);
    const response = await call('/api/projects/setup', {
      method: 'PUT',
      headers: {
        'X-Test-Email': ALEX,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: false, cutoverDate: '2026-10-01' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Your request security token is invalid. Refresh and try again.',
    });
  });

  it('rejects malformed OAuth and mapping inputs before any provider request', async () => {
    const enabledBindings: Partial<Env> = { XERO_ENABLED: 'true' };
    const admin = await signIn(ALEX, enabledBindings);

    const callback = await call(
      '/api/projects/oauth/callback?code=not-used-without-state',
      { headers: headers(admin, false) },
      enabledBindings,
    );
    expect(callback.status).toBe(400);
    expect(await callback.json()).toMatchObject({ code: 'OAUTH_STATE' });

    const organisation = await call(
      '/api/projects/organisation',
      {
        method: 'POST',
        headers: headers(admin),
        body: JSON.stringify({ tenantId: 'not-a-uuid', confirmation: true }),
      },
      enabledBindings,
    );
    expect(organisation.status).toBe(400);
    expect(await organisation.json()).toMatchObject({
      error: 'Choose and confirm the intended Xero organisation.',
    });

    const mapping = await call(
      `/api/projects/mappings/work/${JOB_ID}`,
      {
        method: 'PUT',
        headers: headers(admin),
        body: JSON.stringify({
          xeroProjectId: XERO_PROJECT_ID,
          xeroTaskId: 'not-a-uuid',
        }),
      },
      enabledBindings,
    );
    expect(mapping.status).toBe(400);
    expect(await mapping.json()).toMatchObject({
      error: 'Choose a valid local job, Xero project, and task.',
    });
  });

  it('keeps ordinary time capture available when the Xero feature flag is off', async () => {
    const employee = await signIn(EMPLOYEE);
    const options = await call(`/api/projects/catalog?clientId=${CLIENT_ID}&jobId=${JOB_ID}`, {
      headers: headers(employee, false),
    });
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({
      enabled: false,
      connected: false,
      projects: [],
      tasks: [],
      message: 'Xero Projects is disabled. Time will still be saved in Timekeeper.',
    });

    const started = await call('/api/clock-in', {
      method: 'POST',
      headers: headers(employee),
      body: JSON.stringify({
        workType: 'client',
        clientId: CLIENT_ID,
        jobId: JOB_ID,
        billable: true,
        clientDescription: 'Prepare quarterly accounts',
        internalNote: 'Practice-only working note',
        xeroProjectId: XERO_PROJECT_ID,
        xeroTaskId: XERO_TASK_ID,
      }),
    });
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({
      entry: {
        workType: 'client',
        clientDescription: 'Prepare quarterly accounts',
        notes: 'Practice-only working note',
      },
      xeroWarning: 'Xero Projects is not enabled for this deployment.',
    });
  });

  it('preserves an unchanged selection and clears it before an ordinary entry is reclassified', async () => {
    const employee = await signIn(EMPLOYEE, { XERO_ENABLED: 'true' });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE xero_projects_connection
         SET tenant_id=?,tenant_name='Route Test Organisation',connected=1,paused=1,
             catalogue_revision=1,mapping_revision=1,updated_at=? WHERE id=1`,
      ).bind(XERO_TENANT_ID, now),
      env.DB.prepare(
        `INSERT INTO xero_projects_catalog
         (tenant_id,kind,resource_id,parent_id,data_json,active,fetched_at,catalogue_revision)
         VALUES
         (?, 'contact', ?, '', ?, 1, ?, 1),
         (?, 'project', ?, ?, ?, 1, ?, 1),
         (?, 'task', ?, ?, ?, 1, ?, 1)`,
      ).bind(
        XERO_TENANT_ID,
        XERO_CONTACT_ID,
        JSON.stringify({ contactId: XERO_CONTACT_ID, name: 'Route Test Client', status: 'ACTIVE' }),
        now,
        XERO_TENANT_ID,
        XERO_PROJECT_ID,
        XERO_CONTACT_ID,
        JSON.stringify({
          projectId: XERO_PROJECT_ID,
          contactId: XERO_CONTACT_ID,
          name: 'Annual accounts',
          status: 'INPROGRESS',
        }),
        now,
        XERO_TENANT_ID,
        XERO_TASK_ID,
        XERO_PROJECT_ID,
        JSON.stringify({
          taskId: XERO_TASK_ID,
          projectId: XERO_PROJECT_ID,
          name: 'Accounting',
          chargeType: 'TIME',
          rate: { currency: 'AUD', value: 220 },
        }),
        now,
      ),
      env.DB.prepare(
        `INSERT INTO xero_projects_client_links
         (tenant_id,client_id,contact_id,contact_name_snapshot,revision,mapped_by_user_id,mapped_at)
         VALUES(?,?,?,?,1,?,?)`,
      ).bind(
        XERO_TENANT_ID,
        CLIENT_ID,
        XERO_CONTACT_ID,
        'Route Test Client',
        employee.user.id,
        now,
      ),
    ]);
    const basePayload = {
      workType: 'client' as const,
      clientId: CLIENT_ID,
      jobId: JOB_ID,
      billable: true,
      clientDescription: 'Prepare annual accounts',
      internalNote: 'Private working note',
      workDate: '2026-10-20',
      startTime: '09:00',
      durationMinutes: 60,
      xeroProjectId: XERO_PROJECT_ID,
      xeroTaskId: XERO_TASK_ID,
    };
    const createdResponse = await call(
      '/api/entries',
      {
        method: 'POST',
        headers: headers(employee),
        body: JSON.stringify(basePayload),
      },
      { XERO_ENABLED: 'true' },
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      entry: { id: string; revision: number };
      xeroWarning: string | null;
    };
    expect(created.xeroWarning).toBeNull();

    const unchangedResponse = await call(
      `/api/entries/${created.entry.id}`,
      {
        method: 'PUT',
        headers: headers(employee),
        body: JSON.stringify({
          ...basePayload,
          expectedRevision: created.entry.revision,
          durationMinutes: 75,
        }),
      },
      { XERO_ENABLED: 'true' },
    );
    expect(unchangedResponse.status).toBe(200);
    const unchanged = (await unchangedResponse.json()) as {
      entry: { revision: number };
      xeroWarning: string | null;
    };
    expect(unchanged.xeroWarning).toBeNull();
    expect(
      await env.DB.prepare(
        'SELECT project_id,task_id,selection_revision FROM xero_projects_entry_selections WHERE entry_id=?',
      )
        .bind(created.entry.id)
        .first(),
    ).toEqual({
      project_id: XERO_PROJECT_ID,
      task_id: XERO_TASK_ID,
      selection_revision: 1,
    });

    const clearedResponse = await call(
      `/api/entries/${created.entry.id}`,
      {
        method: 'PUT',
        headers: headers(employee),
        body: JSON.stringify({
          ...basePayload,
          expectedRevision: unchanged.entry.revision,
          durationMinutes: 90,
          xeroProjectId: undefined,
          xeroTaskId: undefined,
        }),
      },
      { XERO_ENABLED: 'true' },
    );
    expect(clearedResponse.status).toBe(200);
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM xero_projects_entry_selections WHERE entry_id=?',
      )
        .bind(created.entry.id)
        .first(),
    ).toEqual({ count: 0 });
  });

  it('pages and filters billing review without exposing practice-only notes', async () => {
    {
      const now = Date.now();
      const staffId = '60000000-0000-4000-8000-000000000102';
      await env.DB.prepare(
        `INSERT INTO users
         (id,access_subject,email,display_name,role,created_at,updated_at,last_seen_at)
       VALUES(?,'subject:paged-staff','paged.staff@versatileaccounting.com.au',
              'Paged Staff','employee',?,?,?)`,
      )
        .bind(staffId, now, now, now)
        .run();
      await env.DB.batch(
        Array.from({ length: 12 }, (_, index) => {
          const suffix = String(index + 1).padStart(12, '0');
          const entryId = `71000000-0000-4000-8000-${suffix}`;
          const start = now - (index + 2) * 3_600_000;
          return env.DB.prepare(
            `INSERT INTO time_entries
             (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,
              user_id,work_type,client_id,job_id,billable,client_name_snapshot,
              client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
              client_description,revision,locked_at,segment_root_id,segment_index,
              original_start_at,original_end_at)
           VALUES(?,?,'',?,?,NULL,?,?,?,'client',?,?,1,
                  'Paged Client','fyi-route-client','Paged Job','fyi-route-job',
                  ?,1,?,?,0,?,?)`,
          ).bind(
            entryId,
            PROJECT_ID,
            start,
            start + 30 * 60_000,
            now,
            now,
            staffId,
            CLIENT_ID,
            JOB_ID,
            `Paged description ${index + 1}`,
            now,
            entryId,
            start,
            start + 30 * 60_000,
          );
        }),
      );

      const suzie = await signIn(SUZIE);
      const first = await call(
        '/api/projects/review?search=paged%20client&state=blocked&page=1&pageSize=10',
        { headers: headers(suzie, false) },
      );
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        page: 1,
        pageSize: 10,
        total: 12,
        hasMore: true,
        counts: expect.objectContaining({ blocked: 12 }),
        items: expect.arrayContaining([
          expect.objectContaining({ clientName: 'Paged Client', reviewState: 'blocked' }),
        ]),
      });
      const second = await call(
        '/api/projects/review?search=paged%20client&state=blocked&page=2&pageSize=10',
        { headers: headers(suzie, false) },
      );
      const secondBody = (await second.json()) as {
        items: unknown[];
        page: number;
        total: number;
        hasMore: boolean;
      };
      expect(second.status).toBe(200);
      expect(secondBody).toMatchObject({ page: 2, total: 12, hasMore: false });
      expect(secondBody.items).toHaveLength(2);
    }
    {
      const now = Date.now();
      const staffId = '60000000-0000-4000-8000-000000000101';
      const entryId = '70000000-0000-4000-8000-000000000101';
      const privateNote = 'PRIVATE-ROUTE-SENTINEL must never reach Xero review';
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users
           (id,access_subject,email,display_name,role,created_at,updated_at,last_seen_at)
         VALUES(?,'subject:route-staff','route.staff@versatileaccounting.com.au',
                'Route Staff','employee',?,?,?)`,
        ).bind(staffId, now, now, now),
        env.DB.prepare(
          `INSERT INTO time_entries
           (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,
            user_id,work_type,client_id,job_id,billable,client_name_snapshot,
            client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
            client_description,revision,locked_at,segment_root_id,segment_index,
            original_start_at,original_end_at)
         VALUES(?,?,?, ?,?,NULL,?,?,?,'client',?,?,1,
                'Route Test Client','fyi-route-client','Route Test Job','fyi-route-job',
                'Client-facing description',1,?,?,0,?,?)`,
        ).bind(
          entryId,
          PROJECT_ID,
          privateNote,
          now - 3_600_000,
          now - 1_800_000,
          now,
          now,
          staffId,
          CLIENT_ID,
          JOB_ID,
          now,
          entryId,
          now - 3_600_000,
          now - 1_800_000,
        ),
      ]);

      const suzie = await signIn(SUZIE);
      const response = await call('/api/projects/review', {
        headers: headers(suzie, false),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: Array<{ entryId: string; clientDescription: string }>;
      };
      expect(body.items).toContainEqual(
        expect.objectContaining({
          entryId,
          clientDescription: 'Client-facing description',
        }),
      );
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(privateNote);
      expect(serialized).not.toContain('internalNote');
      expect(serialized).not.toContain('"notes"');
    }
    {
      const suzie = await signIn(SUZIE, { XERO_ENABLED: 'true' });
      const now = Date.now();
      const entryId = '70000000-0000-4000-8000-000000000201';
      const xeroUserId = 'a0000000-0000-4000-8000-000000000201';
      const start = now - 60 * 60_000;
      const contact = {
        ContactID: XERO_CONTACT_ID,
        Name: 'Route Test Client',
        ContactStatus: 'ACTIVE',
      };
      const project = {
        projectId: XERO_PROJECT_ID,
        contactId: XERO_CONTACT_ID,
        name: 'Annual accounts',
        status: 'INPROGRESS',
      };
      const task = {
        taskId: XERO_TASK_ID,
        projectId: XERO_PROJECT_ID,
        name: 'Accounting',
        chargeType: 'TIME',
        rate: { currency: 'AUD', value: 220 },
      };
      const xeroUser = {
        userId: xeroUserId,
        name: 'Suzie',
        email: SUZIE,
      };
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE xero_projects_connection
         SET tenant_id=?,tenant_name='Route Test Organisation',connected=1,paused=1,
             cutover_at=?,catalogue_revision=1,mapping_revision=1,updated_at=? WHERE id=1`,
        ).bind(XERO_TENANT_ID, start - 1, now),
        env.DB.prepare(
          `INSERT INTO time_entries
         (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,
          user_id,work_type,client_id,job_id,billable,client_name_snapshot,
          client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
          client_description,revision,locked_at,segment_root_id,segment_index,
          original_start_at,original_end_at)
       VALUES(?,?,'',?,?,NULL,?,?,?,'client',?,?,1,
              'Eligibility Client','fyi-route-client','Route Test Job','fyi-route-job',
              'Prepare annual accounts',1,?,?,0,?,?)`,
        ).bind(
          entryId,
          PROJECT_ID,
          start,
          start + 60 * 60_000,
          now,
          now,
          suzie.user.id,
          CLIENT_ID,
          JOB_ID,
          now,
          entryId,
          start,
          start + 60 * 60_000,
        ),
        env.DB.prepare(
          `INSERT INTO xero_projects_client_links
         (tenant_id,client_id,contact_id,contact_name_snapshot,revision,mapped_by_user_id,mapped_at)
         VALUES(?,?,?,'Route Test Client',1,?,?)`,
        ).bind(XERO_TENANT_ID, CLIENT_ID, XERO_CONTACT_ID, suzie.user.id, now),
        env.DB.prepare(
          `INSERT INTO xero_projects_user_links
         (tenant_id,user_id,xero_user_id,xero_email_snapshot,revision,mapped_by_user_id,mapped_at)
         VALUES(?,?,?,?,1,?,?)`,
        ).bind(XERO_TENANT_ID, suzie.user.id, xeroUserId, SUZIE, suzie.user.id, now),
        ...[
          ['contact', XERO_CONTACT_ID, '', contact],
          ['project', XERO_PROJECT_ID, XERO_CONTACT_ID, project],
          ['task', XERO_TASK_ID, XERO_PROJECT_ID, task],
          ['user', xeroUserId, '', xeroUser],
        ].map(([kind, id, parent, data]) =>
          env.DB.prepare(
            `INSERT INTO xero_projects_catalog
           (tenant_id,kind,resource_id,parent_id,data_json,active,fetched_at,catalogue_revision)
           VALUES(?,?,?,?,?,1,?,1)`,
          ).bind(XERO_TENANT_ID, kind, id, parent, JSON.stringify(data), now),
        ),
        env.DB.prepare(
          `INSERT INTO xero_projects_entry_selections
         (entry_id,tenant_id,project_id,task_id,project_name_snapshot,task_name_snapshot,
          task_charge_type_snapshot,task_rate_currency_snapshot,task_rate_value_snapshot,
          project_catalogue_revision,task_catalogue_revision,selection_revision,
          selected_by_user_id,selected_at)
         VALUES(?,?,?,?,?,?,?,?,?,1,1,1,?,?)`,
        ).bind(
          entryId,
          XERO_TENANT_ID,
          XERO_PROJECT_ID,
          XERO_TASK_ID,
          project.name,
          task.name,
          task.chargeType,
          task.rate.currency,
          task.rate.value,
          suzie.user.id,
          now,
        ),
      ]);

      const eligible = await call(
        '/api/projects/review?state=eligible&search=eligibility%20client',
        { headers: headers(suzie, false) },
        { XERO_ENABLED: 'true' },
      );
      expect(eligible.status).toBe(200);
      expect(await eligible.json()).toMatchObject({
        total: 1,
        counts: expect.objectContaining({ eligible: 1, blocked: 0 }),
        items: [
          expect.objectContaining({ entryId, reviewState: 'eligible', uploadDurationMinutes: 60 }),
        ],
      });
      const exact = await call(
        `/api/projects/review/${entryId}/preview`,
        { headers: headers(suzie, false) },
        { XERO_ENABLED: 'true' },
      );
      expect(exact.status).toBe(200);
      expect(await exact.json()).toMatchObject({ entryId, reviewState: 'eligible', blockers: [] });

      await env.DB.prepare(
        `UPDATE xero_projects_catalog SET fetched_at=?
       WHERE tenant_id=? AND kind='user' AND resource_id=?`,
      )
        .bind(now - 24 * 60 * 60_000 - 1, XERO_TENANT_ID, xeroUserId)
        .run();
      const staleBlocked = await call(
        '/api/projects/review?state=blocked&search=eligibility%20client',
        { headers: headers(suzie, false) },
        { XERO_ENABLED: 'true' },
      );
      expect(staleBlocked.status).toBe(200);
      expect(await staleBlocked.json()).toMatchObject({
        total: 1,
        counts: expect.objectContaining({ eligible: 0, blocked: 1 }),
        items: [
          expect.objectContaining({
            entryId,
            reviewState: 'blocked',
            blockers: expect.arrayContaining([expect.stringContaining('over 24 hours old')]),
          }),
        ],
      });
      const staleExact = await call(
        `/api/projects/review/${entryId}/preview`,
        { headers: headers(suzie, false) },
        { XERO_ENABLED: 'true' },
      );
      expect(staleExact.status).toBe(200);
      expect(await staleExact.json()).toMatchObject({
        entryId,
        reviewState: 'blocked',
        blockers: expect.arrayContaining([expect.stringContaining('over 24 hours old')]),
      });

      await env.DB.prepare(
        `UPDATE xero_projects_catalog SET fetched_at=?,data_json=?
       WHERE tenant_id=? AND kind='task' AND resource_id=?`,
      )
        .bind(
          now,
          JSON.stringify({ ...task, projectId: '50000000-0000-4000-8000-000000000999' }),
          XERO_TENANT_ID,
          XERO_TASK_ID,
        )
        .run();
      await env.DB.prepare(
        `UPDATE xero_projects_catalog SET fetched_at=?
       WHERE tenant_id=? AND kind='user' AND resource_id=?`,
      )
        .bind(now, XERO_TENANT_ID, xeroUserId)
        .run();
      const relationshipBlocked = await call(
        '/api/projects/review?state=blocked&search=eligibility%20client',
        { headers: headers(suzie, false) },
        { XERO_ENABLED: 'true' },
      );
      expect(relationshipBlocked.status).toBe(200);
      expect(await relationshipBlocked.json()).toMatchObject({
        total: 1,
        counts: expect.objectContaining({ eligible: 0, blocked: 1 }),
        items: [expect.objectContaining({ entryId, reviewState: 'blocked' })],
      });
      const relationshipExact = await call(
        `/api/projects/review/${entryId}/preview`,
        { headers: headers(suzie, false) },
        { XERO_ENABLED: 'true' },
      );
      expect(relationshipExact.status).toBe(200);
      expect(await relationshipExact.json()).toMatchObject({
        entryId,
        reviewState: 'blocked',
        blockers: expect.arrayContaining([
          expect.stringContaining('no longer active or consistent'),
        ]),
      });

      const zeroEntryId = '70000000-0000-4000-8000-000000000202';
      const zeroStart = now - 30 * 60_000;
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE xero_projects_catalog SET data_json=?
           WHERE tenant_id=? AND kind='task' AND resource_id=?`,
        ).bind(JSON.stringify(task), XERO_TENANT_ID, XERO_TASK_ID),
        env.DB.prepare(
          `INSERT INTO time_entries
           (id,project_id,notes,start_at,end_at,active_guard,created_at,updated_at,
            user_id,work_type,client_id,job_id,billable,client_name_snapshot,
            client_external_id_snapshot,job_name_snapshot,job_external_id_snapshot,
            client_description,revision,locked_at,segment_root_id,segment_index,
            original_start_at,original_end_at)
           VALUES(?,?,'',?,?,NULL,?,?,?,'client',?,?,1,
                  'Zero Allocation Client','fyi-route-client','Route Test Job','fyi-route-job',
                  'Short client segment',1,?,?,0,?,?)`,
        ).bind(
          zeroEntryId,
          PROJECT_ID,
          zeroStart,
          zeroStart + 20_000,
          now,
          now,
          suzie.user.id,
          CLIENT_ID,
          JOB_ID,
          now,
          zeroEntryId,
          zeroStart,
          zeroStart + 20_000,
        ),
        env.DB.prepare(
          `INSERT INTO xero_projects_entry_selections
           (entry_id,tenant_id,project_id,task_id,project_name_snapshot,task_name_snapshot,
            task_charge_type_snapshot,task_rate_currency_snapshot,task_rate_value_snapshot,
            project_catalogue_revision,task_catalogue_revision,selection_revision,
            selected_by_user_id,selected_at)
           VALUES(?,?,?,?,?,?,?,?,?,1,1,1,?,?)`,
        ).bind(
          zeroEntryId,
          XERO_TENANT_ID,
          XERO_PROJECT_ID,
          XERO_TASK_ID,
          project.name,
          task.name,
          task.chargeType,
          task.rate.currency,
          task.rate.value,
          suzie.user.id,
          now,
        ),
      ]);
      const zeroBlocked = await call(
        '/api/projects/review?state=blocked&search=zero%20allocation',
        { headers: headers(suzie, false) },
        { XERO_ENABLED: 'true' },
      );
      expect(zeroBlocked.status).toBe(200);
      expect(await zeroBlocked.json()).toMatchObject({
        total: 1,
        counts: expect.objectContaining({ eligible: 0, blocked: 1 }),
        items: [
          expect.objectContaining({
            entryId: zeroEntryId,
            reviewState: 'blocked',
            uploadDurationMinutes: 0,
            blockers: expect.arrayContaining([
              expect.stringContaining('positive whole-minute Xero allocation'),
            ]),
          }),
        ],
      });
      const zeroExact = await call(
        `/api/projects/review/${zeroEntryId}/preview`,
        { headers: headers(suzie, false) },
        { XERO_ENABLED: 'true' },
      );
      expect(zeroExact.status).toBe(200);
      expect(await zeroExact.json()).toMatchObject({
        entryId: zeroEntryId,
        reviewState: 'blocked',
        blockers: expect.arrayContaining([
          expect.stringContaining('zero whole minutes after lineage-aware rounding'),
        ]),
      });
    }
  });
});
