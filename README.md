# LTM Email Service

**Private webmail you host on Cloudflare**: React PWA, Workers, D1, R2 and passkeys, with optional Gmail and Resend.

> **License.** Free to run your own instance (personal or inside your organization, including commercially) with the "Powered by LTM Email Service" credit visible. Forking on GitHub to run and update your instance is allowed; keep the fork unmodified. No redistribution, published modifications, hosting for others or paid access. See [LICENSE](./LICENSE).

## How it works

A web app, not a mail server (no IMAP/SMTP). Cloudflare Email Routing hands incoming mail to the Worker, which indexes it in D1 and stores raw messages and attachments in R2. Outgoing mail goes through Cloudflare Email Sending, or Resend per domain. Gmail accounts connect through Google OAuth.

Everything about your instance (domains, mailboxes, branding, keys) lives in D1 and is managed in the app. The only Worker secret, `PROVIDER_CREDENTIAL_KEY`, is created for you at setup.

## Setup

You need a Cloudflare account with your mail domain on Cloudflare DNS, and a device with a passkey. Sending through Cloudflare needs the Workers Paid plan (or use Resend).

### 1. Fork and deploy

1. **Fork** this repository on GitHub (keep the name and the `main` branch).
2. In Cloudflare: **Workers & Pages → Create → Import a repository**, pick your fork, then set **Build command** `npm run build` and **Deploy command** `npm run deploy`. Deploy. The database and storage are created on the first deploy; no keys needed.
3. Optional: add your own address (Worker → **Settings → Domains & Routes → Custom domain**). Do this before setup: passkeys are tied to the address.

Keep your fork unmodified: every setting lives in the app, and an unmodified fork updates cleanly.

<details>
<summary>Other ways to deploy</summary>

**Deploy button** (a private copy that does not receive updates): [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LiamTheMo/LTM-Email-Service). Then make the GitHub copy private (**Settings → Danger Zone → Change visibility**).

**GitHub Actions** instead of Cloudflare's builds: in your fork, enable Actions, set the repository variable `DEPLOY_WITH_ACTIONS` to `true`, create a D1 database `ltm-email-service` and an R2 bucket `ltm-email-service-mail`, and add the repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (the *Edit Cloudflare Workers* token template plus **D1: Edit**). Every push to `main` deploys.

**From your computer** (Node.js 22+):

```bash
git clone https://github.com/LiamTheMo/LTM-Email-Service.git my-mail && cd my-mail
npm ci && cp config/env.example .env   # fill in CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
npm run setup && npm run deploy:self
```

**With an AI coding agent**, paste:

```text
Deploy LTM Email Service (https://github.com/LiamTheMo/LTM-Email-Service) to my
Cloudflare account from my fork of it. Ask me for my Cloudflare account ID and a
deploy API token (Workers Scripts, D1 and Workers R2 Storage: Edit; Account
Settings: Read) through a secret input; never print, commit or pass them as
arguments. Run npm ci, copy config/env.example to .env, add both values, then run
npm run setup and npm run deploy:self -- --yes. Give me the URL; I will finish
setup in the browser.
```

</details>

### 2. First-run setup

Open the app and fill in one page:

1. **Mail domain**, for example `example.com`. This creates `admin@example.com`, your mailbox and admin sign-in.
2. **Admin password** (4–32 characters).
3. **Cloudflare API token.** Use **Create a Cloudflare token**, add **Email Sending: Edit** and **Email Routing Rules: Edit**, then create and paste the token.

**Continue** sets up mail routing, sending and DMARC for your domain, and shows your encryption key once. **Save it in a password manager.** Then tap **Create administrator passkey** and you're in.

After that, sign in as `admin@<your domain>` with your password and passkey. **Admin panel** is in the sidebar.

### 3. More domains and mailboxes

**Admin → Domains → Add domain** sets the domain up in Cloudflare and activates it. If the domain still receives mail elsewhere, you're asked before its MX records are replaced. Create mailboxes in **Admin → Mailboxes**.

<details>
<summary>Without a Cloudflare token</summary>

Set an `AUTH_SETUP_TOKEN` Worker secret and choose **Use the setup secret instead** at setup. Then, for each domain in Cloudflare:

1. Turn on **Email Routing**, and set the **catch-all** rule to **Send to a Worker** → this Worker.
2. Onboard the domain for **Email Sending**.
3. In **Admin → Domains**: add it, **Check DNS**, **Activate**.

Without a token, also add `PROVIDER_CREDENTIAL_KEY` (32 random bytes, base64url) as a Worker secret before storing keys.

</details>

## Where settings live

| Setting | Where |
| --- | --- |
| Domains, mailboxes, branding, themes, forwarding, limits | The admin panel |
| Cloudflare token, Google OAuth, Resend, Email Sending API token | **Admin → Keys** (encrypted) |
| `PROVIDER_CREDENTIAL_KEY` | Worker secret, created at setup. **Keep a copy:** losing it makes stored keys and Gmail connections unreadable (mail is unaffected) |
| Push notification keys | Automatic |
| Deploy token and account ID | Not needed for a fork deployed by Cloudflare; GitHub secrets or `.env` otherwise |
| Worker, database and bucket names | `wrangler.jsonc` |

## Features

- **All inboxes:** with two or more accounts on a device, one merged list; actions always apply to the message's own account.
- **Junk filtering** on every mailbox: upstream spam flags, failed sender authentication and scam signals. **Not junk** restores.
- **Block senders** per mailbox, by address or domain (Settings → Blocked senders, or **Block** in the reader).
- **Native reader:** ordinary mail follows your theme; designed newsletters keep their look. Remote images and scripts are always blocked.
- **Unsubscribe** from list mail, **profile photos** per mailbox, **branding** and per-domain themes, installable **PWA** with push.

## Optional integrations

- **Gmail:** create a Google OAuth *Web application* client with the Gmail API enabled and redirect URI `https://<app address>/api/accounts/gmail/callback`. Add its ID and secret in **Admin → Keys**, then **Add Inbox → Gmail**.
- **Resend** (per domain): verify the domain in Resend, add `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` in **Admin → Keys**, add the webhook URL shown in **Admin → Domains**, and switch the domain's sending to Resend.

## Updates

The admin panel shows when a new version is out. To update, open your fork on GitHub and choose **Sync fork → Update branch**. Cloudflare redeploys, and the app updates its database on the first request. Back up D1 and R2 before big updates. Version notes: [docs/UPGRADING.md](./docs/UPGRADING.md).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Token "cannot see the Worker that runs this app" | Create it in the same Cloudflare account, with **Workers Scripts: Edit**, and paste the token value (not its ID). |
| A domain step says "The token needs …" | Add that permission to the token in Cloudflare, then **Re-check Cloudflare setup** in Admin → Domains. |
| Email Sending step fails | Needs the Workers Paid plan and no other provider's MX records. Or use Resend. |
| Mail doesn't arrive | Check the domain is **active** in Admin → Domains and the mailbox exists. With a token, **Re-check Cloudflare setup** repairs routing. |
| Admin sign-in fails | Use `admin@<mail domain>`. Passkeys only work on the address you set up on. |
| Keys or Gmail stopped working | `PROVIDER_CREDENTIAL_KEY` changed. Restore the saved value. |
| A key in Admin → Keys can't be edited | A Worker secret with the same name wins. Delete the Worker secret; the value stays stored. |
| `redirect_uri_mismatch` from Google | Add the exact callback URI to the OAuth client. |
| Deploy says `Missing required configuration` | Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub secrets or in `.env`. |
| Workers Builds: "build token … deleted or rolled" | Pick a new token under Worker → **Settings → Build**, or deploy with GitHub Actions. |

## Development

```bash
npm ci
npm run dev    # Vite + Worker; the app migrates its local database
npm test       # all regression checks
npm run test:e2e  # real Worker + Chromium end-to-end suites
```

Branches: `main` deploys to production; work happens on version branches `vX.XX`. Visual changes to the original layout go in `src/client/layout-fixes.css`. Setup with a Cloudflare token needs the deployed app.

<details>
<summary>Repository layout</summary>

```text
src/client/            React PWA (theme tokens in src/client/theme/)
src/worker/            Worker: API, email handler, scheduled jobs
src/worker/cloudflare/ Cloudflare token: ownership check, encryption key, domain setup
migrations/            D1 migrations (applied by deploys and by the app)
wrangler.jsonc         Worker config, also the Deploy button's source (no account IDs)
config/                Deploy key schema; env.example is generated from it
scripts/               Setup, deploy guards and tests
docs/                  Upgrade notes, design records, security notes
```

</details>

More: [updates](./docs/UPGRADING.md) · [hostnames and passkeys](./docs/DEPLOYMENT_DOMAINS.md) · [admin sign-in](./docs/multi-mailbox/ADMIN_MFA.md) · [v3 status](./docs/v3/V3_IMPLEMENTATION_STATUS.md) · [security](./SECURITY.md)

## License

© 2026 Sanghyuk Mo. Self-hosting license; see [LICENSE](./LICENSE).
