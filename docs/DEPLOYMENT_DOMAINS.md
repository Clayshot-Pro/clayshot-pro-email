# Hosting LTM Email Service on another Worker domain

The **web application hostname**, **administrator sign-in identity**, and **email-sending domain** are distinct concerns.

## Web app and administrator login

When the Worker is available at `https://mail.example.org`:

- The administrator signs in as **`admin@<mail domain>`**, which is also the administrator's own mailbox (v3.08). **`admin@mail.example.org`** (the app hostname) is accepted as an alias. The password remains the one configured in that installation's D1 database; the hostname is not an email inbox and does not need MX records.
- The WebAuthn relying-party ID is `mail.example.org`, and its expected browser origin is `https://mail.example.org`. A separate secure hostname has its own passkey registration.
- The API's same-origin mutation policy uses the Worker request URL's origin, not a `Host` or `X-Forwarded-Host` request header.
- The **Gmail OAuth callback** is `https://mail.example.org/api/accounts/gmail/callback`, and its PKCE/OAuth state is bound to the originating hostname.

There is **no** `APP_ORIGIN`, `RP_ID`, or `ADMIN_ADDRESS` source constant that needs editing for a new Worker host.

### Administrator addresses

Since v3.08, `admin@<main mail domain>` (for example `admin@liamthemo.com`) is a real mailbox and the preferred sign-in on any app hostname. `admin@<app hostname>` (for example `admin@email.liamthemo.com`) is an alias. Both use **exactly the same administrator password record and passkey**. Another instance's admin address is never accepted.

### Passkey migration warning

**Changing the hostname of an existing installation does not migrate its passkeys.** WebAuthn credentials are restricted to the relying-party ID for which they were registered. Pointing a new hostname at an existing D1 database with previously registered passkeys does **not** automatically make them work at the new hostname; registration is intentionally locked once any credential exists.

For a truly new standalone deployment, provision a separate D1 database, R2 bucket and Worker secrets (`PROVIDER_CREDENTIAL_KEY`, `AUTH_SETUP_TOKEN`), then complete first-run setup and enroll the passkey on that new hostname before setting the administrator password. For an existing installation, preserve the original hostname and passkey until a separately verified, owner-controlled credential migration/recovery path is established. **Do not delete authentication rows or disable WebAuthn as a shortcut.**

## Gmail connection: manual Google Console change

Add the new exact callback URI under the Google OAuth application's **Authorized redirect URIs**. Google checks an exact match (including HTTPS and path) and will return `redirect_uri_mismatch` if not registered. This cannot be auto-configured by the Worker. Any pending OAuth attempt from before the origin change should be restarted.

## Mail domains are configured separately

Mail domains live in D1 and are managed in **Admin → Domains**; the main domain is chosen in first-run setup, which also creates `admin@<main domain>`. **Changing only the web-app hostname does not change any mailbox address, MX routing, Email Sending onboarding or mailbox records.**

To add another mail domain, follow README step 5 (Email Routing catch-all → this Worker, then add, check and activate the domain in Admin → Domains) and step 6 (onboard it for Email Sending or switch it to Resend). Renaming the **primary** mail domain of an existing installation is a separate, stateful migration of mailbox records, routing and sending setup; do not assume email moves with the hostname.

## Deployment checklist

1. Configure the Worker custom domain, HTTPS, and a dedicated D1/R2 deployment.
2. Deploy from `main` (GitHub Actions, Workers Builds or `npm run deploy:self`; see README step 3). Migrations apply during the deploy.
3. Add the Google OAuth redirect URI for the exact new Worker host (if Gmail is enabled).
4. On a fresh installation, complete first-run setup on that hostname: mail domain, owner passkey, then the administrator password.
5. Verify the hostname-based administrator account, WebAuthn sign-in, fresh passkey approval for an administrative change, CSRF rejection from other origins, and the audit log.
6. Independently verify native email routing/sending and backups if the mail domain also changes.
