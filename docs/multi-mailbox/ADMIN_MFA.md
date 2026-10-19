# Admin sign-in: password + passkey

The administrator signs in with **both** a password and the owner passkey. Mailbox users sign in with their mailbox password only and never get admin rights.

## Signing in

1. In the normal sign-in form, enter `admin@<mail domain>` (or `admin@<app address>`) and the admin password.
2. Confirm with the owner passkey within five minutes on the same browser.
3. The mail app opens. **Admin panel** (sidebar, or Settings on a phone) opens administration; **Back to mail** returns.

Sensitive admin changes (mailboxes, domains, keys, sessions) ask for the passkey again.

## Setting and changing passwords

- **First password:** chosen at first-run setup. Instances set up before v3.12 without one see **Set up admin password using passkey** on the sign-in page.
- **Admin password:** Admin panel → **Change administrator password**. This signs out every admin session; the passkey is unchanged.
- **Mailbox passwords:** Admin → Mailboxes → **Set password** or **Generate password** (shown once). This signs out that mailbox's devices only.

Passwords are 4–32 characters. Never put them in repository files, build variables or chat.

## Security design

- One admin password record. It is salted and hashed with scrypt; older PBKDF2 records still verify.
- The password step issues a short-lived, HttpOnly pending proof that the passkey step must consume exactly once.
- Only passkey-backed owner sessions can reach `/api/admin/*` and `/api/mailboxes/*`. Login attempts are rate-limited.
- Changing the admin password invalidates all admin sessions and pending proofs.

## Recovery

There is no password reset or passkey bypass. Keep the admin password in a password manager and keep the passkey device. A lockout needs an owner-controlled recovery, not a public reset link.
