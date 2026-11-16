# Sign-in, app address and mail domains

The app address, the administrator sign-in and the mail domains are three separate things.

## App address and passkeys

The app works on whatever HTTPS address serves it (`workers.dev` or a custom domain like `mail.example.org`). Nothing in the code or config names it.

- **Passkeys are tied to the address.** A passkey made on `mail.example.org` works only there, so choose the final address before first-run setup.
- **Changing the address of a running instance does not move its passkeys**, and new passkeys can't be registered once one exists. Keep the original address. Never delete authentication rows or disable passkeys to get around this.
- **One public address (v3.33).** Cloudflare also serves every Worker on `<name>.<account>.workers.dev` and on per-version preview links. Once the administrator signs in on a custom domain, those addresses stop serving the app: pages redirect to that domain and the API answers 404 (signed Resend webhooks still work). An instance that only ever runs on `workers.dev` is unaffected. Moving to another custom domain: sign in there as administrator and `workers.dev` follows. To serve `workers.dev` again, delete the recorded address: `npx wrangler d1 execute <database> --remote --command "DELETE FROM app_host"`. Either change takes effect within a minute.
- **Gmail:** the OAuth redirect URI is `https://<app address>/api/accounts/gmail/callback`. Add the exact URI in Google Cloud for every address you use.
- **Mail domains** are managed in **Admin → Domains**; the main one is chosen at first-run setup. Changing the app address never changes mailbox addresses, routing or sending. Renaming the main mail domain of a running instance is not supported.
- **A new instance on another address** needs its own Worker, D1 database and R2 bucket: a new fork's first **Deploy production** run creates them (use the `WORKER_NAME`, `D1_DATABASE_NAME` and `R2_BUCKET_NAME` repository variables for other names). Add the custom domain, then run first-run setup on that address. See the [README](../README.md).

## Accounts on a device

Each browser signs in to its own set of accounts. Nothing is shared between devices automatically.

The sign-in form (and **Add inbox → Custom mailbox**) asks for a **username** in one field, with the domain on its right: type `alice` and pick `@example.com` from the list (an instance with one domain shows it without a list). The list holds the instance's own active domains (every fork shows its own; a domain appears once it is active in Admin → Domains), the main domain first, and the form remembers the last one used on that browser. A full address typed or filled in by a password manager is used as it is.

- Signing in gives the browser an HttpOnly, Secure device session for 30 days, renewed for another 30 when the app is opened after a week. D1 keeps the list of accounts that device may open.
- **Mailboxes:** sign in with the mailbox address and the password the admin chose or generated. Mailbox users never get admin rights.
- **Gmail:** **Continue with Google** on each device (OAuth with PKCE). Signing a Gmail account out on one device doesn't affect others. If the Google account's verified address is the address of an active mailbox on this app, Google opens that mailbox instead (no Gmail inbox is connected and Google's access is revoked); the administrator's addresses are never opened this way.
- With two or more accounts on a device, the app opens on **All inboxes**.
- Every mail, draft, attachment and photo request is checked against the device's accounts on the server; asking for another account returns 403. `/api/accounts` lists only this device's accounts.
- Push notifications go only to devices allowed to read the mailbox that received the mail (admin phones get every mailbox while the admin session is live). Once a sign-in ends or expires, its alerts stop.
- **Sign out** next to an account (Settings → Inboxes) signs out just that account; the others stay signed in. Administrators have **Sign out of admin**, which ends only the admin session. **Log out of all accounts** ends everything on the device.
- Signing out or removing an account affects only this device. Changing a mailbox password signs out that mailbox's devices; other accounts stay signed in.

## Administrator

The administrator signs in with **both** a password and the owner passkey, as `admin@<main mail domain>`, which is also the admin's mailbox. `admin@<app address>` works as an alias with the same password and passkey.

1. In the normal sign-in form, type `admin`, pick the main mail domain, and enter the password.
2. Confirm with the owner passkey within five minutes in the same browser.
3. The mail app opens with every mailbox. **Admin panel** (sidebar, or Settings on a phone) opens administration; **Back to mail** returns.

Admin sessions last 12 hours and end after 1 hour idle. Sensitive admin changes (mailboxes, domains, keys, sessions) ask for the passkey again.

## Passwords

- **Admin password:** chosen at first-run setup. Instances set up before v3.12 without one see **Set up admin password using passkey** on the sign-in page. Change it with **Admin panel → Change administrator password**; this signs out every admin session, and the passkey is unchanged.
- **Mailbox passwords:** when creating a mailbox the administrator can choose its first password, or leave it empty to have a strong one generated (shown once). Afterwards: **Admin → Mailboxes → Change password** (choose one) or **More actions → Generate password** (shown once); this signs out that mailbox's devices only.
- **Changing your own password:** anyone signed in to a mailbox can change its password in **Settings → Password** by entering the current one. Other devices using the mailbox are signed out; the device used stays signed in. admin@ uses the administrator password instead (Admin panel); Gmail passwords are changed with Google.

Passwords are 4–32 characters. Never put them in repository files, build variables or chat.

## Security design

- Passwords are salted and hashed with scrypt; older PBKDF2 records still verify. They are never stored in plain text or in the browser.
- The admin password step issues a short-lived, HttpOnly pending proof that the passkey step must consume exactly once.
- Only passkey-backed owner sessions reach `/api/admin/*` and `/api/mailboxes/*`; mailbox and Gmail sessions can't. Sign-in attempts are rate-limited per client and per mailbox.
- Changing the admin password invalidates all admin sessions and pending proofs.

## Recovery

There is no password reset or passkey bypass. Keep the admin password in a password manager and keep the passkey device. A lockout needs an owner-controlled recovery, not a public reset link.
