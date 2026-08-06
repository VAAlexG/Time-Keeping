export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_PASSWORD_HASH: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  WEEKLY_REPORT_RECIPIENT: string;
  REPORT_TEST_RECIPIENT: string;
}
