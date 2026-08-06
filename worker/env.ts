export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAIL_DOMAIN: string;
  ADMIN_EMAILS: string;
  LOCAL_DEV_IDENTITY_EMAIL?: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  WEEKLY_REPORT_RECIPIENT: string;
  REPORT_TEST_RECIPIENT: string;
}
