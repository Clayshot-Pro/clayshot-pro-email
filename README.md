# LTM Email Service

**Private webmail you host on Cloudflare**: React PWA, Workers, D1, R2 and passkeys, with optional Gmail and Resend.

> **License.** Free to run your own instance (personal or inside your organization, including commercially) with the "Powered by LTM Email Service" credit visible. Forking on GitHub to run and update your instance is allowed; keep the fork unmodified. No redistribution, published modifications, hosting for others or paid access. See [LICENSE](./LICENSE).

## How it works

A web app, not a mail server (no IMAP/SMTP). Cloudflare Email Routing hands incoming mail to the Worker, which indexes it in D1 and stores raw messages and attachments in R2. Outgoing mail goes through Cloudflare Email Sending, or Resend per domain. Gmail accounts connect through Google OAuth.

Everything about your instance (domains, mailboxes, branding, keys) lives in D1 and is managed in the app. The deploy creates the Worker secrets for you: `PROVIDER_CREDENTIAL_KEY`, which encrypts stored keys, and on GitHub Actions deploys `CLOUDFLARE_DEPLOY_CONNECTION`.

## Setup

You need a Cloudflare account with your mail domain on Cloudflare DNS, and a device with a passkey. Sending through Cloudflare needs the Workers Paid plan (or use Resend).

### 1. Fork and deploy

1. **Fork** this repository on GitHub (keep the name and the `main` branch), then open the fork's **Actions** tab and enable workflows.
2. In Cloudflare, create an API token from the *Edit Cloudflare Workers* template and add **D1: Edit**. So the app can set up your mail domains with the same token, also add **Zone: Read**, **Zone Settings: Edit**, **DNS: Edit**, **Email Routing Rules: Edit** and **Email Sending: Edit**. Copy your **Account ID** (Workers & Pages → Account details).
3. In the fork: **Settings → Secrets and variables → Actions → New repository secret**, add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Forks do not copy secrets, so this is always needed.
4. **Actions → Deploy production → Run workflow.** The first run creates the D1 database, the R2 bucket and the encryption key (`PROVIDER_CREDENTIAL_KEY`), and hands the deploy token to the app, so **Admin → Keys** shows Cloudflare as connected; the run summary shows the app's address. After that, every push to `main` deploys.
5. Optional: add your own address (Worker → **Settings → Domains & Routes → Custom domain**). Do this before setup: passkeys are tied to the address ([details](./docs/SIGN_IN.md#app-address-and-passkeys)).

Keep your fork unmodified: every setting lives in the app, and an unmodified fork updates cleanly. To use other names, add the repository variables `WORKER_NAME`, `D1_DATABASE_NAME` or `R2_BUCKET_NAME` instead of editing `wrangler.jsonc`.

<details>
<summary>Other ways to deploy</summary>

**Deploy button** (a private copy that does not receive updates): [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LiamTheMo/LTM-Email-Service). Then make the GitHub copy private (**Settings → Danger Zone → Change visibility**).

**From your computer** (Node.js 22.12+):

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
3. **Cloudflare API token**, to prove you own this Cloudflare account. Paste the token you added as `CLOUDFLARE_API_TOKEN`, or use **Create a Cloudflare token**, add **Email Sending: Edit** and **Email Routing Rules: Edit**, then create and paste the token.

**Continue** sets up mail routing, sending and DMARC for your domain. Then tap **Create administrator passkey** and you're in.

Back up the encryption key now: **Admin → Keys → Back up encryption key**, into a password manager (setup shows the key directly only if it had to create it).

After that, sign in as `admin@<your domain>` with your password and passkey ([how sign-in works](./docs/SIGN_IN.md)). **Admin panel** is in the sidebar.

### 3. More domains and mailboxes

**Admin → Domains → Add domain** sets the domain up in Cloudflare and activates it. If the domain still receives mail elsewhere, you're asked before its MX records are replaced. Create mailboxes in **Admin → Mailboxes**.

<details>
<summary>Without a Cloudflare token</summary>

To finish setup without pasting a token, set an `AUTH_SETUP_TOKEN` Worker secret and choose **Use the setup secret instead**.

On a GitHub Actions deploy the app still has the deploy token: if it has the domain permissions from step 1.2, **Admin → Domains** wires your domains (**Add domain**, or **Set up in Cloudflare** / **Re-check Cloudflare setup** on one already listed). With no Cloudflare token at all (a Deploy button or computer deploy, and none connected in **Admin → Keys**), set up each domain in Cloudflare yourself:

1. Turn on **Email Routing**, and set the **catch-all** rule to **Send to a Worker** → this Worker.
2. Onboard the domain for **Email Sending**.
3. In **Admin → Domains**: add it, **Check DNS**, **Activate**.

If **Admin → Keys** says `PROVIDER_CREDENTIAL_KEY` is missing, add it (32 random bytes, base64url) as a Worker secret.

</details>

## Where settings live

| Setting | Where |
| --- | --- |
| Domains, mailboxes, branding, themes, forwarding, limits | The admin panel |
| Cloudflare token | The deploy token, handed over by every GitHub Actions deploy (Worker secret `CLOUDFLARE_DEPLOY_CONNECTION`). A token connected in **Admin → Keys** is used instead |
| Google OAuth, Resend, Email Sending API token | **Admin → Keys** (encrypted) |
| `PROVIDER_CREDENTIAL_KEY` | Worker secret, created by the first deploy (or by setup with a token, or `npm run setup`). **Keep a copy** (**Admin → Keys → Back up encryption key**): losing it makes stored keys and Gmail connections unreadable (mail is unaffected) |
| Push notification keys | Automatic |
| Deploy token and account ID | GitHub repository secrets (`.env` when deploying from your computer) |
| Worker, database and bucket names | `wrangler.jsonc`; other names go in the repository variables `WORKER_NAME`, `D1_DATABASE_NAME`, `R2_BUCKET_NAME` (or `.env`) |

## Features

- **All inboxes:** with two or more accounts on a device, one merged list; actions always apply to the message's own account.
- **Junk filtering** on every mailbox: upstream spam flags, failed sender authentication and scam signals. **Not junk** restores.
- **Block senders** per mailbox, by address or domain (Settings → Blocked senders, or **Block** in the reader).
- **Native reader:** ordinary mail follows your theme; designed newsletters keep their look. Scripts are always blocked. Embedded images show; remote images load privately through the app (senders see Cloudflare, not your IP address). Settings → Images in mail → **Ask first** to approve them per message (per device).
- **Appearance:** Settings → Appearance sets theme, accent colour, density, text size and icon set, within what the admin allows.
- **Notifications:** installable **PWA** with push alerts showing sender, subject and a preview (Settings → Notifications). Admin phones get alerts for every mailbox.
- **Unsubscribe** from list mail, **profile photos** per mailbox, **branding** and per-domain themes.
- **Administration** (Admin panel): Domains; Mailboxes (create, change password, disable, delete with 30-day restore, Recount storage); Mail settings (forward admin@ mail, mailbox limit, automatic purge); Deliverability (suppressed recipients); Keys; Branding (and what users may change); Security activity. Admins see active sessions in Settings → Security & sessions.

## Optional integrations

- **Gmail:** create a Google OAuth *Web application* client with the Gmail API enabled and redirect URI `https://<app address>/api/accounts/gmail/callback`. Add its ID and secret in **Admin → Keys**, then **Add Inbox → Gmail**.
- **Resend** (per domain): verify the domain in Resend, add `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` in **Admin → Keys**, add the webhook URL shown in **Admin → Domains**, and switch the domain's sending to Resend.

## Updates

The admin panel shows when a new version is out. To update, open your fork on GitHub and choose **Sync fork → Update branch**. GitHub Actions redeploys, and the app updates its database on the first request. Back up D1 and R2 before big updates. Version notes: [docs/UPGRADING.md](./docs/UPGRADING.md).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Token "cannot see the Worker that runs this app" | Create it in the same Cloudflare account, with **Workers Scripts: Edit**, and paste the token value (not its ID). |
| A domain step says "The token needs …" | Add that permission to the token in Cloudflare (Admin → Keys says which token is used), then **Re-check Cloudflare setup** in Admin → Domains. No redeploy is needed. |
| Email Sending step fails | Needs the Workers Paid plan and no other provider's MX records. Or use Resend. |
| Mail doesn't arrive | Check the domain is **active** in Admin → Domains and the mailbox exists. With a token, **Re-check Cloudflare setup** repairs routing. |
| Admin sign-in fails | Use `admin@<mail domain>`. Passkeys only work on the address you set up on. |
| Keys or Gmail stopped working | `PROVIDER_CREDENTIAL_KEY` changed. Restore the saved value. |
| A key in Admin → Keys can't be edited | A Worker secret with the same name wins. Delete the Worker secret; the value stays stored. |
| `redirect_uri_mismatch` from Google | Add the exact callback URI to the OAuth client. |
| Deploy says `Missing secrets` or `Missing required configuration` | Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as repository secrets in the fork (or in `.env`), then run **Deploy production** again. |
| Deploy says it could not create or check the R2 bucket | Open **R2** in the Cloudflare dashboard once to enable it, and check the token has **Workers R2 Storage: Edit**. |
| Deploy says `Could not resolve the D1 database` | The Worker exists but its database was not found: check the token has **D1: Edit**, or set the variable `D1_DATABASE_ID`. |
| Notifications say "setup needed", or Admin → Keys asks for `PROVIDER_CREDENTIAL_KEY` | Run **Actions → Deploy production** once (it creates the key), or connect Cloudflare in **Admin → Keys**. Push keys are then generated automatically. Back the key up with **Admin → Keys → Back up encryption key**. |
| A phone gets no notifications | iPhone/iPad: open the site in Safari, **Share → Add to Home Screen**, open it from the Home Screen and tap the bell there (iOS allows web push only for installed apps). Any phone: allow notifications for the app in the phone's settings, open the app once so it re-registers, and turn the bell off and on if needed. |
| Each push deploys twice, or Workers Builds reports a deleted build token | Disconnect Git under the Worker's **Settings → Build**; GitHub Actions deploys. |

## Development

```bash
npm ci
npm run dev    # Vite + Worker; the app migrates its local database
npm test       # unit and regression checks
npx playwright install chromium   # once, for the end-to-end suites
npm run test:e2e  # real Worker + Chromium end-to-end suites
```

Local first-run setup uses the setup secret: put `AUTH_SETUP_TOKEN=<any long random value>` in `.dev.vars` (gitignored) and choose **Use the setup secret instead**; setup with a Cloudflare token needs the deployed app. CI also runs `python3 scripts/test-mailbox-migration.py` and the password-runtime check (`scripts/test-worker-password-runtime.mjs` against `scripts/password-runtime.wrangler.jsonc`); see `.github/workflows/validate.yml`.

Branches: `main` deploys to production; work happens on version branches `vX.XX`. When a new version branch is created, set both `target-branch` values in `.github/dependabot.yml` to it (Dependabot reads the file from `main`). Visual changes to the original layout go in `src/client/layout-fixes.css`.

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
docs/                  Sign-in, changelog, upgrade notes; docs/history/ holds design records
```

</details>

More: [updates](./docs/UPGRADING.md) · [sign-in, addresses and passkeys](./docs/SIGN_IN.md) · [changelog](./docs/CHANGELOG.md) · [security](./SECURITY.md)

## License

© 2026 Sanghyuk Mo. Self-hosting license; see [LICENSE](./LICENSE).
