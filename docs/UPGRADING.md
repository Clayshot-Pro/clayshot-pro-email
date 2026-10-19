# Updates

Back up D1 **and** R2 before big updates. Then:

- **Fork:** on GitHub, open your fork and choose **Sync fork → Update branch**. The admin panel shows when there is a new version.
- **Other copies:** merge the new version into `main`, or run `npm run deploy:self`.

Deploys apply migrations, and the app applies any still pending on its first request. All migrations are additive.

## v3.14

- Fixes from a security and bug review; nothing to do. Devices signed in to a mailbox are signed out when it is disabled.
- A domain whose catch-all already forwards elsewhere now asks before replacing it (**Replace the catch-all and connect**).

## v3.13

- Forks are the recommended setup and update with **Sync fork**; the admin panel shows the running version and when a newer one is out.
- A fork built by Cloudflare needs no deploy keys: Wrangler links the database and bucket by name.
- The GitHub Actions deploy runs only in the project repository, or in a fork that sets the repository variable `DEPLOY_WITH_ACTIONS` to `true`.
- An instance whose Worker, database or bucket has other names sets them as variables (`WORKER_NAME`, `D1_DATABASE_NAME`, `R2_BUCKET_NAME`): Workers Builds build variables, or GitHub repository variables for the Actions deploy. The fork's `wrangler.jsonc` stays unmodified.

## v3.12

- Optional: connect a Cloudflare token in **Admin → Keys** to set up new domains automatically.
- `AUTH_SETUP_TOKEN` is not needed once setup is done; you can delete it.
- `.env.example` is now `config/env.example`, and `wrangler.jsonc` is committed (no account IDs). Command-line deploys leave it unchanged.

## v3.08: no primary mailbox

- `admin@<mail domain>` is created automatically and becomes the admin's starting inbox.
- The former primary mailbox keeps its address and mail and becomes an ordinary mailbox.
- Postmaster/abuse mail, forwarding, the profile photo and the push contact move to admin@.

## v3.06: keys in D1

`GOOGLE_*`, `RESEND_*`, `CF_EMAIL_SENDING_TOKEN` and `VAPID_*` Worker secrets are copied into D1. Once **Admin → Keys** shows them, you may delete those secrets; keep them while a rollback to v2 is possible. **Never delete `PROVIDER_CREDENTIAL_KEY`.**

## v2 → v3

- The existing mailbox and its domain are adopted automatically; there is no first-run setup.
- Set the app name (**Branding**) and sender names (**Mailboxes**). Re-enter forwarding and automatic purge in **Mail settings** if you used them.
- No longer read, can be deleted: `PRIMARY_ADDRESS`, `FORWARD_TO`, `MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `MAX_MAILBOXES`, `APP_ORIGIN`, `ADMIN_ADDRESS`, and `CF_EMAIL_SENDING_ACCOUNT_ID` if it is a secret.

## Rollback

Redeploy the previous version from its version branch. Migrations are additive, so older versions keep working on the newer database.
