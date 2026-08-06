import { randomUUID } from 'node:crypto';
import type {
  DeliveryClaim,
  DeliveryType,
  Project,
  TimeEntry,
  TimeStore,
  User,
  UserRole,
} from '../server/types';

export class MemoryTimeStore implements TimeStore {
  users: User[] = [];
  projects: Project[] = [];
  entries: TimeEntry[] = [];
  deliveries = new Map<string, { status: 'sending' | 'sent' | 'failed'; attempts: number }>();

  async upsertUser(input: {
    accessSubject: string;
    entraObjectId?: string;
    email: string;
    displayName: string;
    role: UserRole;
  }): Promise<User> {
    const now = new Date().toISOString();
    let user = this.users.find(
      (candidate) =>
        candidate.accessSubject === input.accessSubject ||
        candidate.email.toLowerCase() === input.email.toLowerCase() ||
        Boolean(input.entraObjectId && candidate.entraObjectId === input.entraObjectId),
    );
    if (!user) {
      user = {
        id: randomUUID(),
        accessSubject: input.accessSubject,
        entraObjectId: input.entraObjectId ?? null,
        email: input.email.toLowerCase(),
        displayName: input.displayName,
        role: input.role,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      };
      this.users.push(user);
    } else {
      Object.assign(user, {
        accessSubject: input.accessSubject,
        entraObjectId: input.entraObjectId ?? user.entraObjectId,
        email: input.email.toLowerCase(),
        displayName: input.displayName,
        role: input.role,
        updatedAt: now,
        lastSeenAt: now,
      });
    }
    return user;
  }

  async listUsers(): Promise<User[]> {
    return [...this.users].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getOrCreateProject(name: string): Promise<Project> {
    const existing = this.projects.find(
      (project) => project.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (existing) return existing;
    const project = { id: randomUUID(), name: name.trim(), createdAt: new Date().toISOString() };
    this.projects.push(project);
    return project;
  }

  async getActiveEntry(userId: string): Promise<TimeEntry | null> {
    return this.entries.find((entry) => entry.userId === userId && !entry.endAt) ?? null;
  }

  async clockIn(userId: string, projectName: string, notes: string, now: Date): Promise<TimeEntry> {
    if (await this.getActiveEntry(userId)) throw new Error('ACTIVE_TIMER_EXISTS');
    const project = await this.getOrCreateProject(projectName);
    const entry = this.makeEntry(userId, project, notes, now, null);
    this.entries.push(entry);
    return entry;
  }

  async clockOut(userId: string, now: Date): Promise<TimeEntry | null> {
    const active = await this.getActiveEntry(userId);
    if (!active || now <= new Date(active.startAt)) return null;
    active.endAt = now.toISOString();
    active.updatedAt = now.toISOString();
    return active;
  }

  async createEntry(
    userId: string,
    input: { projectName: string; notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry> {
    const project = await this.getOrCreateProject(input.projectName);
    const entry = this.makeEntry(userId, project, input.notes, input.startAt, input.endAt);
    this.entries.push(entry);
    return entry;
  }

  async updateEntry(
    userId: string,
    id: string,
    input: { projectName: string; notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry | null> {
    const entry = this.entries.find(
      (candidate) => candidate.id === id && candidate.userId === userId && candidate.endAt,
    );
    if (!entry) return null;
    const project = await this.getOrCreateProject(input.projectName);
    Object.assign(entry, {
      projectId: project.id,
      projectName: project.name,
      notes: input.notes,
      startAt: input.startAt.toISOString(),
      endAt: input.endAt.toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return entry;
  }

  async deleteEntry(userId: string, id: string): Promise<boolean> {
    const index = this.entries.findIndex((entry) => entry.id === id && entry.userId === userId);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  async listEntries(input: {
    from: Date;
    to: Date;
    projectId?: string;
    userId?: string;
  }): Promise<TimeEntry[]> {
    return this.entries
      .filter(
        (entry) =>
          Date.parse(entry.startAt) < input.to.getTime() &&
          Date.parse(entry.endAt ?? new Date().toISOString()) > input.from.getTime(),
      )
      .filter((entry) => !input.projectId || entry.projectId === input.projectId)
      .filter((entry) => !input.userId || entry.userId === input.userId)
      .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt));
  }

  async claimDelivery(weekStart: string, type: DeliveryType): Promise<DeliveryClaim> {
    const key = `${weekStart}:${type}`;
    const existing = this.deliveries.get(key);
    if (existing?.status === 'sent') return { shouldSend: false, reason: 'already-sent' };
    if (existing?.status === 'sending') return { shouldSend: false, reason: 'already-sending' };
    this.deliveries.set(key, { status: 'sending', attempts: (existing?.attempts ?? 0) + 1 });
    return { shouldSend: true };
  }

  async markDeliverySent(weekStart: string, type: DeliveryType): Promise<void> {
    this.deliveries.get(`${weekStart}:${type}`)!.status = 'sent';
  }

  async markDeliveryFailed(weekStart: string, type: DeliveryType): Promise<void> {
    this.deliveries.get(`${weekStart}:${type}`)!.status = 'failed';
  }

  private makeEntry(
    userId: string,
    project: Project,
    notes: string,
    startAt: Date,
    endAt: Date | null,
  ): TimeEntry {
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user) throw new Error('Unknown test user');
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      userId,
      userEmail: user.email,
      userDisplayName: user.displayName,
      projectId: project.id,
      projectName: project.name,
      notes,
      startAt: startAt.toISOString(),
      endAt: endAt?.toISOString() ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }
}
