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

**There is no instance configuration in the Worker.** The app's address comes from the URL it is served on. The admin's mailbox (`admin@<mail domain>`), mail domains, branding, themes, forwarding, limits and integration keys are stored in D1 and managed from the app. First-run setup takes one Cloudflare API token and does the rest: it creates the encryption key (`PROVIDER_CREDENTIAL_KEY`, the only Worker secret), stores the token encrypted, and sets up mail routing and sending for your domain. Nothing secret is committed.

## Before you start

- A Cloudflare account with your mail domain on **Cloudflare DNS** (for example `example.com`). Workers, D1, R2 and Email Routing work on the free plan; **sending** through Cloudflare needs the Workers Paid plan (or use Resend). Check each product's terms and quotas.
- A device with a passkey (phone, laptop or security key). Passkeys are tied to the address you set up on, so decide first whether to use the `workers.dev` address or your own, for example `mail.example.com`.
- A GitHub account for the one-click deploy, or Node.js 22+ to deploy from your computer.

Use fresh D1/R2 resources for a new installation, and back up both D1 **and** R2 before changing an existing one.

## 1. Deploy

Pick one way and use only that one. Every way deploys **only from `main`**.

### Option A — Deploy to Cloudflare (one click)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LiamTheMo/LTM-Email-Service)

1. Click the button and sign in to Cloudflare and GitHub. Keep the suggested names or change them. Cloudflare copies this repository to your GitHub account, creates the D1 database and R2 bucket, then builds and deploys. It asks for no keys.
2. **Make your copy private right away:** on GitHub, open the new repository → **Settings → General → Danger Zone → Change visibility → Private**. The licence does not allow a public copy.
3. Optional: to use your own address, open the Worker → **Settings → Domains & Routes → Add → Custom domain** (for example `mail.example.com`) before first-run setup.

Every push to `main` of your copy redeploys it, and the app applies database migrations itself on its first request.

### Option B — GitHub Actions

`.github/workflows/deploy.yml` builds, applies database migrations and deploys on every push to `main` of your own (private) repository. Use this if you would rather not use Workers Builds.

1. Import this repository into a private repository of your own.
2. In Cloudflare, create a **D1 database** named `ltm-email-service` and an **R2 bucket** named `ltm-email-service-mail` (or change the names in `wrangler.jsonc`).
3. Create a deploy token (**My Profile → API Tokens → Create Token → Edit Cloudflare Workers** template, plus **D1: Edit**). In GitHub: **Settings → Secrets and variables → Actions → New repository secret**, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Push to `main`, or run **Actions → Deploy production → Run workflow**.
5. Optional: add a custom domain as in Option A, step 3.

### Option C — from your computer

```bash
git clone https://github.com/LiamTheMo/LTM-Email-Service.git my-mail
cd my-mail
npm ci
cp config/env.example .env
```

Fill in `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in `.env` (gitignored), then:

```bash
npm run setup      # creates the D1 database and R2 bucket, applies migrations
npm run deploy:self
```

Both are safe to re-run, and leave the committed `wrangler.jsonc` unchanged.

## 2. First-run setup

Open the app on its final address and fill in one page:

1. **Mail domain**, for example `example.com`. This creates **admin@example.com**, your own mailbox and the administrator sign-in.
2. **Administrator password** (4–32 characters).
3. **Cloudflare API token.** **Create a Cloudflare token** opens Cloudflare's form with most permissions already selected; add **Email Sending: Edit** and **Email Routing Rules: Edit**, create the token and paste it. All permissions: Account · Workers Scripts: Edit, Account · Email Sending: Edit, Zone · Zone: Read, Zone · Zone Settings: Edit, Zone · DNS: Edit, Zone · Email Routing Rules: Edit.

**Continue** checks the token belongs to the Cloudflare account that runs this app, then:

- creates `PROVIDER_CREDENTIAL_KEY` (the key that encrypts stored keys and Gmail connections) as a Worker secret and **shows it once**. Save it in your password manager.
- turns on Email Routing for your domain, sends its catch-all to this app, sets the domain up for Email Sending, and adds a monitoring DMARC record. Each step is listed with its result. If the domain still receives mail elsewhere, nothing is changed; finish it later in **Admin → Domains**.

Then tap **Create administrator passkey**. You are signed in to the mail app. From then on, sign in as `admin@<mail domain>` with your password and passkey; **Admin panel** in the sidebar opens the administration pages. The token stays encrypted in **Admin → Keys**, where you can replace or remove it.

Without a token: set an `AUTH_SETUP_TOKEN` Worker secret, use **Use the setup secret instead** on the setup page, and follow the manual steps in sections 4 and 5.

### Deploy with an AI coding agent

Paste this into an agent that has a terminal. Give it your Cloudflare account ID and a deploy token through its secret input, never in chat:

```text
Deploy LTM Email Service (https://github.com/LiamTheMo/LTM-Email-Service) to my
Cloudflare account from a private copy of the repository. Ask me for my
Cloudflare account ID and a deploy API token (Workers Scripts Edit, D1 Edit,
Workers R2 Storage Edit, Account Settings Read) through a secret input. Never
print, commit or pass either value as a command-line argument.

Read README.md and wrangler.jsonc first. Run npm ci, copy config/env.example to
.env, put the two values in .env, then run npm run setup and
npm run deploy:self -- --yes. Tell me the deployed URL. I will open it and finish
first-run setup with my own Cloudflare token.
```

## Where each setting goes

| Setting | Where it goes |
| --- | --- |
| Mail domains, mailboxes, branding, themes, forwarding, limits | **The app** (first-run setup and the admin panel) |
| Cloudflare API token (setup and domain wiring) | Pasted at first-run setup or in **Admin → Keys**; stored encrypted |
| `PROVIDER_CREDENTIAL_KEY` | Created by first-run setup as a Worker secret (or `npm run setup`). **Keep a copy outside Cloudflare** |
| Google OAuth client, Resend keys, Cloudflare Email Sending API token | **Admin → Keys** |
| Push notification (VAPID) keys | Nothing to do: created automatically and stored in D1 |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` deploy keys | Option B: GitHub repository secrets. Option C: `.env`. Option A: not needed |
| Worker, database and bucket names | `wrangler.jsonc` (or `WORKER_NAME`, `D1_DATABASE_NAME`, `R2_BUCKET_NAME` next to the deploy keys) |

Changing or losing `PROVIDER_CREDENTIAL_KEY` makes everything in Admin → Keys and every connected Gmail account unreadable; your mail itself is not affected. Setup never replaces an existing key. A Worker secret with the same name as an Admin → Keys entry (for example `RESEND_API_KEY`) still works and takes precedence; the app copies it into D1.

## Upgrading an existing instance

1. Back up D1 **and** R2, and test a restore.
2. Merge the new version into `main` (or run `npm run deploy:self`). Migrations are additive; deploys apply them, and the app applies any that are still pending on its first request.
3. Check the deploy log, then sign in and open the admin panel.

From v3.12, existing instances can connect a Cloudflare token in **Admin → Keys** to set up new domains automatically. `AUTH_SETUP_TOKEN` is no longer needed once setup is done, and `.env.example` moved to `config/env.example`.

From v2 to v3:

- The existing mailbox and its domain are adopted automatically; there is no first-run setup.
- Set the app name under **Branding** and sender names under **Mailboxes**, and re-enter forwarding or automatic purge under **Mail settings** if you used them.
- These Worker settings are no longer read and can be deleted: `PRIMARY_ADDRESS`, `FORWARD_TO`, `MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `MAX_MAILBOXES`, `APP_ORIGIN`, `ADMIN_ADDRESS`. If `CF_EMAIL_SENDING_ACCOUNT_ID` exists as a **secret**, delete it (deploys set it).
- From v3.06, existing `GOOGLE_*`, `RESEND_*`, `CF_EMAIL_SENDING_TOKEN` and `VAPID_*` Worker secrets are copied into D1 (push subscriptions keep working). Once **Admin → Keys** shows them, you may delete those Worker secrets — but keep them while you might roll back to v2, which reads them. Never delete `PROVIDER_CREDENTIAL_KEY`.
- From v3.08 there is no "primary mailbox". An `admin@<mail domain>` mailbox is created on the first request after the deploy and becomes the administrator's starting inbox. The former primary mailbox keeps its address and mail and becomes an ordinary mailbox (it can now be disabled or deleted). Postmaster/abuse mail without a chosen mailbox, forwarding (Mail settings), the profile photo and the push contact now belong to admin@.

## 3. More mail domains

**Admin → Domains → Add domain.** With a connected Cloudflare token, adding a domain also sets it up (Email Routing, delivery to this app, Email Sending, DMARC) and activates it once Cloudflare confirms mail reaches the app. One passkey approval covers it. If the domain still has MX records of another mail service, the app lists them and replaces them only after you confirm. **Set up in Cloudflare** / **Re-check Cloudflare setup** runs the same steps again; it is safe to repeat.

The domain must be a zone (or inside a zone) on Cloudflare DNS in the same account. Create mailboxes in **Admin → Mailboxes**, then test mail from an external provider, including a plus alias and an unregistered address.

## 4. Route incoming mail by hand (without a token)

For **each** mail domain:

1. In Cloudflare, enable **Email Routing** for the zone and review the MX/TXT records it adds.
2. Set the **catch-all** rule to *Send to a Worker* → this Worker. Unknown or disabled addresses are rejected by the app; catch-all does not create inboxes.
3. In **Admin → Domains**, add the domain (the main one from setup already exists), run **Check DNS**, then **Activate**. Activation requires MX records pointing to Cloudflare.

## 5. Outbound sending

- **Cloudflare (default):** each mail domain is onboarded for **Email Sending** in the same Cloudflare account; with a token this happens automatically, otherwise onboard it in the dashboard. The Worker sends through its built-in `EMAIL` binding, which needs no token, and every active mailbox on an active domain can send. (Optionally add an Email Sending API token in **Admin → Keys** to use the REST API instead.) Check Cloudflare's terms cover your use.
- **Resend (optional, per domain):** verify the domain in Resend, add `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` in **Admin → Keys**, add the webhook URL shown in **Admin → Domains**, and switch the domain to Resend. Mail for that domain then passes through Resend. Hard bounces and complaints are blocked automatically (**Admin → Deliverability**).
- A domain can also be **receive-only**.

Outbound sending always applies server-side mailbox authorization, rate and daily limits, idempotency and quota checks; the From address is never taken from the client.

### Unsubscribing from received mail

The **Unsubscribe** control appears on any open message. It uses `List-Unsubscribe` headers first, then likely unsubscribe links in the body, and opens an explanation dialog; links are only followed when you click them and must be HTTPS or mailto. It cannot be guaranteed for every sender.

## 6. Make it yours

All from the admin panel, stored in D1:

- **Branding:** app name, short name, app icon (resized in your browser), accent colour, default theme and icon set.
- **Lock:** which appearance options users may change.
- **Per-domain theme:** mailboxes on a domain use that domain's theme, so the look switches with the mailbox.
- **Mail settings:** forwarding of admin@ mail, mailbox limit, automatic purge of deleted mailboxes (leave off until restores are tested).
- **Mailboxes:** display name, sender name, quota, colour, passwords.

Users get **Settings → Appearance** for anything you leave unlocked.

With two or more accounts signed in on a device, the app opens on **All inboxes** (with one account, it opens that inbox): every account's mail in one list, newest first, each row labelled with its account. Every folder works there, and opening, archiving, deleting, bulk actions and replies always act on the message's own account.

Each custom mailbox can **block senders**: **Block** in the message reader (on phones, in the Unsubscribe dialog) or **Settings → Blocked senders**, by address (`someone@example.com`) or by domain (`example.com`, which includes its subdomains). Mail from a blocked sender goes straight to that mailbox's Junk, with no push notification or forwarding, and the sender is not told; blocking also moves the sender's existing mail to Junk. Gmail accounts use Gmail's own block.

**Junk filtering** is on for every custom mailbox (it can be turned off per mailbox in Admin → Mailboxes). Mail goes to Junk when an upstream filter already flagged it, when sender authentication failed (DMARC, or SPF without a valid DKIM signature; mailing lists are exempt), or when enough content signals add up: scam and phishing wording, links to bare IP addresses, sender names that impersonate another sender, replies redirected to another domain, and similar. Senders the mailbox has written to skip the content checks. Junk is never deleted automatically, so **Not junk** moves a false positive back. Gmail accounts keep Gmail's own spam filtering.

**Reading HTML mail:** ordinary mail is shown natively in the app's theme, with the app's font, theme text colour and accent links, and only colours that would be unreadable on the theme are replaced. Designed mail (newsletters, receipts, anything with coloured or image backgrounds) keeps its own design on a light card, the way native mail apps show it. Either way the message fills the reader, and fixed-width newsletters are scaled down to fit a phone screen. Every email still renders in a sandboxed frame with no scripts, no forms and no remote content (tracking images stay blocked).

**Profile photos:** every custom mailbox can set its own photo (Settings → Edit profile). It shows in the account switcher and next to the mailbox in Admin → Mailboxes; mailboxes without one show their initial.

## Optional integrations

**Gmail.** Create a Google Cloud **Web application** OAuth client, enable the Gmail API, and add the redirect URI `https://<app hostname>/api/accounts/gmail/callback`. Enter the client ID and secret in **Admin → Keys** (`PROVIDER_CREDENTIAL_KEY` must be set), then use **Add Inbox → Gmail**. Scopes: `gmail.modify`, `userinfo.profile`, `contacts.readonly`.

**Push notifications.** Nothing to configure: the VAPID key pair is generated on first use and stored encrypted in D1 (an existing `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` Worker secret pair is kept and copied in). The VAPID contact is the admin@ mailbox address.

## Validate the deployment

- [ ] The build and deploy completed for the expected commit; D1 has the migrations, R2 is bound as `MAIL`.
- [ ] Admin sign-in requires password **and** passkey; a mailbox session cannot reach `/api/admin/*` or `/api/mailboxes/*`.
- [ ] Sensitive admin changes prompt for a passkey and appear in **Security activity**.
- [ ] Mail to each active domain arrives; unknown and disabled addresses are rejected.
- [ ] Sending, replying and forwarding with attachments work from each domain's transport.
- [ ] **Admin → Keys** shows the push keys and any Gmail/Resend keys as stored; Gmail and push work if enabled; the app installs as a PWA.
- [ ] D1 **and** R2 backups exist and a restore has been tested.
- [ ] `PROVIDER_CREDENTIAL_KEY` is saved somewhere outside Cloudflare (setup showed it once), and the GitHub copy of the code is private.

## Troubleshooting

| Symptom | Likely cause / action |
| --- | --- |
| First-run setup is not offered | The instance already has an owner passkey. |
| Setup says the token "cannot see the Worker that runs this app" | Create the token in the Cloudflare account that runs this app, with **Workers Scripts: Edit**; paste the token value, not its ID. Setup must run on the deployed app, not `npm run dev`. |
| A domain step fails with "The token needs …" | Edit the token in Cloudflare and add the named permission (for that zone), then **Re-check Cloudflare setup** in Admin → Domains. |
| "Email Sending" step fails | Sending through Cloudflare needs the Workers Paid plan, and no MX records of another mail service on the domain. Or switch the domain to Resend. |
| `Invalid credentials` as admin | Use `admin@<mail domain>` (or `admin@<app hostname>`), and check the admin password was set. |
| Passkey fails after changing hostnames | Passkeys are bound to the hostname; use the original host. |
| Mail never arrives | Check Email Routing MX records, the catch-all → Worker rule, that the domain is **active** in Admin → Domains, and that the mailbox exists and is active. |
| "Cloudflare Email Sending is not available" | The `EMAIL` send binding is missing from the deployed Worker; redeploy with the committed `wrangler.jsonc`. |
| Sending fails with an entitlement or domain error | Onboard the domain for Email Sending in the same account, or switch the domain to Resend. |
| `redirect_uri_mismatch` from Google | Add the exact callback URI to the OAuth client. |
| Build cannot resolve D1 | Run `npm run setup`, set `D1_DATABASE_ID`, or check the deploy token's D1 and Workers Scripts permissions. |
| Deploy fails with `Missing required configuration: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN` | The D1 database ID is not in `wrangler.jsonc`, so the deploy looks it up: add both as GitHub repository secrets (Option B) or in `.env` (Option C). |
| Workers Builds fails before starting: "build token … deleted or rolled" | Create a new token from the **API token** dropdown under **Settings → Build**; if it keeps failing, deploy with GitHub Actions (Option B). |
| Build log: "Could not apply D1 migrations from the build" | Harmless in Workers Builds: the app applies pending migrations on its first request. |
| Admin → Keys asks for `PROVIDER_CREDENTIAL_KEY`, or push / Gmail are unavailable | Connect a Cloudflare token in Admin → Keys (it creates the key), or add the Worker secret yourself; push keys are then created on the next page load. |
| A key in Admin → Keys cannot be edited | It is also set as a Worker secret, which wins. Delete that Worker secret; the value stays in D1. |
| Stored keys or Gmail stopped working after a secret change | `PROVIDER_CREDENTIAL_KEY` was changed. Restore the original value, or re-enter the keys and reconnect Gmail. |

## Development

```bash
npm run dev
```

```bash
npm test
```

`npm run dev` starts Vite with the Worker using the committed `wrangler.jsonc`; the app applies migrations to the local database itself (or run `npm run db:migrate:local`). First-run setup with a Cloudflare token needs the deployed app. `npm test` runs every regression script, including the CSS token guard and the default-theme equivalence check. GitHub Actions validate and scan version branches (`vX.XX`); production deploys only from `main`. Deliberate visual changes to the v2.08 layout go in `src/client/layout-fixes.css`, which the equivalence check leaves out.

## Repository layout

```text
src/client/                   React/TypeScript/PWA interface (theme tokens in src/client/theme/)
src/worker/index.ts           Worker fetch, email and scheduled handlers
src/worker/config.ts          Request-derived origin, passkey RP ID and admin sign-in
src/worker/domains.ts         Domains, first-run setup, address rules
src/worker/branding.ts        Branding, lock, preferences, app icon
src/worker/storedKeys.ts      Admin → Keys: integration keys encrypted in D1, VAPID generation
src/worker/cloudflare/        Cloudflare token: ownership check, encryption key, domain wiring
src/worker/migrationRunner.ts Applies pending D1 migrations through the Worker's binding
src/worker/transports/        Cloudflare Email Sending API and Resend transports
src/worker/webhooks/          Signed Resend delivery webhooks
src/worker/email/             Inbound storage and outbound sending
migrations/                   Ordered D1 schema migrations
wrangler.jsonc                Worker config; the Deploy button's source (no account IDs)
config/schema.mjs             Secret and deploy keys (config/env.example is generated from it)
scripts/                      Setup, render, deploy guards and regression tests
.github/workflows/            Validation and security scans for version branches; production deploy from main
docs/v3/                      v3 design, status and self-hosting notes
```

Further reading: [v3 roadmap and decisions](./docs/v3/README.md) · [implementation status](./docs/v3/V3_IMPLEMENTATION_STATUS.md) · [deployment hostnames and passkeys](./docs/DEPLOYMENT_DOMAINS.md) · [admin authentication](./docs/multi-mailbox/ADMIN_MFA.md) · [security audit](./docs/SECURITY_AUDIT_v2.07.md).

## Security reports

Do not publish exploit details in a public issue; follow [SECURITY.md](./SECURITY.md).

## License

Copyright © 2026 Sanghyuk Mo. Free self-hosting for personal and internal organizational use (including commercial organizations) with the attribution credit kept visible; no redistribution, no hosting for others, no paid services. See [LICENSE](./LICENSE).
