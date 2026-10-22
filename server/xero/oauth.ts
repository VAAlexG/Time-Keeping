import { base64, decrypt, encrypt, randomSecret, sha256 } from './crypto';
import {
  enabled,
  requireAdmin,
  requireId,
  XeroProblem,
  type Actor,
  type Connection,
  type ConnectionChoice,
  type Tokens,
  type XeroEnv,
} from './types';

export const XERO_SCOPES = 'openid profile email offline_access projects accounting.contacts.read';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const TOKEN_CONTEXT = 'timekeeper:xero-projects:connection:v1';

export function connection(db: D1Database): Promise<Connection | null> {
  return db.prepare('SELECT * FROM xero_projects_connection WHERE id=1').first<Connection>();
}

export function audit(
  db: D1Database,
  actor: Actor,
  action: string,
  entityId: string,
  details: unknown,
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO xero_projects_audit VALUES(?,?,?,?,?,?,?)')
    .bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      action,
      entityId,
      JSON.stringify(details),
      now,
    );
}

function config(env: XeroEnv): string {
  enabled(env);
  if (
    !env.XERO_CLIENT_ID ||
    !env.XERO_CLIENT_SECRET ||
    !env.XERO_REDIRECT_URI ||
    !env.XERO_TOKEN_KEY
  ) {
    throw new XeroProblem(
      'CONFIGURATION',
      'Configure the Xero client ID, client secret, exact callback URL and encryption key in Cloudflare.',
      503,
    );
  }
  let redirect: URL;
  try {
    redirect = new URL(env.XERO_REDIRECT_URI);
  } catch {
    throw new XeroProblem('CONFIGURATION', 'Invalid Xero callback URL.', 503);
  }
  if (
    redirect.protocol !== 'https:' ||
    redirect.pathname !== '/api/projects/oauth/callback' ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  ) {
    throw new XeroProblem(
      'CONFIGURATION',
      'Use the HTTPS app URL followed by /api/projects/oauth/callback.',
      503,
    );
  }
  return redirect.href;
}

async function exchange(
  env: XeroEnv,
  data: URLSearchParams,
  fetcher: typeof fetch,
): Promise<Tokens & { expires_in: number; scope: string }> {
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Basic ${base64(new TextEncoder().encode(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`))}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: data.toString(),
    });
  } catch {
    throw new XeroProblem(
      'NETWORK',
      'Xero authorisation could not be reached. Retry shortly.',
      503,
      30,
    );
  }
  if (response.status === 429) {
    throw new XeroProblem(
      'RATE_LIMIT',
      'Xero requested a pause before another authorisation request.',
      429,
      60,
    );
  }
  if (response.status >= 500) {
    throw new XeroProblem(
      'NETWORK',
      `Xero authorisation is temporarily unavailable (HTTP ${response.status}).`,
      503,
      30,
    );
  }
  if (!response.ok) {
    throw new XeroProblem(
      'RECONNECT',
      `Xero authorisation failed (HTTP ${response.status}). Reconnect or check app permissions.`,
      503,
    );
  }
  const result = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (
    typeof result.access_token !== 'string' ||
    typeof result.refresh_token !== 'string' ||
    !Number.isFinite(result.expires_in) ||
    Number(result.expires_in) <= 0
  ) {
    throw new XeroProblem(
      'TOKEN_RESPONSE',
      'Xero returned an incomplete authorisation response.',
      503,
    );
  }
  return {
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    expires_in: Number(result.expires_in),
    scope: typeof result.scope === 'string' ? result.scope : '',
  };
}

/**
 * Starts the confidential, server-side authorisation-code flow. State is
 * random, hashed at rest, expires after ten minutes, and is bound to the
 * authenticated administrator. PKCE is intentionally not used for this
 * confidential Worker client; the client secret remains server-side.
 */
export async function beginConnection(
  env: XeroEnv,
  actor: Actor,
  requestOrigin: string,
  now = Date.now(),
): Promise<{ authorisationUrl: string }> {
  requireAdmin(actor);
  const redirect = config(env);
  if (new URL(redirect).origin !== requestOrigin) {
    throw new XeroProblem('CONFIGURATION', 'The callback must use this app origin.', 503);
  }
  const state = randomSecret();
  const stateHash = await sha256(state);
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM xero_projects_oauth_states WHERE expires_at<? OR consumed_at IS NOT NULL',
    ).bind(now),
    env.DB.prepare('INSERT INTO xero_projects_oauth_states VALUES(?,?,?,?,?,NULL,?)').bind(
      stateHash,
      actor.id,
      actor.email,
      redirect,
      now + 600_000,
      now,
    ),
    audit(env.DB, actor, 'oauth_started', 'connection', {}, now),
  ]);
  const url = new URL('https://login.xero.com/identity/connect/authorize');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.XERO_CLIENT_ID!,
    redirect_uri: redirect,
    scope: XERO_SCOPES,
    state,
  }).toString();
  return { authorisationUrl: url.href };
}

export async function finishConnection(
  env: XeroEnv,
  actor: Actor,
  url: URL,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ choices: ConnectionChoice[] }> {
  requireAdmin(actor);
  const redirect = config(env);
  const expected = new URL(redirect);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new XeroProblem('OAUTH_STATE', 'Invalid callback URL.');
  }
  const state = url.searchParams.get('state');
  if (!state || state.length > 200) {
    throw new XeroProblem(
      'OAUTH_STATE',
      'The connection request is missing or expired. Start again.',
    );
  }
  const stateHash = await sha256(state);
  const consumed = await env.DB.prepare(
    `UPDATE xero_projects_oauth_states
       SET consumed_at=?
       WHERE state_hash=? AND actor_id=? AND actor_email=?
         AND redirect_uri=? AND consumed_at IS NULL AND expires_at>?
       RETURNING state_hash`,
  )
    .bind(now, stateHash, actor.id, actor.email, redirect, now)
    .first<{ state_hash: string }>();
  if (!consumed) {
    throw new XeroProblem(
      'OAUTH_STATE',
      'The request expired, was already used, or belongs to another administrator.',
    );
  }
  if (url.searchParams.has('error')) {
    throw new XeroProblem('CONSENT_DECLINED', 'Xero authorisation was not completed.');
  }
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) {
    throw new XeroProblem('OAUTH_CODE', 'Xero did not return an authorisation code.');
  }
  const tokens = await exchange(
    env,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
    }),
    fetcher,
  );
  const scopes = new Set(tokens.scope.split(' ').filter(Boolean));
  if (!scopes.has('projects') || !scopes.has('accounting.contacts.read')) {
    throw new XeroProblem(
      'MISSING_SCOPE',
      'Reconnect with Projects and read-only Contacts permissions.',
      503,
    );
  }
  const response = await fetcher('https://api.xero.com/connections', {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new XeroProblem('CONNECTIONS', 'Unable to read the authorised Xero organisations.', 503);
  }
  const raw = await response.json();
  if (!Array.isArray(raw)) {
    throw new XeroProblem('CONNECTIONS', 'Invalid organisation list.', 503);
  }
  const choices: ConnectionChoice[] = raw
    .filter(
      (value): value is ConnectionChoice =>
        typeof value === 'object' &&
        value !== null &&
        String((value as ConnectionChoice).tenantType).toUpperCase() === 'ORGANISATION',
    )
    .map((value) => ({
      id: requireId(value.id, 'connection'),
      tenantId: requireId(value.tenantId, 'tenant'),
      tenantName: String(value.tenantName).slice(0, 240),
      tenantType: 'ORGANISATION',
    }));
  if (!choices.length) {
    throw new XeroProblem('CONNECTIONS', 'No accounting organisation was authorised.', 503);
  }
  const encrypted = await encrypt(
    {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    },
    env.XERO_TOKEN_KEY,
    TOKEN_CONTEXT,
  );
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE xero_projects_connection
         SET encrypted_tokens=?, expires_at=?, pending_connections_json=?,
             pending_actor_id=?, connected=0, paused=1,
             refresh_lease_token=NULL, refresh_lease_until=0,
             token_revision=token_revision+1,
             connection_revision=connection_revision+1, updated_at=?
         WHERE id=1`,
    ).bind(encrypted, now + tokens.expires_in * 1000, JSON.stringify(choices), actor.id, now),
    audit(
      env.DB,
      actor,
      'oauth_authorised_pending_selection',
      'connection',
      { organisationCount: choices.length },
      now,
    ),
  ]);
  return { choices };
}

export async function selectOrganisation(
  env: XeroEnv,
  actor: Actor,
  tenantIdInput: string,
  confirmation: string,
  now = Date.now(),
): Promise<{ tenantId: string; tenantName: string; paused: true }> {
  enabled(env);
  requireAdmin(actor);
  const tenantId = requireId(tenantIdInput, 'tenant');
  const current = await connection(env.DB);
  if (
    !current ||
    !current.pending_connections_json ||
    current.pending_actor_id !== actor.id ||
    !current.encrypted_tokens
  ) {
    throw new XeroProblem(
      'CONNECTIONS',
      'This administrator must complete the Xero connection first.',
      409,
    );
  }
  const selected = (JSON.parse(current.pending_connections_json) as ConnectionChoice[]).find(
    (value) => value.tenantId === tenantId,
  );
  if (!selected || confirmation !== selected.tenantName) {
    throw new XeroProblem('CONFIRM_ORGANISATION', 'Type the exact selected organisation name.');
  }
  const used = await env.DB.prepare('SELECT id FROM xero_projects_approvals LIMIT 1').first();
  if (used && current.tenant_id && current.tenant_id !== tenantId) {
    throw new XeroProblem(
      'TENANT_CHANGE',
      'Reviewed records already belong to another Xero organisation. A separate migration is required.',
      409,
    );
  }
  const selectedRow = await env.DB.prepare(
    `UPDATE xero_projects_connection
       SET tenant_id=?, tenant_name=?, connection_id=?, connected=1, paused=1,
           pending_connections_json=NULL, pending_actor_id=NULL,
           connection_revision=connection_revision+1, updated_at=?
       WHERE id=1 AND connection_revision=? AND pending_actor_id=?
       RETURNING id`,
  )
    .bind(
      selected.tenantId,
      selected.tenantName,
      selected.id,
      now,
      current.connection_revision,
      actor.id,
    )
    .first();
  if (!selectedRow) {
    throw new XeroProblem(
      'CONNECTION_CHANGED',
      'The Xero connection changed. Start selection again.',
      409,
    );
  }
  await audit(
    env.DB,
    actor,
    'organisation_selected_uploads_paused',
    selected.tenantId,
    { name: selected.tenantName },
    now,
  ).run();
  return {
    tenantId: selected.tenantId,
    tenantName: selected.tenantName,
    paused: true,
  };
}

export async function accessToken(
  env: XeroEnv,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ token: string; tenantId: string; revision: number }> {
  config(env);
  const current = await connection(env.DB);
  if (!current?.connected || !current.tenant_id || !current.encrypted_tokens) {
    throw new XeroProblem('RECONNECT', 'Connect and confirm the practice Xero organisation.', 503);
  }
  const tokens = await decrypt<Tokens>(current.encrypted_tokens, env.XERO_TOKEN_KEY, TOKEN_CONTEXT);
  if (current.expires_at > now + 60_000) {
    return {
      token: tokens.access_token,
      tenantId: current.tenant_id,
      revision: current.token_revision,
    };
  }
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE xero_projects_connection
       SET refresh_lease_token=?, refresh_lease_until=?, updated_at=?
       WHERE id=1 AND token_revision=? AND refresh_lease_until<=?
       RETURNING id`,
  )
    .bind(lease, now + 60_000, now, current.token_revision, now)
    .first();
  if (!claimed) {
    throw new XeroProblem(
      'REFRESH_BUSY',
      'Another request is refreshing Xero. Retry shortly.',
      503,
      5,
    );
  }
  try {
    const refreshed = await exchange(
      env,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      }),
      fetcher,
    );
    const encrypted = await encrypt(
      {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
      },
      env.XERO_TOKEN_KEY,
      TOKEN_CONTEXT,
    );
    const saved = await env.DB.prepare(
      `UPDATE xero_projects_connection
         SET encrypted_tokens=?, expires_at=?, refresh_lease_token=NULL,
             refresh_lease_until=0, token_revision=token_revision+1,
             updated_at=?
         WHERE id=1 AND refresh_lease_token=? AND token_revision=?
         RETURNING token_revision`,
    )
      .bind(encrypted, now + refreshed.expires_in * 1000, now, lease, current.token_revision)
      .first<{ token_revision: number }>();
    if (!saved) {
      throw new XeroProblem(
        'CONNECTION_CHANGED',
        'The Xero connection changed while refreshing. Retry.',
        503,
        5,
      );
    }
    return {
      token: refreshed.access_token,
      tenantId: current.tenant_id,
      revision: saved.token_revision,
    };
  } finally {
    await env.DB.prepare(
      `UPDATE xero_projects_connection
         SET refresh_lease_token=NULL, refresh_lease_until=0
         WHERE id=1 AND refresh_lease_token=?`,
    )
      .bind(lease)
      .run();
  }
}

export async function saveControls(
  env: XeroEnv,
  actor: Actor,
  input: { cutoverAt: number; paused: boolean },
  now = Date.now(),
): Promise<{ cutoverAt: number; paused: boolean }> {
  enabled(env);
  requireAdmin(actor);
  if (
    !Number.isSafeInteger(input.cutoverAt) ||
    input.cutoverAt < 0 ||
    typeof input.paused !== 'boolean'
  ) {
    throw new XeroProblem('CONTROLS', 'Choose a valid cutover date and pause setting.');
  }
  const current = await connection(env.DB);
  if (!current?.connected) {
    throw new XeroProblem('RECONNECT', 'Confirm a Xero organisation first.', 409);
  }
  if (
    (await env.DB.prepare('SELECT id FROM xero_projects_approvals LIMIT 1').first()) &&
    current.cutover_at !== input.cutoverAt
  ) {
    throw new XeroProblem(
      'CUTOVER_FROZEN',
      'The cutover date is frozen after approval records exist.',
      409,
    );
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE xero_projects_connection
         SET cutover_at=?, paused=?, connection_revision=connection_revision+1,
             updated_at=? WHERE id=1`,
    ).bind(input.cutoverAt, Number(input.paused), now),
    audit(env.DB, actor, 'upload_controls', 'connection', input, now),
  ]);
  return input;
}

/** Disconnects credentials fail-closed while preserving tenant-bound history. */
export async function disconnectConnection(
  env: XeroEnv,
  actor: Actor,
  confirmed: boolean,
  now = Date.now(),
): Promise<{ disconnected: true }> {
  requireAdmin(actor);
  if (confirmed !== true) {
    throw new XeroProblem(
      'DISCONNECT_CONFIRMATION',
      'Confirm that Xero uploads will stop and a new connection will be required.',
    );
  }
  const current = await connection(env.DB);
  if (!current) {
    throw new XeroProblem('CONNECTION', 'The Xero connection record is missing.', 503);
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE xero_projects_connection
         SET encrypted_tokens=NULL,expires_at=0,pending_connections_json=NULL,
             pending_actor_id=NULL,connected=0,paused=1,
             refresh_lease_token=NULL,refresh_lease_until=0,
             catalogue_lease_token=NULL,catalogue_lease_until=0,
             throttle_until=0,token_revision=token_revision+1,
             connection_revision=connection_revision+1,
             updated_at=? WHERE id=1`,
    ).bind(now),
    audit(
      env.DB,
      actor,
      'connection_disconnected',
      current.tenant_id ?? 'connection',
      { tenantName: current.tenant_name, historyPreserved: true },
      now,
    ),
  ]);
  return { disconnected: true };
}
