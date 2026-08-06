export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export type UserRole = 'employee' | 'admin';

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

export interface TimeEntry {
  id: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  projectId: string;
  projectName: string;
  notes: string;
  startAt: string;
  endAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  clockIn(userId: string, projectName: string, notes: string, now: Date): Promise<TimeEntry>;
  clockOut(userId: string, now: Date): Promise<TimeEntry | null>;
  createEntry(
    userId: string,
    input: {
      projectName: string;
      notes: string;
      startAt: Date;
      endAt: Date;
    },
  ): Promise<TimeEntry>;
  updateEntry(
    userId: string,
    id: string,
    input: { projectName: string; notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry | null>;
  deleteEntry(userId: string, id: string): Promise<boolean>;
  listEntries(input: {
    from: Date;
    to: Date;
    projectId?: string;
    userId?: string;
  }): Promise<TimeEntry[]>;
  claimDelivery(weekStart: string, type: DeliveryType, recipient: string): Promise<DeliveryClaim>;
  markDeliverySent(
    weekStart: string,
    type: DeliveryType,
    sentAt: Date,
    providerMessageId?: string,
  ): Promise<void>;
  markDeliveryFailed(weekStart: string, type: DeliveryType, error: string): Promise<void>;
}
