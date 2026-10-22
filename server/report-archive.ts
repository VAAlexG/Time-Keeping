export interface FinalizedReportSummary {
  weekStart: string;
  weekEnd: string;
  finalizedAt: string;
  filename: string;
  totalMs: number;
  entryCount: number;
  emailStatus: 'pending' | 'sending' | 'sent' | 'failed';
  emailRecipients: string[];
  emailSentAt: string | null;
  emailError: string | null;
}

export interface FinalizedReport extends FinalizedReportSummary {
  content: Uint8Array;
}

interface FinalizedReportRow {
  week_start: string;
  week_end: string;
  finalized_at: number;
  filename: string;
  content: ArrayBuffer;
  total_ms: number;
  entry_count: number;
  email_status: 'pending' | 'sending' | 'sent' | 'failed';
  email_recipients: string;
  email_sent_at: number | null;
  email_error: string | null;
}

const SELECT = `SELECT week_start, week_end, finalized_at, filename, content, total_ms,
  entry_count, email_status, email_recipients, email_sent_at, email_error
  FROM finalized_weekly_reports`;
const SUMMARY_SELECT = `SELECT week_start, week_end, finalized_at, filename, total_ms,
  entry_count, email_status, email_recipients, email_sent_at, email_error
  FROM finalized_weekly_reports`;

function fromRow(row: FinalizedReportRow): FinalizedReport {
  return {
    weekStart: row.week_start,
    weekEnd: row.week_end,
    finalizedAt: new Date(row.finalized_at).toISOString(),
    filename: row.filename,
    content: new Uint8Array(row.content),
    totalMs: row.total_ms,
    entryCount: row.entry_count,
    emailStatus: row.email_status,
    emailRecipients: row.email_recipients.split(',').filter(Boolean),
    emailSentAt: row.email_sent_at === null ? null : new Date(row.email_sent_at).toISOString(),
    emailError: row.email_error,
  };
}

export class D1FinalizedReportStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<FinalizedReportSummary[]> {
    const result = await this.db
      .prepare(`${SUMMARY_SELECT} ORDER BY week_start DESC`)
      .all<Omit<FinalizedReportRow, 'content'>>();
    return result.results.map((row) => {
      const report = fromRow({ ...row, content: new ArrayBuffer(0) });
      const { content: _omitted, ...summary } = report;
      void _omitted;
      return summary;
    });
  }

  async get(weekStart: string): Promise<FinalizedReport | null> {
    const row = await this.db
      .prepare(`${SELECT} WHERE week_start = ? LIMIT 1`)
      .bind(weekStart)
      .first<FinalizedReportRow>();
    return row ? fromRow(row) : null;
  }

  async save(input: {
    weekStart: string;
    weekEnd: string;
    finalizedAt: Date;
    filename: string;
    content: Uint8Array;
    totalMs: number;
    entryCount: number;
    emailRecipients: string[];
  }): Promise<FinalizedReport> {
    const timestamp = input.finalizedAt.getTime();
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO finalized_weekly_reports
         (week_start, week_end, finalized_at, filename, content, total_ms, entry_count,
          email_status, email_recipients, email_attempts, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)`,
      )
      .bind(
        input.weekStart,
        input.weekEnd,
        timestamp,
        input.filename,
        input.content,
        input.totalMs,
        input.entryCount,
        input.emailRecipients.join(','),
        timestamp,
      )
      .run();
    return (await this.get(input.weekStart))!;
  }

  async claimEmail(weekStart: string): Promise<boolean> {
    const timestamp = this.now().getTime();
    const result = await this.db
      .prepare(
        `UPDATE finalized_weekly_reports
         SET email_status = 'sending', email_attempts = email_attempts + 1,
             email_error = NULL, updated_at = ?
         WHERE week_start = ? AND
           (email_status IN ('pending', 'failed') OR
            (email_status = 'sending' AND updated_at < ?))`,
      )
      .bind(timestamp, weekStart, timestamp - 15 * 60_000)
      .run();
    return Boolean(result.meta.changes);
  }

  async markEmailSent(weekStart: string, providerMessageId?: string): Promise<void> {
    const timestamp = this.now().getTime();
    await this.db
      .prepare(
        `UPDATE finalized_weekly_reports SET email_status = 'sent', email_sent_at = ?,
         provider_message_id = ?, email_error = NULL, updated_at = ? WHERE week_start = ?`,
      )
      .bind(timestamp, providerMessageId ?? null, timestamp, weekStart)
      .run();
  }

  async markEmailFailed(weekStart: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE finalized_weekly_reports SET email_status = 'failed', email_error = ?,
         updated_at = ? WHERE week_start = ?`,
      )
      .bind(error.slice(0, 1000), this.now().getTime(), weekStart)
      .run();
  }
}
