export type WorkType = 'client' | 'internal' | 'legacy';
export type PriorityAssignee = 'alex' | 'brendon' | 'suzie';
export type ScheduleRecurrence = 'weekly' | 'fortnightly' | 'monthly' | 'yearly';
export interface ScheduleTemplate {
  id: string;
  title: string;
  description: string;
  assignee: PriorityAssignee;
  recurrenceType: ScheduleRecurrence;
  weekdays: number[];
  startDate: string;
  monthlyDay: number | null;
  yearlyMonth: number | null;
  yearlyDay: number | null;
  dueTime: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ScheduleOccurrence {
  id: string;
  templateId: string;
  dueDate: string;
  dueAt: string;
  dueTime: string | null;
  title: string;
  description: string;
  assignee: PriorityAssignee;
  recurrenceLabel: string;
  completed: boolean;
  cancelled: boolean;
  overdue: boolean;
  completedByUserId: string | null;
  completedByName: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface PriorityItem {
  id: string;
  title: string;
  description: string;
  assignee: PriorityAssignee;
  priority: number;
  completed: boolean;
  createdByUserId: string;
  createdByName: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Client {
  id: string;
  externalId: string;
  source: 'fyi' | 'xero' | 'csv';
  name: string;
  clientCode: string | null;
  exportCode: string | null;
  managerName: string | null;
  partnerName: string | null;
  active: boolean;
  syncedAt: string;
}
export interface Job {
  id: string;
  externalId: string;
  clientId: string;
  source: 'fyi' | 'xero' | 'csv';
  name: string;
  jobCode: string | null;
  status: string | null;
  active: boolean;
  defaultBillable: boolean;
  syncedAt: string;
}
export interface InternalActivity {
  id: string;
  name: string;
  active: boolean;
}
export interface Catalog {
  clients: Client[];
  jobs: Job[];
  internalActivities: InternalActivity[];
}
export type XeroChargeType = 'TIME' | 'FIXED' | 'NON_CHARGEABLE';
export interface XeroProjectOption {
  id: string;
  name: string;
  contactId: string | null;
  contactName: string | null;
  active: boolean;
}
export interface XeroTaskOption {
  id: string;
  projectId: string;
  name: string;
  chargeType: XeroChargeType;
  rate: number | null;
  currencyCode: string | null;
  active: boolean;
}
export interface XeroWorkOptions {
  enabled: boolean;
  connected: boolean;
  complete: boolean;
  refreshedAt: string | null;
  projects: XeroProjectOption[];
  tasks: XeroTaskOption[];
  suggestedProjectId: string | null;
  suggestedTaskId: string | null;
  message: string | null;
}
export interface Entry {
  id: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  projectId: string;
  projectName: string;
  workType: WorkType;
  clientId: string | null;
  clientName: string | null;
  clientExternalId: string | null;
  clientCode: string | null;
  jobId: string | null;
  jobName: string | null;
  jobExternalId: string | null;
  jobCode: string | null;
  internalActivityId: string | null;
  activityName: string | null;
  billable: boolean;
  legacy: boolean;
  notes: string;
  clientDescription?: string;
  internalNote?: string;
  xeroProjectId?: string | null;
  xeroProjectName?: string | null;
  xeroTaskId?: string | null;
  xeroTaskName?: string | null;
  xeroChargeType?: XeroChargeType | null;
  xeroRate?: number | null;
  xeroCurrencyCode?: string | null;
  revision?: number;
  lockedAt?: string | null;
  closePeriodId?: string | null;
  startAt: string;
  endAt: string | null;
  durationMs?: number;
}
export interface SignedInUser {
  id: string;
  email: string;
  displayName: string;
  role: 'employee' | 'admin';
  canViewReports: boolean;
  canManageSchedule: boolean;
  canReviewBilling: boolean;
}
export interface SessionData {
  authenticated: true;
  csrfToken: string;
  user: SignedInUser;
  logoutUrl: string;
}
export interface Totals {
  totalMs: number;
  clientMs: number;
  internalMs: number;
  billableMs: number;
  nonBillableMs: number;
  utilisationPercent: number;
  clientTotals: { name: string; totalMs: number }[];
  jobTotals: { name: string; totalMs: number }[];
}
export interface DashboardData {
  active: Entry | null;
  catalog: Catalog;
  today: Totals & { date: string; entries: Entry[] };
  week: Totals & { start: string; end: string; entries: Entry[] };
}
export interface HistoryData extends Totals {
  entries: Entry[];
}
export interface SyncRun {
  id: string;
  source: 'fyi' | 'xero' | 'csv';
  triggerType: 'scheduled' | 'manual' | 'import';
  status: 'running' | 'succeeded' | 'failed';
  clientsCreated: number;
  clientsUpdated: number;
  clientsArchived: number;
  jobsCreated: number;
  jobsUpdated: number;
  jobsArchived: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}
export interface PracticeData extends Catalog {
  latestSync: SyncRun | null;
  fyiConfigured: boolean;
}
export interface FinalizedReportSummary {
  weekStart: string;
  weekEnd: string;
  finalizedAt: string;
  filename: string;
  totalMs: number;
  entryCount: number;
  emailStatus: 'pending' | 'sending' | 'sent' | 'failed';
  emailRecipients: string[];
  emailSentAt: string | null;
  emailError: string | null;
}
export interface ClosedReportSummary {
  id: string;
  version: number;
  supersedesReportId: string | null;
  snapshotSha256: string;
  entryCount: number;
  totalMs: number;
  correctionReason: string;
  createdAt: string;
  coverageFrom: string;
  cutoffAt: string;
  kind: 'scheduled' | 'manual';
  delivery: {
    queued: number;
    providerAccepted: number;
    failed: number;
    needsAttention: number;
    total: number;
  };
}
export type WorkPayload =
  | {
      workType: 'client';
      clientId: string;
      jobId?: string;
      xeroProjectId?: string;
      xeroTaskId?: string;
      billable: boolean;
      clientDescription: string;
      internalNote: string;
      /** Compatibility mirror for pre-projects entry APIs. Always practice-only. */
      notes: string;
    }
  | {
      workType: 'internal';
      internalActivityId: string;
      billable: false;
      clientDescription: '';
      internalNote: string;
      /** Compatibility mirror for pre-projects entry APIs. Always practice-only. */
      notes: string;
    };

export interface ManualEntryPayload {
  workDate: string;
  startTime: string;
  durationMinutes: number;
  startLocal: string;
  endLocal: string;
  correctionReason?: string;
  expectedRevision?: number;
}

export type ReviewState = 'eligible' | 'blocked' | 'approved' | 'cancelled';
export type XeroSyncState =
  'not_queued' | 'queued' | 'sending' | 'accepted' | 'failed' | 'needs_attention';
export type BillingState = 'not_invoiced' | 'invoiced' | 'unknown' | 'unavailable';
export interface ReviewWarning {
  code: string;
  message: string;
  requiresAcknowledgement: boolean;
}
export interface BillingReviewItem {
  entryId: string;
  entryRevision: number;
  mappingRevision: number;
  previewHash: string;
  approvalId: string | null;
  outboxId: string | null;
  employeeId: string;
  employeeName: string;
  clientName: string;
  contactId: string | null;
  contactName: string | null;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskName: string | null;
  workDate: string;
  startAt: string;
  endAt: string;
  actualDurationSeconds: number;
  uploadDurationMinutes: number;
  clientDescription: string;
  billable: boolean;
  chargeType: XeroChargeType | null;
  rate: number | null;
  currencyCode: string | null;
  lockedAt: string;
  reviewState: ReviewState;
  syncState: XeroSyncState;
  billingState: BillingState;
  remoteStatus: string | null;
  remoteTimeEntryId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  statusCheckedAt: string | null;
  canReturnToReview: boolean;
  discrepancies: string[];
  warnings: ReviewWarning[];
  blockers: string[];
}

export interface BillingReviewData {
  items: BillingReviewItem[];
  counts: Record<ReviewState | XeroSyncState, number>;
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  tenantName: string | null;
  uploadsEnabled: boolean;
  processingPaused: boolean;
  lastStatusRefreshAt: string | null;
}

export interface XeroMappingOption {
  id: string;
  name: string;
  detail: string | null;
  active: boolean;
}
export interface XeroClientMapping {
  localId: string;
  localName: string;
  xeroContactId: string | null;
  xeroContactName: string | null;
  revision: number;
  valid: boolean;
}
export interface XeroWorkMapping {
  localId: string;
  localName: string;
  clientName: string;
  xeroProjectId: string | null;
  xeroProjectName: string | null;
  xeroTaskId: string | null;
  xeroTaskName: string | null;
  revision: number;
  valid: boolean;
}
export interface XeroUserMapping {
  localId: string;
  localName: string;
  localEmail: string;
  xeroUserId: string | null;
  xeroUserName: string | null;
  revision: number;
  valid: boolean;
}
export interface XeroProjectsSetupData {
  configured: boolean;
  enabled: boolean;
  processingPaused: boolean;
  connectionStatus: 'disconnected' | 'select_tenant' | 'connected' | 'error';
  tenantId: string | null;
  tenantName: string | null;
  availableOrganisations: { tenantId: string; tenantName: string }[];
  cutoverDate: string | null;
  catalogue: {
    complete: boolean;
    refreshedAt: string | null;
    error: string | null;
    contacts: number;
    projects: number;
    tasks: number;
    users: number;
  };
  contactOptions: XeroMappingOption[];
  projectOptions: XeroMappingOption[];
  taskOptions: (XeroMappingOption & { projectId: string; chargeType: XeroChargeType })[];
  userOptions: XeroMappingOption[];
  clientMappings: XeroClientMapping[];
  workMappings: XeroWorkMapping[];
  userMappings: XeroUserMapping[];
  lastError: string | null;
}

export interface ClosePreview {
  cutoff: string;
  previewHash: string;
  confirmationPhrase: string;
  periodStart: string;
  periodEnd: string;
  timezone: 'Australia/Brisbane';
  entryCount: number;
  runningTimersToSplit: number;
  completedEntriesToSplit: number;
  recipients: string[];
  warnings: string[];
  activationBaseline: {
    periodStart: string;
    periodEnd: string;
    entryCount: number;
    totalMs: number;
    runningTimersToSplit: number;
    completedEntriesToSplit: number;
    historicalEmailSuppressed: boolean;
  } | null;
}
