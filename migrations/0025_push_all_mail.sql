-- v3.18: a phone that turned on alerts while signed in as the administrator
-- receives alerts for every mailbox until this time. It is renewed while the
-- administrator keeps using the app, and cleared on sign-out, on signing out
-- other sessions, and on a password change. Admin passkey sessions stay short.
ALTER TABLE push_subscriptions ADD COLUMN all_mail_until TEXT;
