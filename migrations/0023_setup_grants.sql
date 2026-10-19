-- v3.12: first-run setup verified by a Cloudflare API token hands out a
-- short-lived grant (stored hashed) for registering the owner passkey.
CREATE TABLE IF NOT EXISTS setup_grants (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

-- The stored Cloudflare connection (token, account, Worker) is one more
-- encrypted instance key. SQLite cannot change a CHECK constraint, so the
-- table is rebuilt with its rows; PROVIDER_CREDENTIAL_KEY stays excluded.
CREATE TABLE instance_keys_v2 (
  name TEXT PRIMARY KEY CHECK (name IN (
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET',
    'CF_EMAIL_SENDING_TOKEN', 'VAPID', 'CLOUDFLARE'
  )),
  value TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO instance_keys_v2 (name, value, hint, updated_at) SELECT name, value, hint, updated_at FROM instance_keys;
DROP TABLE instance_keys;
ALTER TABLE instance_keys_v2 RENAME TO instance_keys;
