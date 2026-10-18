-- v3.05: instance settings live in D1, not Worker vars.

-- Per-domain theme chosen by the administrator; mailboxes on the domain use it.
ALTER TABLE domains ADD COLUMN theme TEXT;

-- Optional From name, separate from the account label (display_name).
ALTER TABLE native_mailboxes ADD COLUMN sender_name TEXT;

-- One-time carry-over for the original LTM instance, whose name and sender
-- name used to come from Worker vars. Only applies to an established install
-- (owner passkey present) with that exact primary mailbox; no-op elsewhere.
UPDATE native_mailboxes SET sender_name = 'Liam'
WHERE id = 'native:primary' AND email_address = 'contact@liamthemo.com' AND sender_name IS NULL
  AND EXISTS (SELECT 1 FROM auth_credentials);

INSERT OR IGNORE INTO instance_settings (id, settings)
SELECT 1, '{"brandName":"LTM Mails"}'
WHERE EXISTS (SELECT 1 FROM native_mailboxes WHERE id = 'native:primary' AND email_address = 'contact@liamthemo.com')
  AND EXISTS (SELECT 1 FROM auth_credentials);
