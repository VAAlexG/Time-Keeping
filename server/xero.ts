import { D1TimeStore, type CatalogClientInput, type CatalogJobInput } from './d1-store';
import type { Client, Job, SyncCounts } from './types';

const AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const ORGANISATION_URL = 'https://api.xero.com/api.xro/2.0/Organisation';
const XPM_BASE = 'https://api.xero.com/practicemanager/3.1';
const SCOPES =
  'openid profile email offline_access practicemanager.client.read practicemanager.job.read';
const ACCOUNTING_VERIFICATION_SCOPES =
  'openid profile email offline_access accounting.settings.read';

type JsonRecord = Record<string, unknown>;
export interface XeroSecrets {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
}
export interface XeroConnectionStatus {
  connected: boolean;
  tenantId: string | null;
  tenantName: string | null;
}
export interface XeroAccountingVerification {
  verified: boolean;
  tenantId: string | null;
  tenantName: string | null;
  organisationName: string | null;
  verifiedAt: string | null;
  httpStatus: number | null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
async function encryptionKey(value: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== 32)
    throw new Error('XERO_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(value: string, keyValue: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(keyValue),
    new TextEncoder().encode(value),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}
async function decrypt(value: string, keyValue: string): Promise<string> {
  const [iv, payload] = value.split('.');
  if (!iv || !payload) throw new Error('Stored Xero token is invalid. Reconnect Xero.');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    await encryptionKey(keyValue),
    base64ToBytes(payload),
  );
  return new TextDecoder().decode(decrypted);
}
async function hash(value: string): Promise<string> {
  return bytesToBase64(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  );
}
function randomState(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export async function createXeroAuthorization(
  db: D1Database,
  userId: string,
  redirectUri: string,
  clientId: string,
  scopes = SCOPES,
): Promise<string> {
  const state = randomState();
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM xero_oauth_states WHERE expires_at < ?').bind(now),
    db
      .prepare(
        `INSERT INTO xero_oauth_states (state_hash, created_by_user_id, redirect_uri, expires_at)
       VALUES (?, ?, ?, ?)`,
      )
      .bind(await hash(state), userId, redirectUri, now + 10 * 60_000),
  ]);
  const url = new URL(AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function createXeroAccountingVerificationAuthorization(
  db: D1Database,
  userId: string,
  redirectUri: string,
  clientId: string,
): Promise<string> {
  return createXeroAuthorization(db, userId, redirectUri, clientId, ACCOUNTING_VERIFICATION_SCOPES);
}

async function tokenRequest(secrets: XeroSecrets, body: URLSearchParams): Promise<JsonRecord> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Basic ${btoa(`${secrets.clientId}:${secrets.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  if (!response.ok) throw new Error(`Xero token request failed (${response.status}).`);
  return (await response.json()) as JsonRecord;
}

export async function completeXeroAuthorization(
  db: D1Database,
  state: string,
  code: string,
  secrets: XeroSecrets,
  expectedUserId?: string,
): Promise<XeroConnectionStatus> {
  const stateHash = await hash(state);
  const saved = await db
    .prepare(
      'SELECT created_by_user_id, redirect_uri, expires_at FROM xero_oauth_states WHERE state_hash = ?',
    )
    .bind(stateHash)
    .first<{ created_by_user_id: string; redirect_uri: string; expires_at: number }>();
  if (!saved || saved.expires_at < Date.now())
    throw new Error('Xero authorization expired or is invalid.');
  if (expectedUserId && saved.created_by_user_id !== expectedUserId)
    throw new Error('Xero authorization must be completed by the administrator who started it.');
  await db.prepare('DELETE FROM xero_oauth_states WHERE state_hash = ?').bind(stateHash).run();
  const token = await tokenRequest(
    secrets,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: saved.redirect_uri,
    }),
  );
  const accessToken = String(token.access_token ?? '');
  const refreshToken = String(token.refresh_token ?? '');
  if (!accessToken || !refreshToken)
    throw new Error('Xero did not return the required OAuth tokens.');
  const response = await fetch(CONNECTIONS_URL, {
    redirect: 'error',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Xero connections request failed (${response.status}).`);
  const connections = (await response.json()) as JsonRecord[];
  const connection = connections.find((item) =>
    String(item.tenantType ?? '')
      .toUpperCase()
      .includes('PRACTICE'),
  );
  if (!connection) throw new Error('No Xero Practice Manager tenant was authorised.');
  const tenantId = String(connection.tenantId ?? '');
  const tenantName = String(connection.tenantName ?? 'Xero Practice Manager');
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO xero_connections
       (id, tenant_id, tenant_name, encrypted_refresh_token, connected_by_user_id, connected_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, tenant_name = excluded.tenant_name,
       encrypted_refresh_token = excluded.encrypted_refresh_token, connected_by_user_id = excluded.connected_by_user_id,
       connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
    )
    .bind(
      tenantId,
      tenantName,
      await encrypt(refreshToken, secrets.encryptionKey),
      saved.created_by_user_id,
      now,
      now,
    )
    .run();
  return { connected: true, tenantId, tenantName };
}

export async function completeXeroAccountingVerification(
  db: D1Database,
  state: string,
  code: string,
  secrets: XeroSecrets,
  expectedUserId: string,
): Promise<XeroAccountingVerification> {
  const stateHash = await hash(state);
  const saved = await db
    .prepare(
      'SELECT created_by_user_id, redirect_uri, expires_at FROM xero_oauth_states WHERE state_hash = ?',
    )
    .bind(stateHash)
    .first<{ created_by_user_id: string; redirect_uri: string; expires_at: number }>();
  if (!saved || saved.expires_at < Date.now())
    throw new Error('Xero authorization expired or is invalid.');
  if (saved.created_by_user_id !== expectedUserId)
    throw new Error('Xero authorization must be completed by the administrator who started it.');
  await db.prepare('DELETE FROM xero_oauth_states WHERE state_hash = ?').bind(stateHash).run();
  const token = await tokenRequest(
    secrets,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: saved.redirect_uri,
    }),
  );
  const accessToken = String(token.access_token ?? '');
  if (!accessToken) throw new Error('Xero did not return an access token.');
  const connectionResponse = await fetch(CONNECTIONS_URL, {
    redirect: 'error',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!connectionResponse.ok)
    throw new Error(`Xero connections request failed (${connectionResponse.status}).`);
  const connections = (await connectionResponse.json()) as JsonRecord[];
  const connection = connections.find((item) =>
    String(item.tenantType ?? '')
      .toUpperCase()
      .includes('ORGANISATION'),
  );
  if (!connection) throw new Error('No Xero organisation was authorised.');
  const tenantId = String(connection.tenantId ?? '');
  const tenantName = String(connection.tenantName ?? 'Xero organisation');
  const organisationResponse = await fetch(ORGANISATION_URL, {
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      Accept: 'application/json',
    },
  });
  if (!organisationResponse.ok)
    throw new Error(`Xero Organisation API call failed (${organisationResponse.status}).`);
  const body = (await organisationResponse.json()) as JsonRecord;
  const organisations = records(body, ['Organisations']);
  const organisationName = field(organisations[0] ?? {}, 'Name', 'name') ?? tenantName;
  const verifiedAt = Date.now();
  await db
    .prepare(
      `INSERT INTO xero_accounting_verifications
       (id, tenant_id, tenant_name, organisation_name, verified_by_user_id, verified_at, http_status)
       VALUES (1, ?, ?, ?, ?, ?, 200)
       ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id,
       tenant_name=excluded.tenant_name, organisation_name=excluded.organisation_name,
       verified_by_user_id=excluded.verified_by_user_id, verified_at=excluded.verified_at,
       http_status=excluded.http_status`,
    )
    .bind(tenantId, tenantName, organisationName, saved.created_by_user_id, verifiedAt)
    .run();
  return {
    verified: true,
    tenantId,
    tenantName,
    organisationName,
    verifiedAt: new Date(verifiedAt).toISOString(),
    httpStatus: 200,
  };
}

export async function xeroAccountingVerificationStatus(
  db: D1Database,
): Promise<XeroAccountingVerification> {
  const row = await db
    .prepare(
      'SELECT tenant_id, tenant_name, organisation_name, verified_at, http_status FROM xero_accounting_verifications WHERE id=1',
    )
    .first<{
      tenant_id: string;
      tenant_name: string;
      organisation_name: string;
      verified_at: number;
      http_status: number;
    }>();
  return {
    verified: Boolean(row),
    tenantId: row?.tenant_id ?? null,
    tenantName: row?.tenant_name ?? null,
    organisationName: row?.organisation_name ?? null,
    verifiedAt: row ? new Date(row.verified_at).toISOString() : null,
    httpStatus: row?.http_status ?? null,
  };
}

export async function xeroConnectionStatus(db: D1Database): Promise<XeroConnectionStatus> {
  const row = await db
    .prepare('SELECT tenant_id, tenant_name FROM xero_connections WHERE id = 1')
    .first<{ tenant_id: string; tenant_name: string }>();
  return {
    connected: Boolean(row),
    tenantId: row?.tenant_id ?? null,
    tenantName: row?.tenant_name ?? null,
  };
}
export async function disconnectXero(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM xero_connections WHERE id = 1').run();
}

async function accessToken(
  db: D1Database,
  secrets: XeroSecrets,
): Promise<{ token: string; tenantId: string }> {
  const connection = await db
    .prepare('SELECT tenant_id, encrypted_refresh_token FROM xero_connections WHERE id = 1')
    .first<{ tenant_id: string; encrypted_refresh_token: string }>();
  if (!connection) throw new Error('Xero Practice Manager is not connected.');
  const token = await tokenRequest(
    secrets,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: await decrypt(connection.encrypted_refresh_token, secrets.encryptionKey),
    }),
  );
  const nextAccessToken = String(token.access_token ?? '');
  const nextRefreshToken = String(token.refresh_token ?? '');
  if (!nextAccessToken || !nextRefreshToken)
    throw new Error('Xero token refresh returned an invalid response.');
  await db
    .prepare('UPDATE xero_connections SET encrypted_refresh_token = ?, updated_at = ? WHERE id = 1')
    .bind(await encrypt(nextRefreshToken, secrets.encryptionKey), Date.now())
    .run();
  return { token: nextAccessToken, tenantId: connection.tenant_id };
}

function records(body: unknown, keys: string[]): JsonRecord[] {
  if (Array.isArray(body))
    return body.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object');
  if (!body || typeof body !== 'object') return [];
  const object = body as JsonRecord;
  for (const key of keys) {
    const value = object[key];
    if (Array.isArray(value)) return records(value, []);
    if (value && typeof value === 'object') {
      const nested = records(value, keys);
      if (nested.length) return nested;
    }
  }
  return [];
}
function field(record: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim())
      return String(value).trim();
  }
  return null;
}
async function xeroGet(
  url: string,
  token: string,
  tenantId: string,
  retry = true,
): Promise<unknown> {
  const response = await fetch(url, {
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Xero-Features': 'practice-strict-content-type',
    },
  });
  if (response.status === 429 && retry) {
    const seconds = Math.min(Number(response.headers.get('Retry-After') ?? '1'), 30);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return xeroGet(url, token, tenantId, false);
  }
  if (!response.ok) throw new Error(`Xero Practice Manager request failed (${response.status}).`);
  return response.json();
}

export async function loadXeroCatalog(
  db: D1Database,
  secrets: XeroSecrets,
): Promise<{ clients: CatalogClientInput[]; jobs: CatalogJobInput[] }> {
  const auth = await accessToken(db, secrets);
  const clients: CatalogClientInput[] = [];
  for (let page = 1; page <= 200; page++) {
    const body = await xeroGet(
      `${XPM_BASE}/client.api/list?page=${page}`,
      auth.token,
      auth.tenantId,
    );
    const pageRecords = records(body, ['Clients', 'clients', 'Client', 'client']);
    for (const item of pageRecords) {
      const externalId = field(item, 'UUID', 'uuid', 'ClientUUID', 'clientUuid');
      const name = field(item, 'Name', 'name');
      if (!externalId || !name) throw new Error('Xero returned a client without a UUID or name.');
      const archived =
        field(item, 'State', 'state', 'Status', 'status')?.toLowerCase() === 'archived';
      clients.push({
        externalId,
        name,
        clientCode: field(item, 'ID', 'id', 'ClientCode', 'clientCode'),
        exportCode: field(item, 'ExportCode', 'exportCode'),
        managerName: field(item, 'ManagerName', 'managerName'),
        partnerName: field(item, 'PartnerName', 'partnerName'),
        active: !archived,
      });
    }
    if (!pageRecords.length || pageRecords.length < 100) break;
  }
  const jobBody = await xeroGet(`${XPM_BASE}/job.api/current`, auth.token, auth.tenantId);
  const jobRecords = records(jobBody, ['Jobs', 'jobs', 'Job', 'job']);
  const jobs = jobRecords.map((item): CatalogJobInput => {
    const externalId = field(item, 'UUID', 'uuid', 'JobUUID', 'jobUuid');
    const clientExternalId = field(item, 'ClientUUID', 'clientUuid');
    const name = field(item, 'Name', 'name', 'Description', 'description');
    if (!externalId || !clientExternalId || !name)
      throw new Error('Xero returned a job without a UUID, client UUID, or name.');
    const status = field(item, 'State', 'state', 'Status', 'status');
    return {
      externalId,
      clientExternalId,
      name,
      jobCode: field(item, 'ID', 'id', 'JobNumber', 'jobNumber'),
      status,
      active: !['completed', 'cancelled', 'archived'].includes(status?.toLowerCase() ?? ''),
    };
  });
  return { clients, jobs };
}

export async function syncFromXero(
  store: D1TimeStore,
  db: D1Database,
  secrets: XeroSecrets,
  trigger: 'scheduled' | 'manual',
): Promise<SyncCounts> {
  const runId = await store.beginSync('xero', trigger);
  try {
    const catalog = await loadXeroCatalog(db, secrets);
    const counts = await store.syncCatalog('xero', catalog.clients, catalog.jobs, true);
    await store.finishSync(runId, counts);
    return counts;
  } catch (error) {
    await store.failSync(runId, error instanceof Error ? error.message : 'Xero sync failed.');
    throw error;
  }
}

function key(value: string | null): string | null {
  return value?.trim().toLowerCase() || null;
}
function suggestions<T extends Client | Job, U extends CatalogClientInput | CatalogJobInput>(
  legacy: T[],
  incoming: U[],
  codeOf: (item: T | U) => string | null,
) {
  return legacy.map((old) => {
    const code = key(codeOf(old));
    const codeMatches = code ? incoming.filter((item) => key(codeOf(item)) === code) : [];
    const nameMatches = incoming.filter((item) => key(item.name) === key(old.name));
    const match =
      codeMatches.length === 1 ? codeMatches[0] : nameMatches.length === 1 ? nameMatches[0] : null;
    return {
      legacyId: old.id,
      legacyName: old.name,
      legacyCode: codeOf(old),
      suggestedExternalId: match?.externalId ?? null,
      reason:
        codeMatches.length === 1
          ? 'code'
          : nameMatches.length === 1
            ? 'name'
            : codeMatches.length > 1 || nameMatches.length > 1
              ? 'ambiguous'
              : 'unmatched',
    };
  });
}
export async function previewXeroMigration(db: D1Database, secrets: XeroSecrets) {
  const store = new D1TimeStore(db);
  const catalog = await loadXeroCatalog(db, secrets);
  const clients = (await store.listClients()).filter((item) => item.source === 'fyi');
  const jobs = (await store.listJobs()).filter((item) => item.source === 'fyi');
  return {
    catalog,
    clients: suggestions(clients, catalog.clients, (item) =>
      'clientCode' in item ? (item.clientCode ?? null) : null,
    ),
    jobs: suggestions(jobs, catalog.jobs, (item) =>
      'jobCode' in item ? (item.jobCode ?? null) : null,
    ),
  };
}

export async function applyXeroMigration(
  db: D1Database,
  secrets: XeroSecrets,
  mappings: {
    clients: { legacyId: string; externalId: string }[];
    jobs: { legacyId: string; externalId: string }[];
  },
): Promise<SyncCounts> {
  const catalog = await loadXeroCatalog(db, secrets);
  const clients = new Map(catalog.clients.map((item) => [item.externalId, item]));
  const jobs = new Map(catalog.jobs.map((item) => [item.externalId, item]));
  const timestamp = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const mapping of mappings.clients) {
    const item = clients.get(mapping.externalId);
    if (!item) throw new Error(`Unknown Xero client ${mapping.externalId}.`);
    statements.push(
      db
        .prepare(
          `UPDATE clients SET external_id = ?, source = 'xero', name = ?, client_code = ?, export_code = ?,
       manager_name = ?, partner_name = ?, active = ?, updated_at = ?, synced_at = ? WHERE id = ? AND source = 'fyi'`,
        )
        .bind(
          item.externalId,
          item.name,
          item.clientCode ?? null,
          item.exportCode ?? null,
          item.managerName ?? null,
          item.partnerName ?? null,
          Number(item.active),
          timestamp,
          timestamp,
          mapping.legacyId,
        ),
    );
  }
  for (const mapping of mappings.jobs) {
    const item = jobs.get(mapping.externalId);
    if (!item) throw new Error(`Unknown Xero job ${mapping.externalId}.`);
    const client = mappings.clients.find(
      (candidate) => candidate.externalId === item.clientExternalId,
    );
    const clientRow = client
      ? await db
          .prepare('SELECT id FROM clients WHERE id = ?')
          .bind(client.legacyId)
          .first<{ id: string }>()
      : await db
          .prepare("SELECT id FROM clients WHERE external_id = ? AND source = 'xero'")
          .bind(item.clientExternalId)
          .first<{ id: string }>();
    if (!clientRow) throw new Error(`Xero job ${item.externalId} has no mapped client.`);
    statements.push(
      db
        .prepare(
          `UPDATE jobs SET external_id = ?, source = 'xero', client_id = ?, name = ?, job_code = ?, status = ?,
       active = ?, updated_at = ?, synced_at = ? WHERE id = ? AND source = 'fyi'`,
        )
        .bind(
          item.externalId,
          clientRow.id,
          item.name,
          item.jobCode ?? null,
          item.status ?? null,
          Number(item.active),
          timestamp,
          timestamp,
          mapping.legacyId,
        ),
    );
  }
  statements.push(
    db.prepare("UPDATE jobs SET active = 0, updated_at = ? WHERE source = 'fyi'").bind(timestamp),
  );
  statements.push(
    db
      .prepare("UPDATE clients SET active = 0, updated_at = ? WHERE source = 'fyi'")
      .bind(timestamp),
  );
  if (statements.length) await db.batch(statements);
  return new D1TimeStore(db).syncCatalog('xero', catalog.clients, catalog.jobs, true);
}
