import type { DeliveryType, TimeStore } from './types';
import { buildWeeklyWorkbook } from './report';
import { getWeekRange } from './time';

export interface MailSender {
  send(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    filename: string;
    content: Uint8Array;
    idempotencyKey: string;
  }): Promise<string | undefined>;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function createResendSender(apiKey: string, fetcher: typeof fetch = fetch): MailSender {
  if (!apiKey) throw new Error('RESEND_API_KEY is required');
  return {
    async send(input) {
      const response = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          from: input.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          attachments: [{ filename: input.filename, content: toBase64(input.content) }],
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!response.ok)
        throw new Error(
          `Resend delivery failed (${response.status}): ${body.message ?? 'Unknown error'}`,
        );
      return body.id;
    },
  };
}

export async function sendWeeklyReport(input: {
  store: TimeStore;
  mailer: MailSender;
  from: string;
  recipient: string;
  weekStart: string;
  type: DeliveryType;
  now?: Date;
}): Promise<{ sent: boolean; reason?: string; filename?: string }> {
  const claim = await input.store.claimDelivery(input.weekStart, input.type, input.recipient);
  if (!claim.shouldSend) return { sent: false, reason: claim.reason };
  try {
    const current = input.now ?? new Date();
    const report = await buildWeeklyWorkbook(input.store, input.weekStart, current);
    const range = getWeekRange(input.weekStart, current);
    const providerMessageId = await input.mailer.send({
      from: input.from,
      to: input.recipient,
      subject: `${input.type === 'test' ? '[TEST] ' : ''}Time report: ${range.weekStart} to ${range.weekEnd}`,
      text: `Attached is the Timekeeper report for ${range.weekStart} to ${range.weekEnd} (Australia/Brisbane).`,
      filename: report.filename,
      content: report.buffer,
      idempotencyKey: `timekeeper-${input.type}-${input.weekStart}`,
    });
    await input.store.markDeliverySent(input.weekStart, input.type, current, providerMessageId);
    return { sent: true, filename: report.filename };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown report delivery error';
    await input.store.markDeliveryFailed(input.weekStart, input.type, message);
    throw error;
  }
}
