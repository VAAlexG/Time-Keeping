/** Runtime-independent contracts. Production uses Cloudflare D1 and Web Crypto. */
export interface XeroEnv {
  DB: D1Database;
  /** The integration is fail-closed unless this value is exactly "true". */
  XERO_ENABLED?: string;
  XERO_CLIENT_ID?: string;
  XERO_CLIENT_SECRET?: string;
  XERO_REDIRECT_URI?: string;
  XERO_TOKEN_KEY?: string;
  XERO_REVIEWER_EMAILS?: string;
  ALLOWED_EMAIL_DOMAIN: string;
  WEEKLY_REPORT_RECIPIENTS?: string;
}

export interface Actor {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export interface Amount {
  currency: string;
  value: number;
}

export interface XProject {
  projectId: string;
  contactId: string;
  name: string;
  status: 'INPROGRESS' | 'CLOSED';
  totalInvoiced?: Amount;
  totalToBeInvoiced?: Amount;
  totalTaskAmount?: Amount;
}

export interface XTask {
  taskId: string;
  projectId: string;
  name: string;
  chargeType: 'TIME' | 'FIXED' | 'NON_CHARGEABLE';
  rate: Amount;
}

export interface XUser {
  userId: string;
  name: string;
  email: string;
}

export interface XTime {
  timeEntryId: string;
  projectId: string;
  userId: string;
  taskId: string;
  dateUtc: string;
  duration: number;
  description?: string | null;
  /** Xero may omit status from a create response; callers must treat that as unknown. */
  status?: 'ACTIVE' | 'LOCKED' | 'INVOICED' | string;
}

/** Exact immutable wire payload accepted by POST /Projects/{projectId}/Time. */
export interface TimePayload {
  userId: string;
  taskId: string;
  dateUtc: string;
  duration: number;
  description: string;
}

export interface Connection {
  id: number;
  tenant_id: string | null;
  tenant_name: string | null;
  connection_id: string | null;
  encrypted_tokens: string | null;
  expires_at: number;
  pending_connections_json: string | null;
  pending_actor_id: string | null;
  connected: number;
  paused: number;
  cutover_at: number | null;
  refresh_lease_token: string | null;
  refresh_lease_until: number;
  catalogue_lease_token: string | null;
  catalogue_lease_until: number;
  throttle_until: number;
  token_revision: number;
  connection_revision: number;
  catalogue_revision: number;
  mapping_revision: number;
  created_at: number;
  updated_at: number;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
}
export interface ConnectionChoice {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantType: string;
}
export type CatalogueKind = 'project' | 'task' | 'user' | 'contact';
export interface CatalogueRecord<T> {
  data: T;
  fetchedAt: number;
  catalogueRevision: number;
}

export type ReviewWarningCode =
  | 'ROUNDING_APPLIED'
  | 'DESCRIPTION_EMPTY'
  | 'CATALOGUE_STALE'
  | 'RATE_CHANGED'
  | 'ZERO_RATE'
  | 'BILLABLE_CHARGE_MISMATCH'
  | 'POSSIBLE_DUPLICATE'
  | 'CUTOVER_EXCLUDED';
export interface ReviewWarning {
  code: ReviewWarningCode;
  entryId: string;
  message: string;
}

export interface ReviewItem {
  entryId: string;
  sourceRevision: number;
  selectionRevision: number;
  clientId: string;
  clientLinkRevision: number;
  contactId: string;
  contactCatalogueRevision: number;
  userId: string;
  userLinkRevision: number;
  projectCatalogueRevision: number;
  taskCatalogueRevision: number;
  userCatalogueRevision: number;
  tenantId: string;
  projectId: string;
  taskId: string;
  xeroUserId: string;
  exactDurationMs: number;
  billable: boolean;
  roundedMinutes: number;
  roundingDeltaSeconds: number;
  clientDescription: string;
  internalNote: string;
  workDate: string;
  sourceSnapshot: Record<string, unknown>;
  mappingSnapshot: Record<string, unknown>;
  mappingRevision: number;
  payload: TimePayload;
  payloadJson: string;
  payloadHash: string;
  idempotencyKey: string;
  warnings: ReviewWarning[];
}

export interface ReviewPreview {
  tenantId: string;
  generatedAt: number;
  previewHash: string;
  ready: boolean;
  items: ReviewItem[];
  warnings: ReviewWarning[];
  blockingIssues: { entryId: string; code: string; message: string }[];
}

export interface UploadRow {
  id: string;
  approval_item_id: string;
  approval_id: string;
  tenant_id: string;
  project_id: string;
  entry_id: string;
  payload_json: string;
  payload_hash: string;
  idempotency_key: string;
  state:
    | 'queued'
    | 'leased'
    | 'retry_wait'
    | 'provider_accepted'
    | 'failed'
    | 'needs_attention'
    | 'cancelled';
  attempts: number;
  first_attempt_at: number | null;
  last_attempt_at: number | null;
  next_attempt_at: number;
  lease_token: string | null;
  lease_until: number;
  remote_time_entry_id: string | null;
  remote_status_raw: string | null;
  billing_label: string | null;
  last_status_checked_at: number | null;
  source_drift: number;
  remote_drift_json: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: number;
  updated_at: number;
}

export class XeroProblem extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryAfterSeconds = 0,
  ) {
    super(message);
    this.name = 'XeroProblem';
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requireId(value: unknown, label = 'identifier'): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new XeroProblem('INVALID_ID', `Invalid ${label}.`);
  return value.toLowerCase();
}
export function text(value: unknown, label: string, max = 2000, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new XeroProblem('INVALID_TEXT', `Check ${label} (maximum ${max} characters).`);
  }
  return value.trim();
}
export function isReviewer(actor: Actor, env: XeroEnv): boolean {
  return (
    actor.role === 'admin' ||
    (env.XERO_REVIEWER_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
      .includes(actor.email.toLowerCase())
  );
}
export function requireReviewer(actor: Actor, env: XeroEnv): void {
  if (!isReviewer(actor, env))
    throw new XeroProblem('FORBIDDEN', 'Billing reviewer access is required.', 403);
}
export function requireAdmin(actor: Actor): void {
  if (actor.role !== 'admin')
    throw new XeroProblem('FORBIDDEN', 'Administrator access is required.', 403);
}
export function enabled(env: XeroEnv): void {
  if (env.XERO_ENABLED !== 'true')
    throw new XeroProblem('DISABLED', 'Xero Projects is not enabled for this deployment.', 503);
}
