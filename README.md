# LTM Email Service

**A self-hostable private webmail app on Cloudflare**, built with React, TypeScript, Vite, Workers, D1, R2, WebAuthn/passkeys, optional Gmail and optional Resend.

> **License.** You may run your own instance — personally or inside your own organization, including commercially — free of charge, as long as the built-in "Powered by LTM Email Service" credit stays visible. You may not redistribute the software, publish modifications, host it for others, or charge anyone for access. See [LICENSE](./LICENSE).

## What you are deploying

An **authenticated web application**, not a traditional mail server: there are no IMAP/POP3/SMTP accounts. Inbound mail enters through Cloudflare Email Routing's Email Worker, is indexed in D1 and stored as raw MIME/attachments in R2. Outbound mail goes through **Cloudflare Email Sending** (the Worker's send binding — no token needed), or **Resend** for domains you switch to it. Gmail accounts connect through Google OAuth.

| Component | Responsibility |
| --- | --- |
| React / Vite + Workers Static Assets | Desktop, mobile and installable PWA frontend |
| Cloudflare Worker (`src/worker/index.ts`) | APIs, Email Worker handler, scheduled cleanup |
| D1 (`DB`) | Instance settings, domains, mailboxes, message metadata, drafts, sessions, audit log |
| R2 (`MAIL`) | Raw MIME, attachments, profile photos and the app icon |
| Cloudflare Email Routing | Delivers incoming mail to the Worker's `email()` handler |
| Cloudflare Email Sending (`EMAIL` binding) | Outbound mail for every active mailbox (default; the REST API is used instead if you set a token) |
| Resend (optional) | Alternative outbound transport per domain, with signed delivery webhooks |
| WebAuthn / passkeys | Owner authentication and fresh approval for sensitive admin actions |
| Gmail API (optional) | Connected Gmail accounts |
| Web Push / VAPID (optional) | Browser/PWA notifications |

**There is no instance configuration in the Worker.** The app's address and the admin sign-in come from the URL it is served on. The primary mailbox, mail domains, branding, themes, forwarding, limits and integration keys are stored in D1 and managed from the app. Outside the app you set only two Worker **secrets** (`PROVIDER_CREDENTIAL_KEY`, plus `AUTH_SETUP_TOKEN` until setup is done) and two Cloudflare **deploy keys**. Nothing secret is committed.

## Before you start

- A Cloudflare account with **Workers, D1, R2, Email Routing and Email Sending**. Check each product's availability, quotas and billing; a free deployment is not guaranteed.
- A mail domain on **Cloudflare DNS** (for example `example.com`), and a hostname for the app (for example `mail.example.com`).
- Node.js **22 or later** (CI uses 24) and npm, if you deploy or develop from your computer.
- A passkey-capable device and browser. WebAuthn requires HTTPS on real domains.
- Optionally: a Google Cloud OAuth client (Gmail) and a Resend account. Push notification keys are created for you.

Use fresh D1/R2 resources for a new installation, and back up both D1 **and** R2 before changing an existing one.

## 1. Get the code

Keep your copy **private**: publishing a public fork with changes is redistribution under the licence. Either import this repository into a private GitHub repository of your own (needed for automatic deploys), or clone it:

```bash
git clone https://github.com/LiamTheMo/LTM-Email-Service.git my-mail
cd my-mail
npm ci
```

## 2. Know where each setting goes

| Setting | Where it goes |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` — deploy token with **Workers Scripts: Edit, D1: Edit, Workers R2 Storage: Edit, Account Settings: Read** | Wherever your deploys run (step 3): GitHub **repository secret**, Workers Builds **build variable** (secret), or `.env` |
| `CLOUDFLARE_ACCOUNT_ID` | Next to the token |
| `PROVIDER_CREDENTIAL_KEY` — encrypts the keys and Gmail tokens stored in D1 | **Worker → Settings → Variables & Secrets**, type **Secret** (`npm run setup` generates and uploads it for command-line installs) |
| `AUTH_SETUP_TOKEN` — one-time password for first-run setup | **Worker → Settings → Variables & Secrets**, type **Secret**; delete it after setup |
| Google OAuth client ID and secret (Gmail) | **Admin → Keys** in the app |
| Resend API key and webhook secret | **Admin → Keys** |
| Cloudflare Email Sending API token — optional, sending works without it | **Admin → Keys** |
| Push notification (VAPID) keys | Nothing to do: created automatically on first use and stored in D1 |
| `WORKER_NAME`, `D1_DATABASE_NAME`, `R2_BUCKET_NAME`, `D1_DATABASE_ID` — optional, sensible defaults | Next to the deploy token, only if you change the defaults |
| Primary mailbox, domains, branding, themes, forwarding, limits | **The app itself** (first-run setup and the admin panel) |

Create the two Worker secrets with a strong random value each:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

**Keep a copy of `PROVIDER_CREDENTIAL_KEY` outside Cloudflare** (for example in a password manager). Changing or losing it makes everything in Admin → Keys and every connected Gmail account unreadable; your mail itself is not affected.

Deploy keys are never visible to the running app, and Worker secrets never belong in GitHub. Add Worker secrets as type **Secret**: a plain "Text" variable added in the dashboard is removed on the next deploy, while secrets persist across deploys.

**Admin → Keys** stores keys in D1, encrypted with `PROVIDER_CREDENTIAL_KEY`. Saved values are never shown again, and saving or removing one needs a fresh passkey check. A Worker secret with the same name (for example `RESEND_API_KEY`) also still works and takes precedence; the app copies it into D1, so you can delete the Worker secret later and keep the value.

## 3. Deploy

Pick one way to deploy and use only that one. Every way deploys **only from `main`**: `npm run deploy` refuses to run for any other branch or for pull requests.

### Option A — GitHub Actions (recommended)

`.github/workflows/deploy.yml` builds, applies database migrations and deploys on every push to `main`.

1. In the Cloudflare dashboard, create a **D1 database** named `ltm-email-service` and an **R2 bucket** named `ltm-email-service-mail` (other names work if you add them as repository secrets too).
2. Create the Worker: **Workers & Pages → Create → Worker**, named `ltm-email-service` (or set `WORKER_NAME`). If it is connected to Git under **Settings → Build**, disconnect it so it does not deploy twice.
3. In your GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Push or merge to `main`, or run **Actions → Deploy production → Run workflow** on `main`. The run shows the migrations it applied and the deployed version.
5. In the Worker's **Settings → Variables & Secrets**, add `PROVIDER_CREDENTIAL_KEY` and `AUTH_SETUP_TOKEN` as type **Secret**.
6. Under **Settings → Domains & Routes**, add your custom domain (for example `mail.example.com`).

Every later merge to `main` deploys automatically.

### Option B — Cloudflare Workers Builds

1. Create the D1 database and R2 bucket as in Option A step 1.
2. **Workers & Pages → Create → Import a repository**, pick your private repository, and name the Worker `ltm-email-service` (or set `WORKER_NAME`).
3. In the Worker's **Settings → Build**:
   - Production branch: `main`. Turn off builds for other branches unless you give them their own database and bucket.
   - Build command: `npm run build:cloudflare`
   - Deploy command: `npm run deploy`
   - **Build variables:** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (as a secret).
4. Push or merge to `main`.
5. Continue with Option A steps 5 and 6.

If every build fails before it starts with "The build token selected for this build has been deleted or rolled", create a new token from the **API token** dropdown under **Settings → Build** and save. If that does not help, switch to Option A.

### Option C — from your computer (`.env`)

```bash
cp .env.example .env
```

Fill in `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `AUTH_SETUP_TOKEN` in `.env` (it is gitignored), then:

```bash
npm run setup
```

Creates the D1 database and R2 bucket if missing, records the D1 ID, generates `PROVIDER_CREDENTIAL_KEY` if `.env` has none, uploads the secrets as Worker secrets and applies migrations. Safe to re-run. Copy the generated `PROVIDER_CREDENTIAL_KEY` from `.env` to your password manager.

```bash
npm run deploy:self
```

Asks for confirmation, then type-checks, builds, migrates and deploys. Then add a **custom domain** under the Worker's **Settings → Domains & Routes**.

`npm run secrets:push` uploads secrets after you change them in `.env`. It only uploads: to remove a secret, delete it in the dashboard or run `npx wrangler secret delete NAME`.

## 4. First-run setup

Open the app on its **final HTTPS hostname** (passkeys are bound to it).

1. Enter the **primary mailbox address** (for example `hello@example.com`; its domain becomes the primary mail domain) and your `AUTH_SETUP_TOKEN`, then register the owner passkey.
2. In **Email administration**, set an administrator password (4–32 characters).
3. Sign in again as `admin@<app hostname>` (for example `admin@mail.example.com`) with the password and your passkey. Sensitive admin actions ask for a fresh passkey check.
4. Delete the `AUTH_SETUP_TOKEN` secret: **Worker → Settings → Variables & Secrets**, or `npx wrangler secret delete AUTH_SETUP_TOKEN`. (Also remove it from `.env` if you use one.)
5. Open **Admin → Keys**. *Push notification keys* should read "Created and stored automatically". If the page asks for `PROVIDER_CREDENTIAL_KEY`, add that Worker secret first. Add Gmail or Resend keys here when you need them.

## Upgrading an existing instance

1. Back up D1 **and** R2, and test a restore.
2. Merge the new version into `main` (or run `npm run deploy:self`). Migrations are additive and apply during the deploy.
3. Check the deploy log, then sign in and open the admin panel.

From v2 to v3:

- The existing primary mailbox and domain are adopted automatically; there is no first-run setup. `admin@<mail domain>` keeps working when the app is on a subdomain of the mail domain.
- Set the app name under **Branding** and sender names under **Mailboxes**, and re-enter forwarding or automatic purge under **Mail settings** if you used them.
- These Worker settings are no longer read and can be deleted: `PRIMARY_ADDRESS`, `FORWARD_TO`, `MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `MAX_MAILBOXES`, `APP_ORIGIN`, `ADMIN_ADDRESS`. If `CF_EMAIL_SENDING_ACCOUNT_ID` exists as a **secret**, delete it (deploys set it).
- From v3.06, existing `GOOGLE_*`, `RESEND_*`, `CF_EMAIL_SENDING_TOKEN` and `VAPID_*` Worker secrets are copied into D1 (push subscriptions keep working). Once **Admin → Keys** shows them, you may delete those Worker secrets — but keep them while you might roll back to v2, which reads them. Never delete `PROVIDER_CREDENTIAL_KEY`.

## 5. Route incoming mail

For **each** mail domain:

1. In Cloudflare, enable **Email Routing** for the zone and review the MX/TXT records it adds.
2. Set the **catch-all** rule to *Send to a Worker* → this Worker. Unknown or disabled addresses are rejected by the app; catch-all does not create inboxes.
3. In **Admin → Domains**, add the domain (the primary one already exists), run **Check DNS**, then **Activate**. Activation requires MX records pointing to Cloudflare.
4. Create mailboxes in **Admin → Mailboxes**, then test mail from an external provider, including a plus alias and an unregistered address.

## 6. Outbound sending

- **Cloudflare (default):** onboard each mail domain for **Email Sending** in the same Cloudflare account. That's all: the Worker sends through its built-in `EMAIL` binding, which needs no token, and every active mailbox on an active domain can send. (Optionally add an Email Sending API token in **Admin → Keys** to use the REST API instead.) Check Cloudflare's terms cover your use.
- **Resend (optional, per domain):** verify the domain in Resend, add `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` in **Admin → Keys**, add the webhook URL shown in **Admin → Domains**, and switch the domain to Resend. Mail for that domain then passes through Resend. Hard bounces and complaints are blocked automatically (**Admin → Deliverability**).
- A domain can also be **receive-only**.

Outbound sending always applies server-side mailbox authorization, rate and daily limits, idempotency and quota checks; the From address is never taken from the client.

### Unsubscribing from received mail

The **Unsubscribe** control appears on any open message. It uses `List-Unsubscribe` headers first, then likely unsubscribe links in the body, and opens an explanation dialog; links are only followed when you click them and must be HTTPS or mailto. It cannot be guaranteed for every sender.

## 7. Make it yours

All from the admin panel, stored in D1:

- **Branding:** app name, short name, app icon (resized in your browser), accent colour, default theme and icon set.
- **Lock:** which appearance options users may change.
- **Per-domain theme:** mailboxes on a domain use that domain's theme, so the look switches with the mailbox.
- **Mail settings:** forwarding of primary-mailbox mail, mailbox limit, automatic purge of deleted mailboxes (leave off until restores are tested).
- **Mailboxes:** display name, sender name, quota, colour, passwords.

Users get **Settings → Appearance** for anything you leave unlocked.

## Optional integrations

**Gmail.** Create a Google Cloud **Web application** OAuth client, enable the Gmail API, and add the redirect URI `https://<app hostname>/api/accounts/gmail/callback`. Enter the client ID and secret in **Admin → Keys** (`PROVIDER_CREDENTIAL_KEY` must be set), then use **Add Inbox → Gmail**. Scopes: `gmail.modify`, `userinfo.profile`, `contacts.readonly`.

**Push notifications.** Nothing to configure: the VAPID key pair is generated on first use and stored encrypted in D1 (an existing `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` Worker secret pair is kept and copied in). The VAPID contact is the primary mailbox address.

## Validate the deployment

- [ ] The build and deploy completed for the expected commit; D1 has the migrations, R2 is bound as `MAIL`.
- [ ] Admin sign-in requires password **and** passkey; a mailbox session cannot reach `/api/admin/*` or `/api/mailboxes/*`.
- [ ] Sensitive admin changes prompt for a passkey and appear in **Security activity**.
- [ ] Mail to each active domain arrives; unknown and disabled addresses are rejected.
- [ ] Sending, replying and forwarding with attachments work from each domain's transport.
- [ ] **Admin → Keys** shows the push keys and any Gmail/Resend keys as stored; Gmail and push work if enabled; the app installs as a PWA.
- [ ] D1 **and** R2 backups exist and a restore has been tested.
- [ ] `AUTH_SETUP_TOKEN` has been removed, and `PROVIDER_CREDENTIAL_KEY` is saved somewhere outside Cloudflare.

## Troubleshooting

| Symptom | Likely cause / action |
| --- | --- |
| First-run setup is not offered | `AUTH_SETUP_TOKEN` is not set, or the instance is already set up (it has a primary domain or an owner passkey). |
| `Invalid credentials` as admin | Use `admin@<app hostname>`, and check the admin password was set. |
| Passkey fails after changing hostnames | Passkeys are bound to the hostname; use the original host. |
| Mail never arrives | Check Email Routing MX records, the catch-all → Worker rule, that the domain is **active** in Admin → Domains, and that the mailbox exists and is active. |
| "Cloudflare Email Sending is not available" | The `EMAIL` send binding is missing from the deployed Worker; redeploy with the rendered `wrangler.jsonc`. |
| Sending fails with an entitlement or domain error | Onboard the domain for Email Sending in the same account, or switch the domain to Resend. |
| `redirect_uri_mismatch` from Google | Add the exact callback URI to the OAuth client. |
| Build cannot resolve D1 | Run `npm run setup`, set `D1_DATABASE_ID`, or check the deploy token's D1 and Workers Scripts permissions. |
| Deploy fails with `Missing required configuration: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN` | Add both as GitHub repository secrets (Option A), build variables (Option B) or in `.env` (Option C). |
| Workers Builds fails before starting: "build token … deleted or rolled" | Create a new token from the **API token** dropdown under **Settings → Build**; if it keeps failing, deploy with GitHub Actions (Option A). |
| Admin → Keys asks for `PROVIDER_CREDENTIAL_KEY`, or push / Gmail are unavailable | Add `PROVIDER_CREDENTIAL_KEY` as a Worker secret (step 2); push keys are then created on the next page load. |
| A key in Admin → Keys cannot be edited | It is also set as a Worker secret, which wins. Delete that Worker secret; the value stays in D1. |
| Stored keys or Gmail stopped working after a secret change | `PROVIDER_CREDENTIAL_KEY` was changed. Restore the original value, or re-enter the keys and reconnect Gmail. |

## Development

```bash
npm run dev
```

```bash
npm test
```

`npm run dev` renders a local `wrangler.jsonc` and starts Vite with the Worker; apply local migrations first with `npm run db:migrate:local`. `npm test` runs every regression script, including the CSS token guard and the default-theme equivalence check. GitHub Actions validate and scan version branches (`vX.XX`); production deploys only from `main`. Deliberate visual changes to the v2.08 layout go in `src/client/layout-fixes.css`, which the equivalence check leaves out.

## Repository layout

```text
src/client/                   React/TypeScript/PWA interface (theme tokens in src/client/theme/)
src/worker/index.ts           Worker fetch, email and scheduled handlers
src/worker/config.ts          Request-derived origin, passkey RP ID and admin sign-in
src/worker/domains.ts         Domains, first-run setup, address rules
src/worker/branding.ts        Branding, lock, preferences, app icon
src/worker/storedKeys.ts      Admin → Keys: integration keys encrypted in D1, VAPID generation
src/worker/transports/        Cloudflare Email Sending API and Resend transports
src/worker/webhooks/          Signed Resend delivery webhooks
src/worker/email/             Inbound storage and outbound sending
migrations/                   Ordered D1 schema migrations
config/schema.mjs             Secret and deploy keys (.env.example is generated from it)
scripts/                      Setup, render, deploy guards and regression tests
.github/workflows/            Validation and security scans for version branches; production deploy from main
docs/v3/                      v3 design, status and self-hosting notes
```

Further reading: [v3 roadmap and decisions](./docs/v3/README.md) · [implementation status](./docs/v3/V3_IMPLEMENTATION_STATUS.md) · [deployment hostnames and passkeys](./docs/DEPLOYMENT_DOMAINS.md) · [admin authentication](./docs/multi-mailbox/ADMIN_MFA.md) · [security audit](./docs/SECURITY_AUDIT_v2.07.md).

## Security reports

Do not publish exploit details in a public issue; follow [SECURITY.md](./SECURITY.md).

## License

Copyright © 2026 Sanghyuk Mo. Free self-hosting for personal and internal organizational use (including commercial organizations) with the attribution credit kept visible; no redistribution, no hosting for others, no paid services. See [LICENSE](./LICENSE).
