-- v3.01: multiple mail domains managed by the single global administrator.
-- The primary domain row is created at runtime from PRIMARY_ADDRESS.
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  outbound_transport TEXT NOT NULL DEFAULT 'cloudflare'
    CHECK (outbound_transport IN ('cloudflare', 'resend', 'none')),
  postmaster_mailbox_id TEXT REFERENCES native_mailboxes(id) ON DELETE SET NULL,
  dns_checked_at TEXT,
  dns_report TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_single_primary ON domains (is_primary) WHERE is_primary = 1;

ALTER TABLE native_mailboxes ADD COLUMN domain TEXT;
UPDATE native_mailboxes SET domain = lower(substr(email_address, instr(email_address, '@') + 1));
CREATE INDEX IF NOT EXISTS idx_native_mailboxes_domain ON native_mailboxes (domain, status);
