# v2.00 Cloudflare launch checklist — account owner

> **Historical (v2).** Kept as a record of the v2 production rollout. Settings it mentions such as `PRIMARY_ADDRESS`, `MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `FORWARD_TO`, `EMAIL_DYNAMIC` and Workers Builds-only deploys no longer exist in v3. To install, deploy or administer the app, follow the [README](../../README.md).

**Status:** Manual production steps. The GitHub implementation is not permission to deploy or change the live Email Routing rules before backups and validation. The latest implementation code lives on the permanent `v2.00` version line.

**Service:** `ltm-email-service` / `email.liamthemo.com` / `liamthemo.com` / Workers Paid / D1 `ltm-email-service` / R2 `ltm-email-service-mail`.

## 1. Confirm safe Cloudflare Builds settings

1. Open [Cloudflare dashboard](https://dash.cloudflare.com/) > **Workers & Pages** > **ltm-email-service** > **Settings** > **Build** > **Branch control**.
2. Confirm production branch **`main`**. Disable **Enable Preview Builds**. Branch `v2.00` and temporary branches must not preview-deploy or production-deploy. GitHub Actions still validates PRs/version branches.
3. Leave Cloudflare's existing production build/deploy configuration in place unless it is genuinely broken. The repository's `npm run build` hydrates the production D1 binding and invokes remote migrations **only** when `WORKERS_CI=1` and `WORKERS_CI_BRANCH=main`.
4. Verify the existing Cloudflare build credentials (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) are configured **as private build variables/secrets**, never committed to Git. Confirm token access to existing Worker settings and D1 migrations.
5. Avoid enabling a raw deployment trigger for non-main branches. If a non-main Workers Builds check still fails, open its private build log and check the preview configuration; do not infer a production outage from a preview failure.

[Cloudflare branch control documentation](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)

## 2. Back up real mailbox data before merging v2.00 to main

1. In **Storage & databases > D1 > ltm-email-service**, capture a recoverable snapshot/backup of the *production* D1 database.
2. In **R2 > ltm-email-service-mail**, create an independent, access-controlled copy/export of existing raw MIME and attachments. R2 objects must be recoverable at the same logical point as D1 references; a D1 backup **alone is not an email backup**.
3. Verify a sample D1 and R2 restore **away from production**. Confirm a historical raw message and an attachment can be read, and inventory the number of messages, threads and drafts. Do not paste private content, tokens, IDs or raw mail into public GitHub logs.
4. Preserve a snapshot of the existing Email Routing rules and sender setup so they can be restored safely.
5. Only then proceed with the planned **main-only** deployment and D1 migrations `0010`/`0011`/`0012`.

**Do not run a destructive D1 rollback after the upgrade.** The migrations are additive; leaving their added columns/tables in place is safer than reversing them under production email traffic.

## 3. Configure inbound mail routing

**Do this after the new Worker version and schema have successfully deployed.**

1. Go to **Compute > Email Service > Email Routing > Routing Rules** for `liamthemo.com`.
2. Inspect all existing exact-address rules, especially `contact@liamthemo.com`, and check their action. Preserve its Worker delivery path. A literal rule can take precedence over a catch-all rule.
3. Enable **Catch-all** and set action **Send to a Worker**, choosing the already deployed **ltm-email-service** Worker. Do not choose forwarding to a personal address or dropping mail.
4. Save, then send real tests from an **external** email provider to a newly created address, to `contact@`, to a plus-address (e.g. `personal+test@`), and to an **unregistered** address. The unregistered address must be rejected, not silently routed to another inbox.
5. Check **Email Routing activity**, Worker logs, storage, UI and notifications. A catch-all does not create mailboxes; the Worker looks up active addresses in D1.
6. Subaddressing settings can influence routing behavior. Exact registered addresses should win; plus-aliases fall back to an active parent mailbox in the Worker.

[Cloudflare routing rules](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) · [Catch-all API behavior](https://developers.cloudflare.com/api/resources/email_routing/)

## 4. Enable automatic sending from all active native mailboxes

1. In **Compute > Email Service > Email Sending**, onboard the configured native sender domain and verify the required DNS/DKIM/SPF/bounce setup.
2. The `EMAIL_DYNAMIC` Worker binding is unrestricted by sender address at the Cloudflare binding layer so every **active, signed-in native mailbox** on `PRIMARY_ADDRESS`'s domain can send without a per-mailbox allowlist or per-mailbox API token. `EMAIL` remains restricted to the primary address.
3. Deploy from `main`. Active mailboxes now have a usable Send button; missing optional REST API credentials no longer grey it out. Sender identity still comes exclusively from D1-authenticated mailbox records, not from form input.
4. For API-based sending, optionally create an account-scoped **Email Sending: Edit** token and set it as the Worker's runtime secret `CF_EMAIL_SENDING_TOKEN`. If provided along with the build-injected account ID, the Worker prefers the REST transport. Do not expose it to clients or commits.
5. Test a real secondary native mailbox send. If the domain is not onboarded, Cloudflare may restrict destinations to verified recipients. Review the inline compose error and Email Service activity. Cloudflare may also restrict non-transactional use.
6. The Worker remains subject to per-mailbox authorization, active status, quota, rate limits, idempotency and account-wide Cloudflare email restrictions.

[Cloudflare send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/) · [Cloudflare FAQ](https://developers.cloudflare.com/email-service/reference/faq/)

## 5. Optional automated retention

- The app disables a mailbox immediately when scheduled for deletion, preserving data for **30 days**, with restore during that window. The UI can manually erase after expiry.
- A daily UTC Worker cron is provisioned in Wrangler, but **automatic purging stays off by default**.
- Only after verifying the D1 + R2 backup and restore process, set Worker secret **`MAILBOX_PURGE_ENABLED=true`**. The scheduled handler erases expired mailboxes in bounded batches; if there is more content, it continues on subsequent daily executions.
- Deleting a mailbox is not the same as deleting the domain. `native:primary` cannot be deleted; scheduled mailboxes cannot be reused until purged.

## 6. Post-deployment smoke tests

- Sign in with the original passkey; confirm existing `contact@` messages, flags, thread history, drafts and attachments.
- Confirm connected Gmail accounts still appear; test Gmail OAuth, Inbox/Junk, reply, and drafts.
- Create `personal@liamthemo.com` and `work@liamthemo.com`; verify isolated Inbox/Sent/Drafts/Junk/Archive/Trash, search, unread totals and attachments.
- Send to both from external mail; both must retain separate read/junk/delete state even if the same RFC Message-ID is delivered twice.
- Verify unknown-address rejection, disabled-address rejection, plus addressing, postmaster/abuse aliases, and native Junk controls.
- Verify manual mailbox disable/reactivate, quota enforcement, "Recount storage" (which checks R2), safe deletion and restoration.
- Test desktop, iPhone Home Screen PWA and iPad web-app view; check for stale mail after switching mailboxes.
- Test live outbound **only if approved**; send attempts are idempotent. A failure *after provider acceptance* may require manual delivery-log reconciliation rather than another click.
- Confirm Cloudflare Workers **production build/deployment succeeded on `main`**, migrations ran, health endpoints work and no preview/version branches deployed.

## 7. Owner action summary

**Required before production promotion:** verified D1+R2 backup/restore; confirm Cloudflare main-only branch controls; inspect Cloudflare Email Routing; obtain Cloudflare Email Sending policy decision.

**Required after safe production promotion:** enable catch-all to Worker; external receive and rejection tests; if outbound approved, deploy `main` with `EMAIL_DYNAMIC` and test any active native mailbox. The REST API token is optional.

**Optional:** `MAILBOX_PURGE_ENABLED=true` after backups.

**Do not share:** Cloudflare API tokens, passkey secrets, OAuth refresh tokens, D1 private production identifiers or raw email messages in GitHub issues or this public repo.
