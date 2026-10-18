-- v3.09: per-mailbox blocked senders. pattern is a lower-case address
-- (someone@example.com) or a domain prefixed with @ (@example.com, which also
-- covers its subdomains). Mail from a blocked sender is delivered to Junk.
CREATE TABLE IF NOT EXISTS blocked_senders (
  mailbox_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (mailbox_id, pattern)
);
