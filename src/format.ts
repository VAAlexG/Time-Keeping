export const BRISBANE_ZONE = 'Australia/Brisbane';

export function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.round(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: BRISBANE_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatDate(isoOrDate: string): string {
  const date = isoOrDate.includes('T')
    ? new Date(isoOrDate)
    : new Date(`${isoOrDate}T00:00:00+10:00`);
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: BRISBANE_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function localDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BRISBANE_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

export function toBrisbaneLocalInput(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRISBANE_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function todayBrisbane(): string {
  return localDate(new Date().toISOString());
}
