-- v3.05: instance settings live in D1, not Worker vars.

-- Per-domain theme chosen by the administrator; mailboxes on the domain use it.
ALTER TABLE domains ADD COLUMN theme TEXT;

-- Optional From name, separate from the account label (display_name).
ALTER TABLE native_mailboxes ADD COLUMN sender_name TEXT;
