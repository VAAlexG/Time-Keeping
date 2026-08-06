import { createPool } from '../server/db';
import { createSmtpSender, emailConfigFromEnvironment, sendWeeklyReport } from '../server/email';
import { runMigrations } from '../server/migrations';
import { PgTimeStore } from '../server/pg-store';
import { getWeekRange, previousWeekStart } from '../server/time';

const args = new Set(process.argv.slice(2));
const isTest = args.has('--test');
const weekArg = process.argv.find((value) => value.startsWith('--week='))?.split('=')[1];
const weekStart = getWeekRange(weekArg ?? previousWeekStart()).weekStart;
const recipient = isTest ? process.env.REPORT_TEST_RECIPIENT : process.env.WEEKLY_REPORT_RECIPIENT;
if (!recipient)
  throw new Error(`${isTest ? 'REPORT_TEST_RECIPIENT' : 'WEEKLY_REPORT_RECIPIENT'} is required`);

const pool = createPool();
try {
  await runMigrations(pool);
  const config = emailConfigFromEnvironment();
  const result = await sendWeeklyReport({
    store: new PgTimeStore(pool),
    mailer: createSmtpSender(config),
    from: config.from,
    recipient,
    weekStart,
    type: isTest ? 'test' : 'scheduled',
  });
  console.log(result.sent ? `Sent ${result.filename}` : `Skipped: ${result.reason}`);
} finally {
  await pool.end();
}
