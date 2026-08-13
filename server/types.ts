export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export type UserRole = 'employee' | 'admin';
export type WorkType = 'client' | 'internal' | 'legacy';
export type PriorityAssignee = 'alex' | 'brendon' | 'suzie';

export interface PriorityItem {
  id: string;
  title: string;
  assignee: PriorityAssignee;
  priority: number;
  completed: boolean;
  createdByUserId: string;
  createdByName: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  accessSubject: string;
  entraObjectId: string | null;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

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

export type WorkClassificationInput =
  | { workType: 'client'; clientId: string; jobId?: string; billable: boolean }
  | { workType: 'internal'; internalActivityId: string; billable?: false };

export interface TimeEntry {
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
  createdAt: string;
  updatedAt: string;
}

export interface EntryFilters {
  from: Date;
  to: Date;
  userId?: string;
  clientId?: string;
  jobId?: string;
  internalActivityId?: string;
  workType?: WorkType;
  billable?: boolean;
}

export type DeliveryType = 'scheduled' | 'test';
export interface DeliveryClaim {
  shouldSend: boolean;
  reason?: 'already-sent' | 'already-sending';
}

export interface TimeStore {
  upsertUser(input: {
    accessSubject: string;
    entraObjectId?: string;
    email: string;
    displayName: string;
    role: UserRole;
  }): Promise<User>;
  listUsers(): Promise<User[]>;
  listProjects(): Promise<Project[]>;
  getOrCreateProject(name: string): Promise<Project>;
  getActiveEntry(userId: string): Promise<TimeEntry | null>;
  clockIn(
    userId: string,
    classification: WorkClassificationInput,
    notes: string,
    now: Date,
  ): Promise<TimeEntry>;
  clockOut(userId: string, now: Date): Promise<TimeEntry | null>;
  createEntry(
    userId: string,
    input: WorkClassificationInput & { notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry>;
  updateEntry(
    userId: string,
    id: string,
    input: WorkClassificationInput & { notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry | null>;
  deleteEntry(userId: string, id: string): Promise<boolean>;
  listEntries(input: EntryFilters): Promise<TimeEntry[]>;
  claimDelivery(weekStart: string, type: DeliveryType, recipient: string): Promise<DeliveryClaim>;
  markDeliverySent(
    weekStart: string,
    type: DeliveryType,
    sentAt: Date,
    providerMessageId?: string,
  ): Promise<void>;
  markDeliveryFailed(weekStart: string, type: DeliveryType, error: string): Promise<void>;
}

export interface SyncCounts {
  clientsCreated: number;
  clientsUpdated: number;
  clientsArchived: number;
  jobsCreated: number;
  jobsUpdated: number;
  jobsArchived: number;
}

export interface SyncRun extends SyncCounts {
  id: string;
  source: 'fyi' | 'csv';
  triggerType: 'scheduled' | 'manual' | 'import';
  status: 'running' | 'succeeded' | 'failed';
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}
