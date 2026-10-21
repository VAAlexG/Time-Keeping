/** Runtime-independent contracts. Production uses Cloudflare D1 and Web Crypto. */
export interface XeroEnv {
  DB: D1Database;
  XERO_ENABLED?: string;
  XERO_CLIENT_ID?: string;
  XERO_CLIENT_SECRET?: string;
  XERO_REDIRECT_URI?: string;
  XERO_TOKEN_KEY?: string;
  XERO_REVIEWER_EMAILS?: string;
  ALLOWED_EMAIL_DOMAIN: string;
  WEEKLY_REPORT_RECIPIENTS?: string;
}
export interface Actor { id: string; email: string; displayName: string; role: string; }
export interface Amount { currency: string; value: number; }
export interface XProject {
  projectId: string; contactId: string; name: string; status: 'INPROGRESS' | 'CLOSED';
  totalInvoiced?: Amount; totalToBeInvoiced?: Amount; totalTaskAmount?: Amount;
}
export interface XTask {
  taskId: string; projectId: string; name: string;
  chargeType: 'TIME' | 'FIXED' | 'NON_CHARGEABLE'; rate: Amount;
  status: 'ACTIVE' | 'LOCKED' | 'INVOICED';
}
export interface XUser { userId: string; name: string; email: string; }
export interface XTime {
  timeEntryId: string; projectId: string; userId: string; taskId: string;
  dateUtc: string; duration: number; description?: string | null;
  status: 'ACTIVE' | 'LOCKED' | 'INVOICED';
}
export interface TimePayload { userId: string; taskId: string; dateUtc: string; duration: number; description: string; }
export interface Connection {
  id: number; tenant_id: string | null; tenant_name: string | null;
  connection_id: string | null; encrypted_tokens: string | null; expires_at: number;
  pending_connections: string | null; pending_actor: string | null;
  connected: number; refresh_lease: string | null; refresh_lease_until: number;
  revision: number; cutover_at: number | null; paused: number; throttle_until: number;
}
export interface Tokens { access_token: string; refresh_token: string; }
export interface ConnectionChoice { id: string; tenantId: string; tenantName: string; tenantType: string; }
export interface EntryDetails {
  entry_id: string; tenant_id: string; project_id: string; task_id: string;
  client_description: string; internal_note: string; revision: number;
  project_name: string; task_name: string; created_at: number; updated_at: number;
}
export interface UploadRow {
  id: string; approval_id: string; tenant_id: string; project_id: string;
  entry_id: string; payload_json: string; payload_hash: string; idempotency_key: string;
  state: string; attempts: number; next_attempt_at: number; lease_token: string | null;
  lease_until: number; remote_time_id: string | null; remote_status: string | null;
  last_checked_at: number | null; last_error: string | null; drift: string | null;
  write_started_at: number | null; last_poll_attempt_at: number;
  created_at: number; updated_at: number;
}
export interface EntryInput {
  clientId: string; projectId: string; taskId: string;
  startLocal?: string; durationMinutes?: number;
  clientDescription: string; internalNote: string;
  entryId?: string; expectedUpdatedAt?: number; expectedRevision?: number;
  reason?: string;
}
export class XeroProblem extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400,
    public readonly retryAfterSeconds = 0) { super(message); this.name = 'XeroProblem'; }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requireId(value: unknown, label = 'identifier'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new XeroProblem('INVALID_ID', `Invalid ${label}.`);
  return value.toLowerCase();
}
export function text(value: unknown, label: string, max = 2000, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new XeroProblem('INVALID_TEXT', `Check ${label} (maximum ${max} characters).`);
  return value.trim();
}
export function isReviewer(actor: Actor, env: XeroEnv): boolean {
  return actor.role === 'admin' || (env.XERO_REVIEWER_EMAILS ?? '').split(',')
    .map(v => v.trim().toLowerCase()).includes(actor.email.toLowerCase());
}
export function requireReviewer(actor: Actor, env: XeroEnv) {
  if (!isReviewer(actor, env)) throw new XeroProblem('FORBIDDEN', 'Billing reviewer access is required.', 403);
}
export function requireAdmin(actor: Actor) {
  if (actor.role !== 'admin') throw new XeroProblem('FORBIDDEN', 'Administrator access is required.', 403);
}
export function enabled(env: XeroEnv) {
  if (env.XERO_ENABLED !== 'true') throw new XeroProblem('DISABLED', 'Xero Projects is not enabled for this deployment.', 503);
}
