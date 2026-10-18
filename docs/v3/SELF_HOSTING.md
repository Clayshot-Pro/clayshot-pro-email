# Self-hosting guide

The step-by-step guide now lives in the main [README](../../README.md). Automatic deploys from `main` (Workers Builds) need no `.env`: the two deploy keys are build variables and everything else is a Worker secret in the dashboard. Command-line deploys use `.env` → `npm run setup` → `npm run deploy:self`. Either way: first-run setup in the browser → Email Routing per domain → sending.

Summary of the v3.05 model:

- **Only Worker secrets and Cloudflare deploy keys exist** ([`config/schema.mjs`](../../config/schema.mjs)): build variables + Worker secrets in the dashboard, or a local `.env`. There are no instance vars, and nothing secret is committed.
- **The app's address and admin sign-in come from the URL it is served on** (`admin@<app hostname>`). Passkeys are bound to that hostname, so set up on the final hostname.
- **First-run setup** (with `AUTH_SETUP_TOKEN`) chooses the primary mailbox; its domain becomes the primary mail domain. Everything else — domains, branding, themes, forwarding, limits — is managed in the admin panel and stored in D1.
- **Sending** uses Cloudflare Email Sending through the Worker's built-in binding (no token needed; set `CF_EMAIL_SENDING_TOKEN` only to use the REST API instead), or Resend per domain.
- **Licence:** free self-hosting for personal and internal organizational use, credit kept visible, no redistribution, no hosting for others, no paid services. See [LICENSE](../../LICENSE).
