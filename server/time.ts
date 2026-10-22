import { DateTime, Interval } from 'luxon';
import type { TimeEntry } from './types';

export const BRISBANE_ZONE = 'Australia/Brisbane';

export function brisbaneNow(now = new Date()): DateTime {
  return DateTime.fromJSDate(now, { zone: 'utc' }).setZone(BRISBANE_ZONE);
}

export function parseLocalDate(value: string): DateTime {
  const parsed = DateTime.fromISO(value, { zone: BRISBANE_ZONE });
  if (!parsed.isValid || parsed.toFormat('yyyy-MM-dd') !== value) {
    throw new Error('Invalid Brisbane date');
  }
  return parsed.startOf('day');
}

export function parseLocalDateTime(value: string): Date {
  const parsed = DateTime.fromISO(value, { zone: BRISBANE_ZONE });
  if (!parsed.isValid) throw new Error('Invalid Brisbane date and time');
  return parsed.toUTC().toJSDate();
}

export function toLocalInput(isoUtc: string): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' })
    .setZone(BRISBANE_ZONE)
    .toFormat("yyyy-MM-dd'T'HH:mm");
}

export function getDayRange(date: string): { from: Date; to: Date } {
  const start = parseLocalDate(date);
  return { from: start.toUTC().toJSDate(), to: start.plus({ days: 1 }).toUTC().toJSDate() };
}

export function getWeekStart(value?: string, now = new Date()): DateTime {
  const date = value ? parseLocalDate(value) : brisbaneNow(now).startOf('day');
  return date.startOf('week');
}

export function getWeekRange(
  weekStart?: string,
  now = new Date(),
): {
  weekStart: string;
  weekEnd: string;
  from: Date;
  to: Date;
} {
  const start = getWeekStart(weekStart, now);
  const end = start.plus({ days: 7 });
  return {
    weekStart: start.toISODate()!,
    weekEnd: end.minus({ days: 1 }).toISODate()!,
    from: start.toUTC().toJSDate(),
    to: end.toUTC().toJSDate(),
  };
}

export function previousWeekStart(now = new Date()): string {
  return getWeekStart(undefined, now).minus({ weeks: 1 }).toISODate()!;
}

/** Friday 20:00 Australia/Brisbane on or before the supplied instant. */
export function latestFridayCutoff(now = new Date()): Date {
  const local = brisbaneNow(now);
  let cutoff = local.startOf('day').set({ weekday: 5, hour: 20 });
  if (cutoff > local) cutoff = cutoff.minus({ weeks: 1 });
  return cutoff.toUTC().toJSDate();
}

/** The ordinary close interval is half-open: [previous Friday 20:00, cutoff). */
export function fridayCloseRange(cutoff = latestFridayCutoff()): {
  from: Date;
  to: Date;
  label: string;
} {
  const to = DateTime.fromJSDate(cutoff, { zone: 'utc' }).setZone(BRISBANE_ZONE);
  if (to.weekday !== 5 || to.hour !== 20 || to.minute !== 0 || to.second !== 0)
    throw new Error('Friday cutoff must be exactly 20:00 Australia/Brisbane');
  const from = to.minus({ weeks: 1 });
  return {
    from: from.toUTC().toJSDate(),
    to: to.toUTC().toJSDate(),
    label: `${from.toFormat('dd LLL yyyy HH:mm')} – ${to.toFormat('dd LLL yyyy HH:mm')}`,
  };
}

/** Every Friday 20:00 boundary strictly inside an interval. */
export function fridayCutoffsBetween(start: Date, end: Date): Date[] {
  if (!(start < end)) return [];
  const result: Date[] = [];
  let cursor = DateTime.fromJSDate(start, { zone: 'utc' })
    .setZone(BRISBANE_ZONE)
    .startOf('day')
    .set({ weekday: 5, hour: 20 });
  if (cursor.toMillis() <= start.getTime()) cursor = cursor.plus({ weeks: 1 });
  while (cursor.toMillis() < end.getTime()) {
    result.push(cursor.toUTC().toJSDate());
    cursor = cursor.plus({ weeks: 1 });
  }
  return result;
}

export function durationMs(entry: Pick<TimeEntry, 'startAt' | 'endAt'>, now = new Date()): number {
  const start = Date.parse(entry.startAt);
  const end = entry.endAt ? Date.parse(entry.endAt) : now.getTime();
  return Math.max(0, end - start);
}

export function overlapMs(
  entry: Pick<TimeEntry, 'startAt' | 'endAt'>,
  from: Date,
  to: Date,
  now = new Date(),
): number {
  const start = Math.max(Date.parse(entry.startAt), from.getTime());
  const rawEnd = entry.endAt ? Date.parse(entry.endAt) : now.getTime();
  const end = Math.min(rawEnd, to.getTime());
  return Math.max(0, end - start);
}

export interface DailySegment {
  date: string;
  start: DateTime;
  end: DateTime;
  durationMs: number;
  entry: TimeEntry;
}

export function splitEntryByBrisbaneDay(
  entry: TimeEntry,
  rangeFrom: Date,
  rangeTo: Date,
  now = new Date(),
): DailySegment[] {
  const rawStart = DateTime.fromISO(entry.startAt, { zone: 'utc' });
  const rawEnd = DateTime.fromISO(entry.endAt ?? now.toISOString(), { zone: 'utc' });
  const range = Interval.fromDateTimes(
    DateTime.fromJSDate(rangeFrom, { zone: 'utc' }),
    DateTime.fromJSDate(rangeTo, { zone: 'utc' }),
  );
  const entryInterval = Interval.fromDateTimes(rawStart, rawEnd);
  const intersection = entryInterval.intersection(range);
  if (!intersection || intersection.isEmpty()) return [];

  const result: DailySegment[] = [];
  let cursor = intersection.start!.setZone(BRISBANE_ZONE);
  const final = intersection.end!.setZone(BRISBANE_ZONE);
  while (cursor < final) {
    const dayEnd = cursor.startOf('day').plus({ days: 1 });
    const segmentEnd = dayEnd < final ? dayEnd : final;
    result.push({
      date: cursor.toISODate()!,
      start: cursor,
      end: segmentEnd,
      durationMs: segmentEnd.toMillis() - cursor.toMillis(),
      entry,
    });
    cursor = segmentEnd;
  }
  return result;
}

export function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.round(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
}
