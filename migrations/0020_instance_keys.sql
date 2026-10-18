-- v3.06: integration keys live in D1 instead of Worker secrets. Each value is
-- AES-GCM encrypted with the PROVIDER_CREDENTIAL_KEY Worker secret and bound
-- to its name; it is never returned to the browser. hint is a short,
-- non-secret fragment for display. VAPID holds the push key pair as one row.
CREATE TABLE IF NOT EXISTS instance_keys (
  name TEXT PRIMARY KEY CHECK (name IN (
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET',
    'CF_EMAIL_SENDING_TOKEN', 'VAPID'
  )),
  value TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
