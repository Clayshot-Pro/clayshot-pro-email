# Self-hosting guide

The step-by-step guide now lives in the main [README](../../README.md). Automatic deploys from `main` (Workers Builds or GitHub Actions) need no `.env`: the two deploy keys are build variables or GitHub repository secrets, `PROVIDER_CREDENTIAL_KEY` is a Worker secret, and integration keys are entered in Admin → Keys. Command-line deploys use `.env` → `npm run setup` → `npm run deploy:self`. Either way: first-run setup in the browser → Email Routing per domain → sending.

Summary of the v3.06 model:

- **Only Worker secrets and Cloudflare deploy keys exist** ([`config/schema.mjs`](../../config/schema.mjs)): build variables + Worker secrets in the dashboard, or a local `.env`. There are no instance vars, and nothing secret is committed.
- **The app's address comes from the URL it is served on.** Passkeys are bound to that hostname, so set up on the final hostname. The administrator signs in as `admin@<mail domain>` (or `admin@<app hostname>`).
- **Integration keys** (Gmail, Resend, Email Sending token) are entered in Admin → Keys and stored in D1, encrypted with the `PROVIDER_CREDENTIAL_KEY` Worker secret. Push (VAPID) keys are generated automatically.
- **First-run setup** (with `AUTH_SETUP_TOKEN`) chooses the mail domain and creates the `admin@` mailbox on it, the administrator's starting inbox. Everything else — domains, branding, themes, forwarding, limits — is managed in the admin panel and stored in D1.
- **Sending** uses Cloudflare Email Sending through the Worker's built-in binding (no token needed; set `CF_EMAIL_SENDING_TOKEN` only to use the REST API instead), or Resend per domain.
- **Licence:** free self-hosting for personal and internal organizational use, credit kept visible, no redistribution, no hosting for others, no paid services. See [LICENSE](../../LICENSE).
