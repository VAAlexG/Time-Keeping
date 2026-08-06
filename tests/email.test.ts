import { describe, expect, it, vi } from 'vitest';
import { sendWeeklyReport, type MailSender } from '../server/email';
import { MemoryTimeStore } from './memory-store';

describe('weekly email idempotency', () => {
  it('sends a scheduled report once and keeps test delivery separate', async () => {
    const store = new MemoryTimeStore();
    const send = vi.fn(async () => undefined);
    const mailer: MailSender = { send };
    const base = {
      store,
      mailer,
      from: 'reports@example.com',
      recipient: 'recipient@example.com',
      weekStart: '2026-08-03',
      now: new Date('2026-08-10T00:05:00.000Z'),
    };
    expect((await sendWeeklyReport({ ...base, type: 'scheduled' })).sent).toBe(true);
    expect((await sendWeeklyReport({ ...base, type: 'scheduled' })).reason).toBe('already-sent');
    expect((await sendWeeklyReport({ ...base, type: 'test' })).sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('records a failure and permits a later retry', async () => {
    const store = new MemoryTimeStore();
    const mailer: MailSender = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('SMTP unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    const input = {
      store,
      mailer,
      from: 'reports@example.com',
      recipient: 'recipient@example.com',
      weekStart: '2026-08-03',
      type: 'scheduled' as const,
    };
    await expect(sendWeeklyReport(input)).rejects.toThrow('SMTP unavailable');
    expect((await sendWeeklyReport(input)).sent).toBe(true);
  });
});
