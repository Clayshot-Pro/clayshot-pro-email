interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  ASSETS: Fetcher;
  // Filled automatically at build time from CLOUDFLARE_ACCOUNT_ID (not secret).
  CF_EMAIL_SENDING_ACCOUNT_ID?: string;
  // Worker secrets uploaded by scripts/secrets-push.mjs. Instance settings
  // (domains, branding, forwarding, limits) live in D1, not in Worker vars.
  CF_EMAIL_SENDING_TOKEN?: string;
  AUTH_SETUP_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PROVIDER_CREDENTIAL_KEY?: string;
}
