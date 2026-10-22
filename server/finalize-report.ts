import type { MailSender } from './email';
import { D1PriorityStore } from './priority-store';
import { D1FinalizedReportStore } from './report-archive';
import { buildWeeklyWorkbook } from './report';
import { D1TimeStore } from './d1-store';
import { D1ScheduleStore } from './schedule';
import { getWeekRange } from './time';

export async function finalizeWeeklyReport(input: {
  db: D1Database;
  mailer: MailSender;
  from: string;
  recipients: string[];
  now?: Date;
}): Promise<{ finalized: boolean; emailed: boolean; weekStart: string; filename: string }> {
  if (!input.recipients.length) throw new Error('ADMIN_EMAILS must include at least one email.');
  const now = input.now ?? new Date();
  const range = getWeekRange(undefined, now);
  const archive = new D1FinalizedReportStore(input.db, () => now);
  let report = await archive.get(range.weekStart);
  let finalized = false;
  if (!report) {
    const generated = await buildWeeklyWorkbook(
      new D1TimeStore(input.db, () => now),
      range.weekStart,
      now,
      await new D1PriorityStore(input.db, () => now).list(),
      await new D1ScheduleStore(input.db, () => now).listOccurrences(range.weekStart),
    );
    report = await archive.save({
      weekStart: range.weekStart,
      weekEnd: range.weekEnd,
      finalizedAt: now,
      filename: generated.filename,
      content: generated.buffer,
      totalMs: generated.totalMs,
      entryCount: generated.entryCount,
      emailRecipients: input.recipients,
    });
    finalized = true;
  }
  if (report.emailStatus === 'sent' || !(await archive.claimEmail(range.weekStart)))
    return { finalized, emailed: false, weekStart: range.weekStart, filename: report.filename };
  try {
    const providerMessageId = await input.mailer.send({
      from: input.from,
      to: report.emailRecipients,
      subject: `FINAL weekly time report: ${report.weekStart} to ${report.weekEnd}`,
      text: `Attached is the finalized and locked Timekeeper report for ${report.weekStart} to ${report.weekEnd} (Australia/Brisbane).`,
      filename: report.filename,
      content: report.content,
      idempotencyKey: `timekeeper-final-${report.weekStart}`,
    });
    await archive.markEmailSent(report.weekStart, providerMessageId);
    return { finalized, emailed: true, weekStart: report.weekStart, filename: report.filename };
  } catch (error) {
    await archive.markEmailFailed(
      report.weekStart,
      error instanceof Error ? error.message : 'Unknown finalized report delivery error',
    );
    throw error;
  }
}
