import type { DeliveryType, PriorityItem, ScheduleOccurrence, TimeStore } from './types';
import { buildWeeklyWorkbook } from './report';
import { brisbaneNow, getWeekRange } from './time';

export interface MailSender {
  send(input: {
    from: string;
    to: string | string[];
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
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          from: input.from,
          to: Array.isArray(input.to) ? input.to : [input.to],
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
  recipient: string | string[];
  weekStart: string;
  type: DeliveryType;
  now?: Date;
  priorities?: PriorityItem[];
  schedule?: ScheduleOccurrence[];
}): Promise<{ sent: boolean; reason?: string; filename?: string }> {
  const current = input.now ?? new Date();
  const deliveryDate = brisbaneNow(current).toISODate()!;
  const recipients = Array.isArray(input.recipient) ? input.recipient : [input.recipient];
  const recipientAudit = recipients.join(',');
  const claim = await input.store.claimDelivery(
    input.weekStart,
    deliveryDate,
    input.type,
    recipientAudit,
  );
  if (!claim.shouldSend) return { sent: false, reason: claim.reason };
  try {
    const report = await buildWeeklyWorkbook(
      input.store,
      input.weekStart,
      current,
      input.priorities,
      input.schedule,
    );
    const range = getWeekRange(input.weekStart, current);
    const providerMessageId = await input.mailer.send({
      from: input.from,
      to: input.recipient,
      subject: `${input.type === 'test' ? '[TEST] ' : ''}Time report: ${range.weekStart} to ${range.weekEnd}`,
      text: `Attached is the Timekeeper report for ${range.weekStart} to ${range.weekEnd} (Australia/Brisbane).`,
      filename: report.filename,
      content: report.buffer,
      idempotencyKey: `timekeeper-v2-${input.type}-${input.weekStart}-${deliveryDate}`,
    });
    await input.store.markDeliverySent(
      input.weekStart,
      deliveryDate,
      input.type,
      current,
      providerMessageId,
    );
    return { sent: true, filename: report.filename };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown report delivery error';
    await input.store.markDeliveryFailed(input.weekStart, deliveryDate, input.type, message);
    throw error;
  }
}
