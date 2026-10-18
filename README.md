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

**There is no instance configuration in the Worker.** The app's address and the admin sign-in come from the URL it is served on. The primary mailbox, mail domains, branding, themes, forwarding and limits are stored in D1 and managed from the app. The only things you configure outside the app are a few Worker **secrets** and the Cloudflare **deploy keys**: in the Cloudflare dashboard for automatic deploys from `main`, or in a local `.env` file for command-line deploys (step 2). Nothing secret is committed.

## Before you start

- A Cloudflare account with **Workers, D1, R2, Email Routing and Email Sending**. Check each product's availability, quotas and billing; a free deployment is not guaranteed.
- A mail domain on **Cloudflare DNS** (for example `example.com`), and a hostname for the app (for example `mail.example.com`).
- Node.js **22 or later** (CI uses 24) and npm.
- A passkey-capable device and browser. WebAuthn requires HTTPS on real domains.
- Optionally: a Google Cloud OAuth client (Gmail), a VAPID keypair (push), a Resend account.

Use fresh D1/R2 resources for a new installation, and back up both D1 **and** R2 before changing an existing one.

## 1. Get the code

Clone into a **private** location; publishing a public fork with changes is redistribution under the licence.

```bash
git clone https://github.com/LiamTheMo/LTM-Email-Service.git my-mail
cd my-mail
npm ci
```

## 2. Know where each setting goes

Nothing secret is ever committed. Depending on how you deploy, keys live in one of these places:

| Key | Automatic deploys (Workers Builds; for GitHub Actions see Option A2) | Command-line deploys |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | **Workers Builds → Build variables** (plain text) | `.env` |
| `CLOUDFLARE_API_TOKEN` — deploy token: Workers Scripts edit, D1 edit, R2 edit, Account Settings read | **Workers Builds → Build variables** (mark as **secret**) | `.env` |
| `AUTH_SETUP_TOKEN` — one-time first-run secret | **Worker → Settings → Variables & Secrets** (type **Secret**) | `.env` |
| `PROVIDER_CREDENTIAL_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Gmail only | **Worker → Variables & Secrets** (Secret) | `.env` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — push only | **Worker → Variables & Secrets** (Secret) | `.env` |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` — Resend only | **Worker → Variables & Secrets** (Secret) | `.env` |
| `CF_EMAIL_SENDING_TOKEN` — optional; sending works without it | **Worker → Variables & Secrets** (Secret) | `.env` |
| `WORKER_NAME`, `D1_DATABASE_NAME`, `R2_BUCKET_NAME`, `D1_DATABASE_ID` — optional, sensible defaults | Build variables, only if you change the defaults | `.env` |
| Primary mailbox, domains, branding, themes, forwarding, limits | **The app itself** (first-run setup and the admin panel, stored in D1) | Same |

**Build variables are not runtime secrets.** Build variables are only visible while Cloudflare builds and deploys the code; the running app cannot read them. Gmail, push, Resend, setup and sending keys must go under the **Worker's own Variables & Secrets**, as type **Secret** — a plain "Text" variable added in the dashboard is removed on the next deploy, while secrets persist across every deploy.

Generate strong random values locally, for example:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Keep `PROVIDER_CREDENTIAL_KEY` backed up: changing it makes stored Gmail credentials unreadable.

## 3. Deploy

### Option A — automatic deploys from `main` (Cloudflare Workers Builds, no `.env`)

1. In the Cloudflare dashboard, create a **D1 database** named `ltm-email-service` and an **R2 bucket** named `ltm-email-service-mail` (or other names, set as build variables).
2. **Workers & Pages → Create → Import a repository**, pick your private copy of this repository, and name the Worker `ltm-email-service` (or set `WORKER_NAME`).
3. In the Worker's **Settings → Build**:
   - Production branch: `main`. Disable preview builds on other branches unless you give them their own database and bucket.
   - Build command: `npm run build:cloudflare`
   - Deploy command: `npm run deploy`
   - **Build variables:** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (as a secret).
4. Push or merge to `main`. The build renders `wrangler.jsonc`, finds the D1 database, applies migrations and deploys. `npm run deploy` refuses to run anywhere except a deploy from `main` (Workers Builds or the GitHub Actions workflow).
5. In the Worker's **Settings → Variables & Secrets**, add `AUTH_SETUP_TOKEN` (and any optional secrets from the table) as type **Secret**. Secrets take effect immediately and survive later deploys.
6. Under **Settings → Domains & Routes**, add your custom domain (for example `mail.example.com`).

Every later merge to `main` deploys automatically; nothing else needs to be set again.

### Option A2 — automatic deploys from `main` (GitHub Actions)

Use this instead of Workers Builds, not alongside it (otherwise each merge deploys twice). `.github/workflows/deploy.yml` builds, applies migrations and deploys on every push to `main`; it never runs for other branches.

1. Create the D1 database and R2 bucket as in Option A step 1, and a Worker named `ltm-email-service` (or set `WORKER_NAME`). If the Worker is connected to Git under **Settings → Build**, disconnect it.
2. In GitHub: **Settings → Environments → New environment** `production`. Under **Deployment branches and tags**, choose **Selected branches** and add `main`.
3. In that environment, add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Push or merge to `main`, or run **Actions → Deploy production → Run workflow** on `main`.
5. Continue with Option A steps 5 and 6. Runtime secrets still go in the Worker's **Variables & Secrets**, never in GitHub.

### Option B — deploy from your computer (`.env`)

```bash
cp .env.example .env
```

Fill in `.env` (it is gitignored), then:

```bash
npm run setup
```

Creates the D1 database and R2 bucket if missing, records the D1 ID in `.env`, renders `wrangler.jsonc` (generated, gitignored), uploads the secrets as Worker secrets and applies migrations. Safe to re-run.

```bash
npm run deploy:self
```

Asks for confirmation, then type-checks, builds, migrates and deploys. Add a **custom domain** for the Worker in the dashboard.

After adding or changing a secret in `.env`, run `npm run secrets:push` to upload it. You can also use this to upload secrets for an Option A install instead of typing them into the dashboard. It only uploads: to remove a secret, delete it in the dashboard or run `npx wrangler secret delete NAME`.

## 4. First-run setup

Open the app on its **final HTTPS hostname** (passkeys are bound to it).

1. Enter the **primary mailbox address** (for example `hello@example.com`; its domain becomes the primary mail domain) and your `AUTH_SETUP_TOKEN`, then register the owner passkey.
2. In **Email administration**, set an administrator password (4–32 characters).
3. Sign in again as `admin@<app hostname>` (for example `admin@mail.example.com`) with the password and your passkey. Sensitive admin actions ask for a fresh passkey check.
4. Delete the `AUTH_SETUP_TOKEN` secret: **Worker → Settings → Variables & Secrets**, or `npx wrangler secret delete AUTH_SETUP_TOKEN`. (Also remove it from `.env` if you use one.)

An instance upgraded from v2 skips step 1: its existing primary mailbox and domain are adopted automatically, and `admin@<mail domain>` keeps working when the app is on a subdomain of the mail domain.

## 5. Route incoming mail

For **each** mail domain:

1. In Cloudflare, enable **Email Routing** for the zone and review the MX/TXT records it adds.
2. Set the **catch-all** rule to *Send to a Worker* → this Worker. Unknown or disabled addresses are rejected by the app; catch-all does not create inboxes.
3. In **Admin → Domains**, add the domain (the primary one already exists), run **Check DNS**, then **Activate**. Activation requires MX records pointing to Cloudflare.
4. Create mailboxes in **Admin → Mailboxes**, then test mail from an external provider, including a plus alias and an unregistered address.

## 6. Outbound sending

- **Cloudflare (default):** onboard each mail domain for **Email Sending** in the same Cloudflare account. That's all: the Worker sends through its built-in `EMAIL` binding, which needs no token, and every active mailbox on an active domain can send. (Optionally set `CF_EMAIL_SENDING_TOKEN` to use the REST API instead.) Check Cloudflare's terms cover your use.
- **Resend (optional, per domain):** verify the domain in Resend, add `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` as Worker secrets (see step 2), add the webhook URL shown in **Admin → Domains**, and switch the domain to Resend. Mail for that domain then passes through Resend. Hard bounces and complaints are blocked automatically (**Admin → Deliverability**).
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

**Gmail.** Create a Google Cloud **Web application** OAuth client, enable the Gmail API, and add the redirect URI `https://<app hostname>/api/accounts/gmail/callback`. Add the three Gmail keys as Worker secrets (see step 2), then use **Add Inbox → Gmail**. Scopes: `gmail.modify`, `userinfo.profile`, `contacts.readonly`.

**Push notifications.** Add a VAPID keypair as Worker secrets (see step 2). The VAPID contact is the primary mailbox address.

## Validate the deployment

- [ ] The build and deploy completed for the expected commit; D1 has the migrations, R2 is bound as `MAIL`.
- [ ] Admin sign-in requires password **and** passkey; a mailbox session cannot reach `/api/admin/*` or `/api/mailboxes/*`.
- [ ] Sensitive admin changes prompt for a passkey and appear in **Security activity**.
- [ ] Mail to each active domain arrives; unknown and disabled addresses are rejected.
- [ ] Sending, replying and forwarding with attachments work from each domain's transport.
- [ ] Gmail and push work if enabled; the app installs as a PWA.
- [ ] D1 **and** R2 backups exist and a restore has been tested.
- [ ] `AUTH_SETUP_TOKEN` has been removed.

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

## Development

```bash
npm run dev
```

```bash
npm test
```

`npm run dev` renders a local `wrangler.jsonc` and starts Vite with the Worker; apply local migrations first with `npm run db:migrate:local`. `npm test` runs every regression script, including the CSS token guard and the default-theme equivalence check. GitHub Actions validate and scan version branches (`vX.XX`); production deploys only from `main`.

## Repository layout

```text
src/client/                   React/TypeScript/PWA interface (theme tokens in src/client/theme/)
src/worker/index.ts           Worker fetch, email and scheduled handlers
src/worker/config.ts          Request-derived origin, passkey RP ID and admin sign-in
src/worker/domains.ts         Domains, first-run setup, address rules
src/worker/branding.ts        Branding, lock, preferences, app icon
src/worker/transports/        Cloudflare Email Sending API and Resend transports
src/worker/webhooks/          Signed Resend delivery webhooks
src/worker/email/             Inbound storage and outbound sending
migrations/                   Ordered D1 schema migrations
config/schema.mjs             Secret and deploy keys (.env.example is generated from it)
scripts/                      Setup, render, deploy guards and regression tests
docs/v3/                      v3 design, status and self-hosting notes
```

Further reading: [v3 roadmap and decisions](./docs/v3/README.md) · [implementation status](./docs/v3/V3_IMPLEMENTATION_STATUS.md) · [deployment hostnames and passkeys](./docs/DEPLOYMENT_DOMAINS.md) · [admin authentication](./docs/multi-mailbox/ADMIN_MFA.md) · [security audit](./docs/SECURITY_AUDIT_v2.07.md).

## Security reports

Do not publish exploit details in a public issue; follow [SECURITY.md](./SECURITY.md).

## License

Copyright © 2026 Sanghyuk Mo. Free self-hosting for personal and internal organizational use (including commercial organizations) with the attribution credit kept visible; no redistribution, no hosting for others, no paid services. See [LICENSE](./LICENSE).
