# Administrator login with password + passkey

> Introduced in v2.02 and still current. Password lengths reflect the current policy (4–32 characters for both administrator and mailbox passwords). For installation and deployment, see the [README](../../README.md).

## Intended user experience

- `admin@<worker-hostname>` is a **reserved login identity**, not a mail inbox or newly created native mailbox.
- On a device without saved accounts, type `admin@<worker-hostname>` into the normal **Custom email** sign-in form, followed by the administrator password.
- The app then requests the previously registered **owner passkey** as a mandatory second factor. Both must succeed on the same browser, within five minutes, to establish an administrator session.
- Once authenticated, the app opens the **standalone Email administration dashboard**, instead of showing a normal inbox or an admin panel buried in Settings.
- On a device already signed into an email account, choose **Add custom email** in Settings and sign in as `admin@<worker-hostname>`; after completing both factors the app opens the separate dashboard.
- Admin dashboard supports creating mailboxes, changing their passwords to an owner-chosen value (4–32 characters) or generating a secure random password, quotas, archival and deletion operations.

## Setting your administrator password the first time

Your existing owner passkey is already registered. The v2.02 migration **does not set or transmit an administrator password**. On initial use, the sign-in page offers **Set up admin password using passkey**; authenticate with your existing passkey and choose the password in the standalone admin dashboard. You must choose it in the web app. **Do not put it in repository files, Cloudflare build variables, or chat messages.**

Once the password is saved, all existing passkey-only administrator sessions are invalidated. Sign in using `admin@<worker-hostname>`, your chosen password, then your passkey. This prevents legacy passkey-only sign-in from bypassing the new second factor.

## Changing passwords

- **Administrator password:** In the admin dashboard choose **Change administrator password**. Supply the current administrator password, new password (4–32 characters), and confirmation. The change revokes *all* administrator sessions; log in again with password + passkey. The registered passkey is not changed.
- **Individual mailbox password:** In **Custom mailboxes**, select **Set password** for the desired address, provide and confirm a strong password. The password is salted and hashed on the server; the server returns no plaintext. The existing mailbox device sessions are revoked without affecting other email accounts.
- **Generated mailbox password:** Choose **Generate password** to replace a mailbox password with a random strong value. That random password is returned once to the passkey-authenticated admin screen. Store it securely; it cannot be retrieved later.

## Security design

- Only one administrator password record is allowed (`admin_credentials.id=1`). `admin@<worker-hostname>` cannot be registered as a normal mailbox or logged into via the ordinary mailbox password flow.
- New administrator passwords are salted and **scrypt** hashed (N=16,384, r=8, p=1); plaintext is neither logged nor committed. Per-IP login attempts are rate-limited. Legacy PBKDF2-SHA256 records retain their original per-record verification parameters.
- A successful administrator password entry issues an HttpOnly, Secure, SameSite=Strict cookie for a short-lived pending login. The password proof is stored hashed and expires after five minutes.
- WebAuthn passkey options require the pending password proof once the admin password is configured. Each passkey challenge records the pending proof identifier. Successful passkey verification must consume that matching proof exactly once before the owner session is issued.
- Owner sessions are the only sessions authorized for `/api/mailboxes/*` and protected profile/session administration. Ordinary mailbox or Gmail sessions have no admin authority.
- No WebAuthn credentials are added automatically; existing passkeys and their registration lock remain.
- Changing the administrator password invalidates all administrator sessions and pending password proofs.

## Production steps

1. CI validates TypeScript, Workers build, legacy migrations, admin schema and mailbox password policy.
2. Merge temporary feature branch to permanent `v2.02`, then merge `v2.02` to `main`, which deploys production.
3. Confirm additive migration `0014_admin_password_2fa.sql` applied to the correct production D1 database.
4. Use the existing passkey to set the administrator password, and verify the next sign-in requires **both** factors.
5. Test bypass attempts: calling passkey endpoints without a fresh administrator password must fail; a bad password must fail; a replayed pending token must fail; a normal mailbox session must receive 403 from admin endpoints.
6. On two devices, change an individual mailbox password and confirm both normal sessions are revoked. Confirm existing Gmail, content, and notifications are unaffected.
7. Check mobile Safari/Home Screen PWA and desktop workflows for clear admin navigation and successful sign-out.

## Recovery warning

There is no automatic administrator password recovery or passkey bypass. Save the administrator password in a trusted password manager and retain access to the existing registered passkey. A lockout requires a separate owner-controlled recovery process, not a public reset link.

## v2.05 fix: Cloudflare production runtime and wording

**Password length** (current policy): 4–32 characters for the administrator and for mailboxes; punctuation such as `?` and `!` is supported.

Cloudflare Workers limits PBKDF2 to 100,000 iterations on some production runtime paths. The earlier 310,000-iteration PBKDF2 hashing of new passwords could throw `NotSupportedError` before D1 was called, even though tests passed in Node. New administrator and mailbox passwords now use Workers-supported **scrypt** with a per-record version marker stored in the existing `iterations` column (`-1`). Existing positive-value PBKDF2-SHA256 records remain recognized for verification. This is a code/runtime fix; **no new D1 migration or Cloudflare secrets are needed**.

The main application and CI include a new isolated Cloudflare workerd integration test for password creation and verification. Admin password save errors have separate non-sensitive server diagnostics for hash failures and D1 failures, and the UI no longer offers the obsolete advice to check D1 migrations by default.

[Cloudflare cryptography support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/) · [Cloudflare PBKDF2 iteration limit](https://github.com/cloudflare/workerd/issues/1346).

Do not share passwords, raw hashes, recovery tokens or credentials in bug reports.

## Portable hostnames (v2.07)

The administrator username is derived from the actual HTTPS Worker host, for example `admin@mail.example.org` when the application is deployed to `https://mail.example.org`. At the existing `email.liamthemo.com` production host, the former `admin@liamthemo.com` name remains a compatible alias. Both identify the same owner and require the same password and passkey. See [host migration and WebAuthn caveats](../DEPLOYMENT_DOMAINS.md).
