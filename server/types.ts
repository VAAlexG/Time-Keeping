export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export interface TimeEntry {
  id: string;
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
  listProjects(): Promise<Project[]>;
  getOrCreateProject(name: string): Promise<Project>;
  getActiveEntry(): Promise<TimeEntry | null>;
  clockIn(projectName: string, notes: string, now: Date): Promise<TimeEntry>;
  clockOut(now: Date): Promise<TimeEntry | null>;
  createEntry(input: {
    projectName: string;
    notes: string;
    startAt: Date;
    endAt: Date;
  }): Promise<TimeEntry>;
  updateEntry(
    id: string,
    input: { projectName: string; notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry | null>;
  deleteEntry(id: string): Promise<boolean>;
  listEntries(input: { from: Date; to: Date; projectId?: string }): Promise<TimeEntry[]>;
  claimDelivery(weekStart: string, type: DeliveryType, recipient: string): Promise<DeliveryClaim>;
  markDeliverySent(weekStart: string, type: DeliveryType, sentAt: Date): Promise<void>;
  markDeliveryFailed(weekStart: string, type: DeliveryType, error: string): Promise<void>;
}
