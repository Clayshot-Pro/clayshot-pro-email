# Updates

Back up D1 **and** R2 before big updates. Then:

- **Fork:** on GitHub, open your fork and choose **Sync fork → Update branch**. The admin panel shows when there is a new version.
- **Other copies:** merge the new version into `main`, or run `npm run deploy:self`.

Deploys apply migrations, and the app applies any still pending on its first request. All migrations are additive.

## v3.18

- Phone notifications keep working: open the app once after updating on each phone so it re-registers. iPhone users need the app added to the Home Screen.

## v3.17

- New compose icon, and mail with narrow table layouts reads normally again. Nothing to do.

## v3.16

- A fork whose Worker already exists without a database (for example after an earlier failed setup) now deploys and creates its database and bucket.

## v3.15

- Fork deploys are simpler: add the two secrets and run **Deploy production**. The first deploy creates the D1 database and R2 bucket; existing instances are unchanged.

## v3.14

- Fixes from a security and bug review; nothing to do. Devices signed in to a mailbox are signed out when it is disabled.
- A domain whose catch-all already forwards elsewhere now asks before replacing it (**Replace the catch-all and connect**).
- Every fork deploys with GitHub Actions on each push to `main`; `DEPLOY_WITH_ACTIONS` is no longer needed. The fork needs the repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. If it deployed with Cloudflare Workers Builds, add them and disconnect Git under the Worker's **Settings → Build**.

## v3.13

- Forks are the recommended setup and update with **Sync fork**; the admin panel shows the running version and when a newer one is out.
- An instance whose Worker, database or bucket has other names sets them as repository variables (`WORKER_NAME`, `D1_DATABASE_NAME`, `R2_BUCKET_NAME`). The fork's `wrangler.jsonc` stays unmodified.

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
