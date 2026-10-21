import { base64, challenge, decrypt, encrypt, randomSecret, sha256 } from './crypto';
import { enabled, requireAdmin, requireId, XeroProblem, type Actor, type Connection, type ConnectionChoice, type Tokens, type XeroEnv } from './types';
export const XERO_SCOPES = 'openid profile email offline_access projects accounting.contacts.read';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const TOKEN_CONTEXT = 'timekeeper:xero:connection:v1';
export function connection(db: D1Database): Promise<Connection | null> {
  return db.prepare('SELECT * FROM xero_connection WHERE id=1').first<Connection>();
}
export function audit(db: D1Database, actor: Actor, action: string, entity: string, details: unknown, now = Date.now()) {
  return db.prepare('INSERT INTO xero_audit VALUES(?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), actor.id, actor.email, action, entity, JSON.stringify(details), now);
}
function config(env: XeroEnv): string {
  enabled(env);
  if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET || !env.XERO_REDIRECT_URI || !env.XERO_TOKEN_KEY)
    throw new XeroProblem('CONFIGURATION', 'Configure the Xero client ID, client secret, exact callback URL and encryption key in Cloudflare.', 503);
  let redirect: URL;
  try { redirect = new URL(env.XERO_REDIRECT_URI); } catch { throw new XeroProblem('CONFIGURATION', 'Invalid Xero callback URL.', 503); }
  if (redirect.protocol !== 'https:' || redirect.pathname !== '/api/projects/oauth/callback' || redirect.search || redirect.hash || redirect.username || redirect.password)
    throw new XeroProblem('CONFIGURATION', 'Use the HTTPS app URL followed by /api/projects/oauth/callback.', 503);
  return redirect.href;
}
async function exchange(env: XeroEnv, data: URLSearchParams, fetcher: typeof fetch): Promise<Tokens & { expires_in: number; scope: string }> {
  const response = await fetcher(TOKEN_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Basic ${base64(new TextEncoder().encode(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`))}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: data.toString() });
  if (!response.ok) throw new XeroProblem('RECONNECT', `Xero authorisation failed (HTTP ${response.status}). Reconnect or check app permissions.`, 503);
  const result = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string' || !Number.isFinite(result.expires_in) || Number(result.expires_in) <= 0)
    throw new XeroProblem('TOKEN_RESPONSE', 'Xero returned an incomplete authorisation response.', 503);
  return { access_token: result.access_token, refresh_token: result.refresh_token, expires_in: Number(result.expires_in), scope: typeof result.scope === 'string' ? result.scope : '' };
}
export async function beginConnection(env: XeroEnv, actor: Actor, requestOrigin: string, now = Date.now()) {
  requireAdmin(actor); const redirect = config(env);
  if (new URL(redirect).origin !== requestOrigin) throw new XeroProblem('CONFIGURATION', 'The callback must use this app origin.', 503);
  const state = randomSecret(), verifier = randomSecret(), hash = await sha256(state);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM xero_oauth_states WHERE expires_at<?').bind(now),
    env.DB.prepare('INSERT INTO xero_oauth_states VALUES(?,?,?,?,NULL,?)').bind(hash, actor.id, await encrypt(verifier, env.XERO_TOKEN_KEY, `oauth:${hash}`), now + 600_000, now),
    audit(env.DB, actor, 'oauth_started', 'connection', {}, now),
  ]);
  const url = new URL('https://login.xero.com/identity/connect/authorize');
  url.search = new URLSearchParams({ response_type: 'code', client_id: env.XERO_CLIENT_ID!, redirect_uri: redirect, scope: XERO_SCOPES, state, code_challenge: await challenge(verifier), code_challenge_method: 'S256' }).toString();
  return { authorisationUrl: url.href };
}
export async function finishConnection(env: XeroEnv, actor: Actor, url: URL, fetcher: typeof fetch = fetch, now = Date.now()) {
  requireAdmin(actor); const redirect = config(env);
  if (url.origin !== new URL(redirect).origin) throw new XeroProblem('OAUTH_STATE', 'Invalid callback origin.');
  const state = url.searchParams.get('state');
  if (!state || state.length > 200) throw new XeroProblem('OAUTH_STATE', 'The connection request is missing or expired. Start again.');
  const hash = await sha256(state);
  const row = await env.DB.prepare(`UPDATE xero_oauth_states SET consumed_at=? WHERE state_hash=? AND actor_id=? AND consumed_at IS NULL AND expires_at>? RETURNING encrypted_verifier`)
    .bind(now, hash, actor.id, now).first<{ encrypted_verifier: string }>();
  if (!row) throw new XeroProblem('OAUTH_STATE', 'The request expired, was already used, or belongs to another administrator.');
  if (url.searchParams.has('error')) throw new XeroProblem('CONSENT_DECLINED', 'Xero authorisation was not completed.');
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) throw new XeroProblem('OAUTH_CODE', 'Xero did not return an authorisation code.');
  const verifier = await decrypt<string>(row.encrypted_verifier, env.XERO_TOKEN_KEY, `oauth:${hash}`);
  const tokens = await exchange(env, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }), fetcher);
  const scopes = new Set(tokens.scope.split(' '));
  if (tokens.scope && (!scopes.has('projects') || !scopes.has('accounting.contacts.read')))
    throw new XeroProblem('MISSING_SCOPE', 'Reconnect with Projects and read-only Contacts permissions.', 503);
  const response = await fetcher('https://api.xero.com/connections', { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } });
  if (!response.ok) throw new XeroProblem('CONNECTIONS', 'Unable to read the authorised Xero organisations.', 503);
  const raw = await response.json();
  if (!Array.isArray(raw)) throw new XeroProblem('CONNECTIONS', 'Invalid organisation list.', 503);
  const choices: ConnectionChoice[] = raw.filter((v: ConnectionChoice) => v.tenantType?.toUpperCase() === 'ORGANISATION')
    .map((v: ConnectionChoice) => ({ id: requireId(v.id), tenantId: requireId(v.tenantId), tenantName: String(v.tenantName).slice(0, 240), tenantType: 'ORGANISATION' }));
  if (!choices.length) throw new XeroProblem('CONNECTIONS', 'No accounting organisation was authorised.', 503);
  const encrypted = await encrypt({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }, env.XERO_TOKEN_KEY, TOKEN_CONTEXT);
  await env.DB.batch([
    env.DB.prepare(`UPDATE xero_connection SET encrypted_tokens=?,expires_at=?,pending_connections=?,pending_actor=?,connected=0,paused=1,refresh_lease=NULL,refresh_lease_until=0,revision=revision+1 WHERE id=1`)
      .bind(encrypted, now + tokens.expires_in * 1000, JSON.stringify(choices), actor.id),
    audit(env.DB, actor, 'oauth_authorised_pending_selection', 'connection', { organisationCount: choices.length }, now),
  ]);
}
export async function selectOrganisation(env: XeroEnv, actor: Actor, tenantId: string, confirmation: string, now = Date.now()) {
  enabled(env); requireAdmin(actor); requireId(tenantId);
  const c = await connection(env.DB);
  if (!c || !c.pending_connections || c.pending_actor !== actor.id || !c.encrypted_tokens)
    throw new XeroProblem('CONNECTIONS', 'This administrator must complete the Xero connection first.', 409);
  const selected = (JSON.parse(c.pending_connections) as ConnectionChoice[]).find(v => v.tenantId === tenantId);
  if (!selected || confirmation !== selected.tenantName) throw new XeroProblem('CONFIRM_ORGANISATION', 'Type the exact selected organisation name.');
  const used = await env.DB.prepare('SELECT entry_id FROM xero_entry_details LIMIT 1').first();
  if (used && c.tenant_id && c.tenant_id !== tenantId) throw new XeroProblem('TENANT_CHANGE', 'Records already belong to another Xero organisation. A separate migration is required.', 409);
  await env.DB.batch([
    env.DB.prepare(`UPDATE xero_transaction_guard SET asserted=CASE WHEN EXISTS(SELECT 1 FROM xero_connection WHERE id=1 AND revision=? AND pending_actor=?) THEN 1 ELSE 0 END WHERE id=1`).bind(c.revision, actor.id),
    env.DB.prepare(`UPDATE xero_connection SET tenant_id=?,tenant_name=?,connection_id=?,connected=1,paused=1,pending_connections=NULL,pending_actor=NULL,revision=revision+1 WHERE id=1`).bind(selected.tenantId, selected.tenantName, selected.id),
    audit(env.DB, actor, 'organisation_selected_uploads_paused', selected.tenantId, { name: selected.tenantName }, now),
  ]);
  return { tenantId: selected.tenantId, tenantName: selected.tenantName, paused: true };
}
export async function accessToken(env: XeroEnv, fetcher: typeof fetch = fetch, now = Date.now()): Promise<{ token: string; tenantId: string; revision: number }> {
  config(env); const c = await connection(env.DB);
  if (!c?.connected || !c.tenant_id || !c.encrypted_tokens) throw new XeroProblem('RECONNECT', 'Connect and confirm the practice Xero organisation.', 503);
  const tokens = await decrypt<Tokens>(c.encrypted_tokens, env.XERO_TOKEN_KEY, TOKEN_CONTEXT);
  if (c.expires_at > now + 60_000) return { token: tokens.access_token, tenantId: c.tenant_id, revision: c.revision };
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE xero_connection SET refresh_lease=?,refresh_lease_until=? WHERE id=1 AND revision=? AND refresh_lease_until<=? RETURNING id`).bind(lease, now + 60_000, c.revision, now).first();
  if (!claimed) throw new XeroProblem('REFRESH_BUSY', 'Another request is refreshing Xero. Retry shortly.', 503, 30);
  try {
    const refreshed = await exchange(env, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }), fetcher);
    const encrypted = await encrypt({ access_token: refreshed.access_token, refresh_token: refreshed.refresh_token }, env.XERO_TOKEN_KEY, TOKEN_CONTEXT);
    const saved = await env.DB.prepare(`UPDATE xero_connection SET encrypted_tokens=?,expires_at=?,refresh_lease=NULL,refresh_lease_until=0 WHERE id=1 AND refresh_lease=? AND revision=? RETURNING id`).bind(encrypted, now + refreshed.expires_in * 1000, lease, c.revision).first();
    if (!saved) throw new XeroProblem('CONNECTION_CHANGED', 'The Xero connection changed while refreshing. Retry.', 503, 30);
    return { token: refreshed.access_token, tenantId: c.tenant_id, revision: c.revision };
  } finally { await env.DB.prepare('UPDATE xero_connection SET refresh_lease=NULL,refresh_lease_until=0 WHERE id=1 AND refresh_lease=?').bind(lease).run(); }
}
export async function saveControls(env: XeroEnv, actor: Actor, input: { cutoverAt: number; paused: boolean }, now = Date.now()) {
  enabled(env); requireAdmin(actor);
  if (!Number.isSafeInteger(input.cutoverAt) || input.cutoverAt < 0 || typeof input.paused !== 'boolean') throw new XeroProblem('CONTROLS', 'Choose a valid cutover date and pause setting.');
  const c = await connection(env.DB);
  if (!c?.connected) throw new XeroProblem('RECONNECT', 'Confirm a Xero organisation first.', 409);
  if (await env.DB.prepare('SELECT id FROM xero_approvals LIMIT 1').first() && c.cutover_at !== input.cutoverAt)
    throw new XeroProblem('CUTOVER_FROZEN', 'The cutover date is frozen after approval records exist.', 409);
  await env.DB.batch([
    env.DB.prepare('UPDATE xero_connection SET cutover_at=?,paused=?,revision=revision+1 WHERE id=1').bind(input.cutoverAt, Number(input.paused)),
    audit(env.DB, actor, 'upload_controls', 'connection', input, now),
  ]);
}
