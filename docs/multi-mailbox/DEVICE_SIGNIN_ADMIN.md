# Device sign-in model

Introduced in v2.01. Each browser signs in to its own set of accounts. Nothing is shared between devices automatically.

## Accounts on a device

- Signing in gives the browser a 30-day HttpOnly, Secure device session. D1 keeps the list of accounts that device may open.
- **Custom mailboxes:** sign in with the mailbox address and the password the admin set or generated. Passwords are salted and hashed; they are never stored in plain text or in the browser.
- **Gmail:** **Continue with Google** on each device (OAuth with PKCE). Signing a Gmail account out on one device doesn't affect others.
- **Admin:** password + owner passkey (see [admin sign-in](./ADMIN_MFA.md)). The admin session can open every custom mailbox.
- With two or more accounts on a device, the app opens on **All inboxes**.

## Boundaries

- Every mail, draft, attachment and avatar request is checked against the device's accounts on the server. Asking for another account returns 403.
- `/api/accounts` lists only this device's accounts. Mailbox and Gmail sessions can't reach admin endpoints.
- Push notifications go only to devices allowed to read the mailbox that received the mail.
- Signing out removes only this device's session; removing an account removes it from this device only.
- Changing a mailbox password signs out that mailbox's devices; other accounts stay signed in.
