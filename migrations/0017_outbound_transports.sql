-- v3.02: pluggable outbound transports (Cloudflare default, Resend opt-in),
-- delivery webhooks and recipient suppression.
ALTER TABLE outbound_attempts ADD COLUMN transport TEXT NOT NULL DEFAULT 'cloudflare';
ALTER TABLE outbound_attempts ADD COLUMN last_event TEXT;
ALTER TABLE outbound_attempts ADD COLUMN last_event_at TEXT;
CREATE INDEX IF NOT EXISTS idx_outbound_attempts_provider ON outbound_attempts (transport, provider_message_id);

ALTER TABLE messages ADD COLUMN delivery_event_at TEXT;

CREATE TABLE IF NOT EXISTS suppressed_recipients (
  address TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'manual')),
  source TEXT NOT NULL CHECK (source IN ('resend', 'admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_receipts_received ON webhook_receipts (received_at);
