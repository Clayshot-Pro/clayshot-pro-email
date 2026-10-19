# Self-hosting guide

The step-by-step guide lives in the main [README](../../README.md). In short (v3.12):

1. **Deploy:** the Deploy to Cloudflare button (creates the Worker, D1 database and R2 bucket; make the GitHub copy private), GitHub Actions with two repository secrets, or `.env` → `npm run setup` → `npm run deploy:self`.
2. **First-run setup** on the final hostname: mail domain, administrator password and a Cloudflare API token on one page, then the owner passkey.
3. **More domains:** Admin → Domains → Add domain; with the token connected they are set up automatically.

Summary of the model:

- **No instance configuration in the Worker.** `wrangler.jsonc` is committed without account IDs; deploys fill in the D1 database ID. The app applies pending database migrations itself on its first request (deploys also run them first).
- **The app's address comes from the URL it is served on.** Passkeys are bound to that hostname, so set up on the final hostname. The administrator signs in as `admin@<mail domain>` (or `admin@<app hostname>`).
- **The Cloudflare token** is accepted only if it can see the exact Worker version serving the request. Setup uses it to create the `PROVIDER_CREDENTIAL_KEY` Worker secret (shown once; keep a copy), and it is stored encrypted for wiring domains: Email Routing, the catch-all to this Worker, Email Sending and a monitoring DMARC record. Remove it any time in Admin → Keys. Without a token, set an `AUTH_SETUP_TOKEN` Worker secret and wire domains in the Cloudflare dashboard.
- **Integration keys** (Gmail, Resend, Email Sending token) are entered in Admin → Keys and stored in D1, encrypted with `PROVIDER_CREDENTIAL_KEY`. Push (VAPID) keys are generated automatically.
- **Sending** uses Cloudflare Email Sending through the Worker's built-in binding (no token needed; set `CF_EMAIL_SENDING_TOKEN` only to use the REST API instead), or Resend per domain.
- **Licence:** free self-hosting for personal and internal organizational use, credit kept visible, no redistribution (keep your copy of the code private), no hosting for others, no paid services. See [LICENSE](../../LICENSE).
