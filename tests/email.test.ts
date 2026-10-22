import { describe, expect, it, vi } from 'vitest';
import { createResendSender, sendWeeklyReport, type MailSender } from '../server/email';
import { MemoryTimeStore } from './memory-store';

describe('weekly email idempotency', () => {
  it('refuses redirects when sending the Resend API key', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ id: 'email-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await createResendSender('test-key', fetcher).send({
      from: 'reports@example.com',
      to: 'recipient@example.com',
      subject: 'Report',
      text: 'Attached',
      filename: 'report.xlsx',
      content: new Uint8Array([1, 2, 3]),
      idempotencyKey: 'weekly-report-1',
    });
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('sends a scheduled report once and keeps test delivery separate', async () => {
    const store = new MemoryTimeStore();
    const send = vi.fn<MailSender['send']>(async () => undefined);
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

  it('allows one scheduled current-week report on each Brisbane date', async () => {
    const store = new MemoryTimeStore();
    const send = vi.fn<MailSender['send']>(async () => undefined);
    const base = {
      store,
      mailer: { send },
      from: 'reports@example.com',
      recipient: 'recipient@example.com',
      weekStart: '2026-08-15',
      type: 'scheduled' as const,
    };
    expect(
      (await sendWeeklyReport({ ...base, now: new Date('2026-08-18T07:00:00.000Z') })).sent,
    ).toBe(true);
    expect(
      (await sendWeeklyReport({ ...base, now: new Date('2026-08-19T07:00:00.000Z') })).sent,
    ).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].idempotencyKey).toContain('2026-08-18');
    expect(send.mock.calls[1][0].idempotencyKey).toContain('2026-08-19');
  });
});
