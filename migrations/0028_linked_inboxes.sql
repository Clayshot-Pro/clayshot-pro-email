-- v3.33: inboxes added on a device stay linked to the device's main inbox (the
-- first one signed in). Logging out ends the session but keeps the links; a new
-- sign-in with the main inbox's password brings every linked inbox back.
-- Nothing is stored that opens an inbox without the main inbox's password.
ALTER TABLE device_sessions ADD COLUMN main_account_id TEXT;

CREATE TABLE IF NOT EXISTS account_links (
  owner_account_id TEXT NOT NULL,
  linked_account_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('native','gmail')),
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_account_id, linked_account_id),
  CHECK (owner_account_id != linked_account_id)
);
CREATE INDEX IF NOT EXISTS idx_account_links_linked ON account_links(linked_account_id);

-- Sessions that exist now: the earliest inbox on each is its main inbox.
UPDATE device_sessions SET main_account_id = (
  SELECT g.account_id FROM device_session_accounts g
  WHERE g.session_id = device_sessions.id ORDER BY g.added_at, g.rowid LIMIT 1);

-- Existing sets are linked only when the main inbox is the main inbox of exactly
-- one session. An inbox several people sign in to would otherwise pool everyone's
-- added inboxes, and each of them could restore the others'.
INSERT OR IGNORE INTO account_links (owner_account_id, linked_account_id, provider)
SELECT s.main_account_id, g.account_id, g.provider
FROM device_session_accounts g
JOIN device_sessions s ON s.id = g.session_id
WHERE s.main_account_id IS NOT NULL AND g.account_id != s.main_account_id
  AND s.main_account_id IN (
    SELECT main_account_id FROM device_sessions WHERE main_account_id IS NOT NULL
    GROUP BY main_account_id HAVING COUNT(*) = 1);
