# v2.01 — device-specific account sign-ins and administrator provisioning

> **Introduced in v2.01.** The account and device model below is still current. Its rollout steps are historical: for installation and deployment, follow the [README](../../README.md).

**Status:** Development branch; not a production capability until this release is merged to `main`, Cloudflare Workers Builds completes, D1 migration 0013 is applied, and manual sign-in tests pass.

## Account and device model

- An email account is **not** automatically visible on all devices. A browser obtains a 30-day `__Host-ltm_device` HttpOnly/Secure/SameSite=Lax session cookie upon sign-in, with a server-side allowlist in D1 (`device_sessions`, `device_session_accounts`).
- Gmail: use **Continue with Google** on that device. Existing encrypted Google provider credentials are reused only after that device completes its own OAuth authorization. Starting OAuth uses PKCE and a one-time browser-bound nonce cookie. Signing out a Gmail account on one device does not revoke it globally or log out other devices.
- Custom domain: sign in with the exact `@liamthemo.com` mailbox address and a mailbox password issued/reset by the administrator. Passwords use 310,000-iteration PBKDF2-SHA256 with per-mailbox random salt, never plaintext stored in D1 or browser localStorage.
- A new browser with no authorized accounts sees a sign-in page with Google OAuth, custom email/password, and a separate administrator passkey option. An authenticated owner passkey grants privileged access to native mailboxes on that browser; Gmail still requires per-browser Google OAuth.
- Accounts currently signed in to another device are not automatically shown on this device. Authentication and session refresh are backed by server-side D1 records, not a client-side list.

## Special administrator panel

- The existing owner passkey remains the **only** administrator credential. The original passkey registration lock remains in effect; mailbox users cannot register passkeys or gain admin privileges using their mailbox passwords.
- Settings exposes **Unlock with administrator passkey** or **Open admin panel** when already authorized. The admin panel hosts mailbox creation, edit, disable, deletion, quotas, Junk settings, storage recount, and password rotation.
- Newly created mailboxes receive a unique random strong password that appears **once** in the admin panel response. After closing it, it cannot be recovered, only rotated. The administrator is responsible for giving credentials to the intended person/device securely.
- Rotating a password removes all normal device grants for that mailbox, requiring new sign-ins. Other addresses and their sessions remain intact. An active owner passkey still retains administrative access.
- All `/api/mailboxes/*`, owner profile, and passkey session administration endpoints are restricted **server-side** to the owner passkey, not merely hidden in UI.

## Security boundaries

- Every message list/detail/mutation, draft, compose, attachment/preview, and provider avatar request checks the requested account against device grants before calling the provider.
- `/api/accounts` only lists the current device's authorized accounts; the passkey administrator can additionally view active native mailboxes.
- Signed-in custom and Gmail users cannot enumerate other mailboxes or request the admin panel endpoints.
- Notification subscriptions are bound to the current device or owner passkey session and sent only when that identity is authorized for the native mailbox receiving mail. Historical unscoped push subscriptions will stop receiving notifications until re-enabled.
- Protected message caching in `sessionStorage` is disabled to prevent replaying a previous account's mail after another user signs in on the same device.
- Sign out removes only the **current device's** device session and passkey session. Account removal signs out only that account on this device. Existing Gmail refresh tokens are not revoked from global storage by device removal.

## Migration and compatibility

- `0013_device_sessions.sql` is additive and preserves existing mailboxes, messages, contacts, auth sessions and encrypted Gmail tokens.
- Existing passkey sessions remain usable and privileged. **Previously added Gmail accounts must go through Google OAuth again on each device**, including existing devices, to establish device authorization.
- Existing `contact@liamthemo.com` has no password assigned by the migration. To use it as a custom-email login, sign in as the owner passkey and select **Admin panel → Reset password** for `contact@`.
- Cloudflare secrets and the Google callback URI remain unchanged. The existing registered OAuth redirect is `https://email.liamthemo.com/api/accounts/gmail/callback`. Google OAuth app verification/testing policies still affect refresh-token lifetime; this code does not change Google project verification status.
- The device cookie lasts 30 days, after which the user must authenticate again. The owner passkey cookie retains its existing separate 7-day lifetime.
- Email Sending for new domain addresses remains independently gated by `MULTI_SENDER_APPROVED`; this sign-in change does not bypass Cloudflare's sender eligibility or transactional-use policy.

## Production validation

1. Confirm D1/R2 backups and Cloudflare `main` branch-only deployments.
2. Check GitHub typecheck/build, migration smoke test and security scan before merging `v2.01` into `main`.
3. Confirm Cloudflare production deployment and D1 migration 0013 succeeded.
4. On a new browser, verify the sign-in page; sign in with Gmail; verify **only** that Gmail account appears.
5. On a separate browser, sign in with a custom mailbox password; confirm no other mailbox appears and direct requests with other `accountId` return 403.
6. Log in with the owner passkey; confirm admin panel is visible, creates address, one-time password, password reset, and new-account login works on a separate device.
7. Test sign-out and account removal on one device without changing sessions on a second device.
8. Re-enable notifications and verify messages for another mailbox do **not** trigger push on the wrong device.
9. Test iPhone and iPad Home Screen installations, persistent logins after app restart, Gmail refresh and owner session revocation.
10. Verify email routing and outbound sending eligibility separately using [Cloudflare setup](./CLOUDFLARE_SETUP.md).
