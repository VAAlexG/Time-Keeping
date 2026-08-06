import nodemailer from 'nodemailer';
import type { TimeStore, DeliveryType } from './types';
import { buildWeeklyWorkbook } from './report';
import { getWeekRange } from './time';

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

export interface MailSender {
  send(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    filename: string;
    content: Buffer;
    idempotencyKey: string;
  }): Promise<void>;
}

export function emailConfigFromEnvironment(): EmailConfig {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const;
  for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
  const port = Number(process.env.SMTP_PORT ?? '587');
  if (!Number.isInteger(port) || port < 1) throw new Error('SMTP_PORT must be a valid port');
  return {
    host: process.env.SMTP_HOST!,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER!,
    password: process.env.SMTP_PASSWORD!,
    from: process.env.SMTP_FROM!,
  };
}

export function createSmtpSender(config: EmailConfig): MailSender {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
  });
  return {
    async send(input) {
      await transporter.sendMail({
        from: input.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        attachments: [{ filename: input.filename, content: input.content }],
        headers: { 'Resend-Idempotency-Key': input.idempotencyKey },
      });
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
    const report = await buildWeeklyWorkbook(input.store, input.weekStart, input.now);
    const range = getWeekRange(input.weekStart);
    await input.mailer.send({
      from: input.from,
      to: input.recipient,
      subject: `${input.type === 'test' ? '[TEST] ' : ''}Time report: ${range.weekStart} to ${range.weekEnd}`,
      text: `Attached is the Timekeeper report for ${range.weekStart} to ${range.weekEnd} (Australia/Brisbane).`,
      filename: report.filename,
      content: report.buffer,
      idempotencyKey: `timekeeper-${input.type}-${input.weekStart}`,
    });
    await input.store.markDeliverySent(input.weekStart, input.type, input.now ?? new Date());
    return { sent: true, filename: report.filename };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown report delivery error';
    await input.store.markDeliveryFailed(input.weekStart, input.type, message);
    throw error;
  }
}
