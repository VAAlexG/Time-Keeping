import { D1TimeStore, type CatalogClientInput, type CatalogJobInput } from './d1-store';
import type { SyncCounts } from './types';

export interface FyiConfig {
  baseUrl: string;
  accessId: string;
  accessSecret: string;
  applicationId?: string;
}

type JsonRecord = Record<string, unknown>;

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

function pick(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
}

function recordsFrom(body: unknown): JsonRecord[] {
  if (Array.isArray(body))
    return body.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object');
  if (!body || typeof body !== 'object') return [];
  const record = body as JsonRecord;
  for (const key of ['data', 'results', 'entities', 'jobs']) {
    const value = record[key];
    if (Array.isArray(value))
      return value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object');
  }
  return [];
}

async function fyiList(config: FyiConfig, resource: 'entity' | 'job'): Promise<JsonRecord[]> {
  const all: JsonRecord[] = [];
  for (let page = 1; page <= 200; page++) {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'x-fyi-access-id': config.accessId,
      'x-fyi-access-secret': config.accessSecret,
    });
    if (config.applicationId) headers.set('x-fyi-application-id', config.applicationId);
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/${resource}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        page,
        per_page: 500,
        ...(resource === 'entity' ? { is_client: true } : {}),
      }),
    });
    if (!response.ok) throw new Error(`FYI ${resource} request failed (${response.status}).`);
    const pageRecords = recordsFrom(await response.json());
    all.push(...pageRecords);
    if (pageRecords.length < 500) break;
  }
  return all;
}

function normaliseClients(records: JsonRecord[]): CatalogClientInput[] {
  return records.map((record) => {
    const externalId = text(pick(record, 'id', 'entity_id', 'uuid', 'source_id'));
    const name = text(pick(record, 'name', 'display_name', 'entity_name'));
    if (!externalId || !name) throw new Error('FYI returned a client without an ID or name.');
    const activeValue = pick(record, 'is_client', 'active', 'is_active');
    return {
      externalId,
      name,
      clientCode: text(pick(record, 'client_code', 'code')),
      exportCode: text(pick(record, 'export_code', 'source_id')),
      managerName: text(pick(record, 'manager_name', 'manager')),
      partnerName: text(pick(record, 'partner_name', 'partner')),
      active: activeValue === undefined ? true : Boolean(activeValue),
    };
  });
}

function normaliseJobs(records: JsonRecord[]): CatalogJobInput[] {
  return records.map((record) => {
    const externalId = text(pick(record, 'id', 'job_id', 'uuid'));
    const clientValue = pick(record, 'entity_id', 'client_id', 'client_uuid', 'entity');
    const clientExternalId =
      typeof clientValue === 'object' && clientValue
        ? text(pick(clientValue as JsonRecord, 'id', 'uuid'))
        : text(clientValue);
    const name = text(pick(record, 'name', 'job_name', 'description'));
    if (!externalId || !clientExternalId || !name)
      throw new Error('FYI returned a job without an ID, client, or name.');
    const activeValue = pick(record, 'active', 'is_active');
    const status = text(pick(record, 'status', 'state'));
    return {
      externalId,
      clientExternalId,
      name,
      jobCode: text(pick(record, 'job_code', 'code')),
      status,
      active:
        activeValue === undefined
          ? !['completed', 'cancelled', 'archived'].includes(status?.toLowerCase() ?? '')
          : Boolean(activeValue),
    };
  });
}

export async function syncFromFyi(
  store: D1TimeStore,
  config: FyiConfig,
  trigger: 'scheduled' | 'manual',
): Promise<SyncCounts> {
  const runId = await store.beginSync('fyi', trigger);
  try {
    const [clients, jobs] = await Promise.all([fyiList(config, 'entity'), fyiList(config, 'job')]);
    const counts = await store.syncCatalog(
      'fyi',
      normaliseClients(clients),
      normaliseJobs(jobs),
      true,
    );
    await store.finishSync(runId, counts);
    return counts;
  } catch (error) {
    await store.failSync(runId, error instanceof Error ? error.message : 'FYI sync failed.');
    throw error;
  }
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        value += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && csv[index + 1] === '\n') index++;
      row.push(value);
      value = '';
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else value += char;
  }
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  return rows;
}

export async function importCatalogCsv(store: D1TimeStore, csv: string): Promise<SyncCounts> {
  const runId = await store.beginSync('csv', 'import');
  try {
    const rows = parseCsvRows(csv.replace(/^\uFEFF/, ''));
    if (rows.length < 2) throw new Error('CSV must include a header and at least one data row.');
    const headers = rows[0].map((item) => item.trim().toLowerCase());
    const required = ['client_external_id', 'client_name', 'job_external_id', 'job_name'];
    for (const name of required)
      if (!headers.includes(name)) throw new Error(`CSV is missing required column ${name}.`);
    const get = (row: string[], name: string) => row[headers.indexOf(name)]?.trim() ?? '';
    const clients = new Map<string, CatalogClientInput>();
    const jobs: CatalogJobInput[] = [];
    for (const row of rows.slice(1)) {
      const clientExternalId = get(row, 'client_external_id');
      const jobExternalId = get(row, 'job_external_id');
      const active = (name: string) =>
        !['false', '0', 'no', 'archived'].includes(get(row, name).toLowerCase());
      clients.set(clientExternalId, {
        externalId: clientExternalId,
        name: get(row, 'client_name'),
        clientCode: get(row, 'client_code') || null,
        exportCode: get(row, 'export_code') || null,
        managerName: get(row, 'manager') || null,
        partnerName: get(row, 'partner') || null,
        active: active('client_active'),
      });
      jobs.push({
        externalId: jobExternalId,
        clientExternalId,
        name: get(row, 'job_name'),
        jobCode: get(row, 'job_code') || null,
        status: get(row, 'job_status') || null,
        active: active('job_active'),
      });
    }
    const counts = await store.syncCatalog('csv', [...clients.values()], jobs, false);
    await store.finishSync(runId, counts);
    return counts;
  } catch (error) {
    await store.failSync(runId, error instanceof Error ? error.message : 'CSV import failed.');
    throw error;
  }
}
