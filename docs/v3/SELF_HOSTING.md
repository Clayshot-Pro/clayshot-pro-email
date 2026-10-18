# Self-hosting guide (target state)

**Document status:** Describes how deployment **will** work once v3.00 ships. The scripts named here don't exist yet. Until then, this repository can't be deployed by anyone else, and the current [`LICENSE`](../../LICENSE) doesn't permit it.

Once v3.00 ships, the new licence lets you run your own instance, personally or commercially, as long as you keep the built-in "Powered by LTM Email Service" credit visible and the licence notices intact. You may not redistribute the software. See [LICENSING.md](./LICENSING.md).

## What you need

- A Cloudflare account with at least one domain on Cloudflare DNS.
- A Workers plan that includes the products you'll use: Workers, D1, R2 and Email Routing. Cloudflare Email Sending, if you use it for outbound mail. **Check Cloudflare's current plan requirements**; Email Sending availability and policy differ from Email Routing.
- Node.js 22+ and npm.
- Optional: a Google Cloud OAuth client (connected Gmail accounts), a Resend account (alternative outbound transport).

## 1. Get the code

Clone into a **private** repository or a local folder:

```bash
git clone https://github.com/LiamTheMo/LTM-Email-Service.git my-mail
```

Don't publish a public fork with your changes. That counts as redistribution under the licence.

## 2. Fill in `.env`

```bash
cp .env.example .env
```

Minimum required values:

```dotenv
# Instance
APP_ORIGIN=https://mail.example.com
PRIMARY_ADDRESS=hello@example.com
ADMIN_ADDRESS=admin@example.com
BRAND_NAME=Example Mail

# Cloudflare (used by scripts only, never uploaded to the Worker)
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...

# First-run owner passkey setup (remove after setup)
AUTH_SETUP_TOKEN=<long random string>
```

Optional groups (leave blank to disable the feature):

```dotenv
# Extra mail domains (created as "pending"; activate them in the admin panel)
MAIL_DOMAINS=example.org

# Push notifications
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# Connected Gmail accounts
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
PROVIDER_CREDENTIAL_KEY=

# Resend outbound transport (opt-in per domain)
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
```

`.env` is gitignored. Never commit it.

The Cloudflare API token needs: Workers Scripts edit, D1 edit, R2 edit, and Account Settings read.

## 3. Set up and deploy

```bash
npm ci
```

```bash
npm run setup
```

`setup` checks `.env`, creates the D1 database and R2 bucket if they don't exist, renders `wrangler.jsonc`, uploads secrets as Worker secrets, and applies migrations. It's safe to run again.

```bash
npm run deploy:self
```

`deploy:self` shows the account and worker name, asks for confirmation, builds and deploys.

## 4. Point the app at your domain

In the Cloudflare dashboard, add a **custom domain** for the Worker that matches `APP_ORIGIN` (e.g. `mail.example.com`).

## 5. Route incoming mail

For **each** mail domain:

1. Email Routing → enable for the zone (Cloudflare adds the MX records).
2. Routing rules → **Catch-all** → *Send to a Worker* → your worker.
3. Admin panel → Domains → **Check DNS** and **Activate**.

## 6. Choose outbound sending

- **Cloudflare (default):** onboard the domain for Email Sending in the dashboard. The primary address can send right away. Other addresses stay disabled until you set `MULTI_SENDER_APPROVED=true`, and you should only do that if Cloudflare's terms allow your use (they currently describe Email Sending as transactional-only).
- **Resend (optional):** verify the domain in Resend, add the webhook URL shown in the admin panel, then switch that domain's transport to Resend. Mail sent from that domain passes through Resend.

## 7. First sign-in

1. Open `APP_ORIGIN`, choose **Set up**, enter `AUTH_SETUP_TOKEN`, and register the owner passkey.
2. Sign in as `ADMIN_ADDRESS` and set the administrator password (password + passkey from then on).
3. Remove `AUTH_SETUP_TOKEN` from `.env` and run `npm run secrets:push`.
4. Create mailboxes in **Admin → Mailboxes**.

## Updating

```bash
git pull
```

```bash
npm run deploy:self
```

Migrations are applied automatically. Read the release notes before updating across a major version.

## Rotating secrets

Edit `.env`, then:

```bash
npm run secrets:push
```

Note that changing `PROVIDER_CREDENTIAL_KEY` makes stored Gmail tokens unreadable, and connected Gmail accounts will need to be reconnected.

## Backups

You're responsible for your own data. At minimum:

- Export D1 regularly (`wrangler d1 export`).
- Keep R2 versioning or a copy of the bucket.
- Test a restore before turning on `MAILBOX_PURGE_ENABLED`.

## Things that never change after setup

- `APP_ORIGIN` host: passkeys are bound to it. Changing it means registering passkeys again.
- `PRIMARY_ADDRESS` on an install that already has mail: renaming is a separate admin action, not a `.env` edit.
