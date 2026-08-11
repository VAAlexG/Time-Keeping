import { describe, expect, it } from 'vitest';
import { getWeekRange, overlapMs, splitEntryByBrisbaneDay } from '../server/time';
import type { TimeEntry } from '../server/types';

const entry = (startAt: string, endAt: string): TimeEntry => ({
  id: '1',
  userId: 'u1',
  userEmail: 'alexg@versatileaccounting.com.au',
  userDisplayName: 'Alex',
  projectId: 'p1',
  projectName: 'Accounting',
  workType: 'legacy',
  clientId: null,
  clientName: null,
  clientExternalId: null,
  clientCode: null,
  jobId: null,
  jobName: null,
  jobExternalId: null,
  jobCode: null,
  internalActivityId: null,
  activityName: null,
  billable: false,
  legacy: true,
  notes: '',
  startAt,
  endAt,
  createdAt: startAt,
  updatedAt: endAt,
});

describe('Brisbane time calculations', () => {
  it('finds Monday-to-Sunday boundaries in Brisbane and converts them to UTC', () => {
    const range = getWeekRange('2026-08-06');
    expect(range.weekStart).toBe('2026-08-03');
    expect(range.weekEnd).toBe('2026-08-09');
    expect(range.from.toISOString()).toBe('2026-08-02T14:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-08-09T14:00:00.000Z');
  });

  it('allocates an entry crossing Brisbane midnight to both dates', () => {
    const value = entry('2026-08-04T13:30:00.000Z', '2026-08-04T14:30:00.000Z');
    const segments = splitEntryByBrisbaneDay(
      value,
      new Date('2026-08-03T14:00:00.000Z'),
      new Date('2026-08-10T14:00:00.000Z'),
    );
    expect(segments.map((segment) => [segment.date, segment.durationMs])).toEqual([
      ['2026-08-04', 30 * 60_000],
      ['2026-08-05', 30 * 60_000],
    ]);
  });

  it('clips duration at a reporting boundary without double counting', () => {
    const value = entry('2026-08-02T13:30:00.000Z', '2026-08-02T14:30:00.000Z');
    expect(
      overlapMs(value, new Date('2026-08-02T14:00:00.000Z'), new Date('2026-08-09T14:00:00.000Z')),
    ).toBe(30 * 60_000);
  });
});
