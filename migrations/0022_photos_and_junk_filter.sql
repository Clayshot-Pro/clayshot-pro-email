-- v3.10: per-mailbox profile photos and the junk filter on for every mailbox.
-- The photo itself is in R2; its version is kept here so account lists and
-- the admin panel need no R2 lookups.
ALTER TABLE native_mailboxes ADD COLUMN photo_version TEXT;

-- Potential spam goes to Junk for every mailbox (it can still be turned off
-- per mailbox in Admin → Mailboxes). New mailboxes are created with it on.
UPDATE native_mailboxes SET spam_filter_enabled = 1;
