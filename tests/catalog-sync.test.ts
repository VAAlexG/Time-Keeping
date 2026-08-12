import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { importCatalogCsv } from '../server/catalog-sync';
import { D1TimeStore } from '../server/d1-store';

const csv = `client_external_id,client_name,client_code,export_code,client_active,job_external_id,job_name,job_code,job_status,job_active
client-1,Northbridge Joinery,NJ01,XPM-NJ,true,job-1,Annual accounts,AA26,active,true
client-1,Northbridge Joinery,NJ01,XPM-NJ,true,job-2,BAS - September quarter,BAS-Q1,active,true
client-2,Acme Trades,AT02,XPM-AT,true,job-3,Bookkeeping,BK,active,true`;

describe('practice catalogue import', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM time_entries'),
      env.DB.prepare('DELETE FROM jobs'),
      env.DB.prepare('DELETE FROM clients'),
      env.DB.prepare('DELETE FROM sync_runs'),
    ]);
  });

  it('imports stable client/job IDs and preserves an admin billable override on repeat import', async () => {
    const store = new D1TimeStore(env.DB);
    const first = await importCatalogCsv(store, csv);
    expect(first).toMatchObject({ clientsCreated: 2, jobsCreated: 3 });
    const clients = await store.listClients({ activeOnly: true });
    const jobs = await store.listJobs(undefined, true);
    expect(clients.map((item) => item.externalId)).toEqual(['client-2', 'client-1']);
    expect(jobs).toHaveLength(3);
    const selected = jobs.find((item) => item.externalId === 'job-1')!;
    await store.setJobBillableDefault(selected.id, false);
    await importCatalogCsv(store, csv.replace('Annual accounts', 'Annual accounts FY26'));
    const updated = (await store.listJobs()).find((item) => item.externalId === 'job-1')!;
    expect(updated.name).toBe('Annual accounts FY26');
    expect(updated.defaultBillable).toBe(false);
    expect((await store.latestSync())?.status).toBe('succeeded');
  });

  it('rejects duplicate job external IDs and records a safe failed sync status', async () => {
    const store = new D1TimeStore(env.DB);
    const duplicate = `${csv}\nclient-2,Acme Trades,AT02,XPM-AT,true,job-3,Duplicate,BK,active,true`;
    await expect(importCatalogCsv(store, duplicate)).rejects.toThrow(
      'Duplicate or missing job external ID',
    );
    const latest = await store.latestSync();
    expect(latest).toMatchObject({ source: 'csv', status: 'failed' });
    expect(latest?.errorMessage).not.toContain('secret');
  });

  it('imports clients that do not yet have a selectable job', async () => {
    const clientOnly = `${csv}\nclient-3,Future Client,FC03,XPM-FC,true,,,,,`;
    const counts = await importCatalogCsv(new D1TimeStore(env.DB), clientOnly);
    expect(counts).toMatchObject({ clientsCreated: 3, jobsCreated: 3 });
    expect(await new D1TimeStore(env.DB).listClients({ activeOnly: true })).toHaveLength(3);
  });

  it('rejects a partially populated job classification', async () => {
    const partialJob = `${csv}\nclient-3,Future Client,FC03,XPM-FC,true,job-4,,,,`;
    await expect(importCatalogCsv(new D1TimeStore(env.DB), partialJob)).rejects.toThrow(
      'must include both a job external ID and job name',
    );
  });
});
