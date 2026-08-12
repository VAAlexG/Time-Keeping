export type WorkType = 'client' | 'internal' | 'legacy';
export interface Client {
  id: string;
  externalId: string;
  source: 'fyi' | 'csv';
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
  source: 'fyi' | 'csv';
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
  startAt: string;
  endAt: string | null;
  durationMs?: number;
}
export interface SignedInUser {
  id: string;
  email: string;
  displayName: string;
  role: 'employee' | 'admin';
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
  source: 'fyi' | 'csv';
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
export type WorkPayload =
  | { workType: 'client'; clientId: string; jobId?: string; billable: boolean; notes: string }
  | { workType: 'internal'; internalActivityId: string; billable: false; notes: string };
