import { randomUUID } from 'node:crypto';
import type { DeliveryClaim, DeliveryType, Project, TimeEntry, TimeStore } from '../server/types';

export class MemoryTimeStore implements TimeStore {
  projects: Project[] = [];
  entries: TimeEntry[] = [];
  deliveries = new Map<string, { status: 'sending' | 'sent' | 'failed'; attempts: number }>();

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

  async getActiveEntry(): Promise<TimeEntry | null> {
    return this.entries.find((entry) => !entry.endAt) ?? null;
  }

  async clockIn(projectName: string, notes: string, now: Date): Promise<TimeEntry> {
    if (await this.getActiveEntry()) throw new Error('ACTIVE_TIMER_EXISTS');
    const project = await this.getOrCreateProject(projectName);
    const entry: TimeEntry = {
      id: randomUUID(),
      projectId: project.id,
      projectName: project.name,
      notes,
      startAt: now.toISOString(),
      endAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  async clockOut(now: Date): Promise<TimeEntry | null> {
    const active = await this.getActiveEntry();
    if (!active || now <= new Date(active.startAt)) return null;
    active.endAt = now.toISOString();
    active.updatedAt = now.toISOString();
    return active;
  }

  async createEntry(input: {
    projectName: string;
    notes: string;
    startAt: Date;
    endAt: Date;
  }): Promise<TimeEntry> {
    const project = await this.getOrCreateProject(input.projectName);
    const entry: TimeEntry = {
      id: randomUUID(),
      projectId: project.id,
      projectName: project.name,
      notes: input.notes,
      startAt: input.startAt.toISOString(),
      endAt: input.endAt.toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  async updateEntry(
    id: string,
    input: { projectName: string; notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry | null> {
    const entry = this.entries.find((candidate) => candidate.id === id && candidate.endAt);
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

  async deleteEntry(id: string): Promise<boolean> {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  async listEntries(input: { from: Date; to: Date; projectId?: string }): Promise<TimeEntry[]> {
    return this.entries
      .filter(
        (entry) =>
          Date.parse(entry.startAt) < input.to.getTime() &&
          Date.parse(entry.endAt ?? new Date().toISOString()) > input.from.getTime(),
      )
      .filter((entry) => !input.projectId || entry.projectId === input.projectId)
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
    const delivery = this.deliveries.get(`${weekStart}:${type}`)!;
    delivery.status = 'sent';
  }

  async markDeliveryFailed(weekStart: string, type: DeliveryType): Promise<void> {
    const delivery = this.deliveries.get(`${weekStart}:${type}`)!;
    delivery.status = 'failed';
  }
}
