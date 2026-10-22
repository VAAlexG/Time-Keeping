import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { D1TimeStore } from '../server/d1-store';
import {
  completeXeroAuthorization,
  completeXeroAccountingVerification,
  createXeroAccountingVerificationAuthorization,
  createXeroAuthorization,
  applyXeroMigration,
  loadXeroCatalog,
  syncFromXero,
  xeroConnectionStatus,
  xeroAccountingVerificationStatus,
} from '../server/xero';

const secrets = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  encryptionKey: btoa('01234567890123456789012345678901'),
};
const userId = '90000000-0000-4000-8000-000000000001';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM xero_accounting_verifications'),
    env.DB.prepare('DELETE FROM xero_oauth_states'),
    env.DB.prepare('DELETE FROM xero_connections'),
    env.DB.prepare('DELETE FROM jobs'),
    env.DB.prepare('DELETE FROM clients'),
    env.DB.prepare('DELETE FROM sync_runs'),
    env.DB.prepare('DELETE FROM users'),
  ]);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, access_subject, email, display_name, role, created_at, updated_at, last_seen_at)
     VALUES (?, 'xero-test-user', 'admin@example.com', 'Admin', 'admin', ?, ?, ?)`,
  )
    .bind(userId, now, now, now)
    .run();
  vi.restoreAllMocks();
});

async function connect() {
  const authorization = await createXeroAuthorization(
    env.DB,
    userId,
    'https://timekeeper.example/api/admin/xero/callback',
    secrets.clientId,
  );
  const state = new URL(authorization).searchParams.get('state')!;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { tenantId: 'tenant-1', tenantName: 'Practice', tenantType: 'PRACTICEMANAGER' },
          ]),
          { status: 200 },
        ),
      ),
  );
  await completeXeroAuthorization(env.DB, state, 'code', secrets, userId);
}

describe('Xero Practice Manager integration', () => {
  it('completes a separate read-only Accounting API verification', async () => {
    const authorization = await createXeroAccountingVerificationAuthorization(
      env.DB,
      userId,
      'https://timekeeper.example/api/admin/xero/accounting-verification/callback',
      secrets.clientId,
    );
    expect(new URL(authorization).searchParams.get('scope')).toContain('accounting.settings.read');
    expect(new URL(authorization).searchParams.get('scope')).not.toContain('practicemanager');
    const state = new URL(authorization).searchParams.get('state')!;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'accounting-token' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              {
                tenantId: 'org-tenant',
                tenantName: 'Versatile Accounting',
                tenantType: 'ORGANISATION',
              },
            ]),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ Organisations: [{ Name: 'Versatile Accounting Pty Ltd' }] }),
            { status: 200 },
          ),
        ),
    );
    const result = await completeXeroAccountingVerification(env.DB, state, 'code', secrets, userId);
    expect(result).toMatchObject({
      verified: true,
      httpStatus: 200,
      organisationName: 'Versatile Accounting Pty Ltd',
    });
    expect(await xeroAccountingVerificationStatus(env.DB)).toMatchObject({
      verified: true,
      httpStatus: 200,
    });
  });
  it('validates OAuth ownership and stores an encrypted connection', async () => {
    const authorization = await createXeroAuthorization(
      env.DB,
      userId,
      'https://timekeeper.example/api/admin/xero/callback',
      secrets.clientId,
    );
    const state = new URL(authorization).searchParams.get('state')!;
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      completeXeroAuthorization(env.DB, state, 'code', secrets, 'another-user'),
    ).rejects.toThrow('administrator who started');
    expect(await xeroConnectionStatus(env.DB)).toEqual({
      connected: false,
      tenantId: null,
      tenantName: null,
    });
  });

  it('rotates refresh tokens, sends strict JSON headers, and normalises clients and jobs', async () => {
    await connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Clients: {
              Client: [{ UUID: 'client-uuid', Name: 'Northbridge', ID: 'NB01', State: 'Active' }],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Jobs: {
              Job: [
                {
                  UUID: 'job-uuid',
                  ClientUUID: 'client-uuid',
                  Name: 'Annual accounts',
                  ID: 'AA26',
                  State: 'In Progress',
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const catalog = await loadXeroCatalog(env.DB, secrets);
    expect(catalog.clients).toEqual([
      expect.objectContaining({ externalId: 'client-uuid', clientCode: 'NB01', active: true }),
    ]);
    expect(catalog.jobs).toEqual([
      expect.objectContaining({
        externalId: 'job-uuid',
        clientExternalId: 'client-uuid',
        jobCode: 'AA26',
      }),
    ]);
    const headers = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Xero-Features')).toBe('practice-strict-content-type');
  });

  it('syncs the Xero catalogue into stable local records', async () => {
    await connect();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              Clients: { Client: [{ UUID: 'client-uuid', Name: 'Northbridge', ID: 'NB01' }] },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              Jobs: {
                Job: [
                  {
                    UUID: 'job-uuid',
                    ClientUUID: 'client-uuid',
                    Name: 'Annual accounts',
                    ID: 'AA26',
                  },
                ],
              },
            }),
            { status: 200 },
          ),
        ),
    );
    const counts = await syncFromXero(new D1TimeStore(env.DB), env.DB, secrets, 'manual');
    expect(counts).toMatchObject({ clientsCreated: 1, jobsCreated: 1 });
    expect((await new D1TimeStore(env.DB).listClients())[0]).toMatchObject({
      source: 'xero',
      externalId: 'client-uuid',
    });
  });

  it('relinks reviewed FYI records without changing local IDs or billable defaults', async () => {
    await connect();
    const now = Date.now();
    const legacyClientId = '10000000-0000-4000-8000-000000000001';
    const legacyJobId = '20000000-0000-4000-8000-000000000001';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO clients (id, external_id, source, name, client_code, active, created_at, updated_at, synced_at)
         VALUES (?, 'old-client', 'fyi', 'Old name', 'NB01', 1, ?, ?, ?)`,
      ).bind(legacyClientId, now, now, now),
      env.DB.prepare(
        `INSERT INTO jobs (id, external_id, client_id, source, name, job_code, active, default_billable, created_at, updated_at, synced_at)
         VALUES (?, 'old-job', ?, 'fyi', 'Old job', 'AA26', 1, 0, ?, ?, ?)`,
      ).bind(legacyJobId, legacyClientId, now, now, now),
    ]);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              Clients: {
                Client: [{ UUID: 'client-uuid', Name: 'Northbridge', ID: 'NB01' }],
              },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              Jobs: {
                Job: [
                  {
                    UUID: 'job-uuid',
                    ClientUUID: 'client-uuid',
                    Name: 'Annual accounts',
                    ID: 'AA26',
                  },
                ],
              },
            }),
            { status: 200 },
          ),
        ),
    );
    await applyXeroMigration(env.DB, secrets, {
      clients: [{ legacyId: legacyClientId, externalId: 'client-uuid' }],
      jobs: [{ legacyId: legacyJobId, externalId: 'job-uuid' }],
    });
    const store = new D1TimeStore(env.DB);
    expect((await store.listClients())[0]).toMatchObject({
      id: legacyClientId,
      source: 'xero',
      externalId: 'client-uuid',
    });
    expect((await store.listJobs())[0]).toMatchObject({
      id: legacyJobId,
      source: 'xero',
      externalId: 'job-uuid',
      defaultBillable: false,
    });
  });
});
