# v2.00 multi-mailbox implementation status

> **Historical (v2).** Kept as a record of the v2 implementation status. Settings it mentions such as `PRIMARY_ADDRESS`, `MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `FORWARD_TO`, `EMAIL_DYNAMIC` and Workers Builds-only deploys no longer exist in v3. To install, deploy or administer the app, follow the [README](../../README.md).

**Status:** Code implemented on the `v2.00` development line; production `main` intentionally remains at the previous release until Cloudflare and data-protection gates are satisfied. This file describes implementation, not a claim of production functionality.

## Completed / Passed — code and automated validation

- D1 migrations `0010`, `0011`, and `0012`: native mailbox identity, mailbox-scoped threads, messages, drafts, Junk, quota, recovery lifecycle, sending receipts, inbound retry receipts and audit events.
- Existing `contact@liamthemo.com` data defaults to `native:primary`; optional Gmail-connected accounts and owner passkey sessions are preserved.
- Authenticated native mailbox management: create any permitted domain address, update display name, quota or optional Junk heuristic, disable/reactivate, schedule deletion, restore within 30 days, and irreversible paginated purge after expiry. The primary mailbox cannot be deleted.
- UI account switching, independent mailbox folder views, search, counters, message flags, drafts, thread state and authorized R2 attachment access.
- Recipient routing via the actual SMTP envelope recipient. Exact mailbox match wins; unregistered/disabled addresses are rejected. Supports plus-address suffix fallback to an active parent mailbox and RFC postmaster/abuse aliases to the primary mailbox.
- Inbound content stored in R2 and D1, with conditional quota reservations, cleanup on failure, and retry fingerprints derived from MIME and envelope recipient rather than trusting the sender's RFC Message-ID. Duplicates across genuinely distinct mailboxes are independently stored.
- Native high-confidence optional Junk categorization; no messages are destroyed by the classifier; manual Junk and Not Junk remain available.
- Outbound sending uses authenticated active native mailboxes, server-derived From identity, display names, idempotent client send keys, per-mailbox rate/daily limits, and approximate quota reservation including outgoing bodies and R2 attachments. Accepted sends are not automatically retried after local persistence failure.
- Existing primary sender retains the restricted `EMAIL` Cloudflare binding. Additional native senders use a distinct `EMAIL_MULTI` binding and are **disabled unless** the Worker secret `MULTI_SENDER_APPROVED` is exactly `true`.
- Retention cleanup can run daily using the main-deployed Cloudflare cron. Automatic irreversible deletion is **off unless** the Worker secret `MAILBOX_PURGE_ENABLED` is exactly `true`. User-requested post-grace purge remains possible in the web UI.
- Authenticated R2 usage recount reads real stored object sizes in bounded batches, detects missing objects, checks for concurrent mailbox changes, and refuses to overwrite counters if reconciliation is unreliable.
- GitHub Actions validates TypeScript, production bundle, full-history security and the SQLite legacy migration/regression test. These are not substitutes for live Cloudflare binding tests.

## Requires Manual Validation — owner/Cloudflare

1. **Cloudflare service policy:** Obtain explicit answer from Cloudflare about arbitrary person-to-person and business sending using Email Sending. Its published documentation still describes **transactional-only** usage. Without approval, leave multi-sender feature off.
2. **Existing production data:** Independently back up and restore-test the production D1 database and R2 bucket; verify historical messages, attachments and Gmail accounts. The migration's historical storage counter is an estimate until the post-deploy R2 recount.
3. **Cloudflare builds:** Set production branch `main` and disable preview builds on other branches. Non-main preview checks currently report failures even though GitHub's code checks can pass. Inspect private Cloudflare preview logs if they remain enabled.
4. **Production migration:** Apply D1 migrations on `main` only through the existing Cloudflare Workers Build process; confirm the real D1 binding is hydrated from the deployed Worker settings. Do not apply to the wrong D1 database.
5. **Catch-all:** After successful production deployment, configure Email Routing Catch-all to **Send to a Worker → ltm-email-service**, checking that the existing exact `contact@` rule remains routed correctly.
6. **Outbound activation:** After Cloudflare permits the specific use case and Email Sending domain authentication is verified, set `MULTI_SENDER_APPROVED=true` as a Worker secret and test different senders, replies, attachments, delivery logs and bounces.
7. **Automated retention:** Enable `MAILBOX_PURGE_ENABLED=true` only after proven D1+R2 restore; otherwise leave automatic purges off.
8. **End-to-end devices:** Test desktop, iPhone PWA and iPad. Confirm old contact mail, connected Gmail, native mailbox switching, recipient routing, spam, dedup, quotas, attachment safety, restores and production notifications.

## Incomplete / Needs Work — blocked externally

- Real-world ordinary correspondence from newly created addresses: policy and Cloudflare domain/binding validation are external requirements.
- Production rollout and its Cloudflare build/health/live email smoke test: intentionally withheld until the data backup, routing and sender policy gates are satisfied.
- Large-scale use, bounce observability, bulk export and recovery from every conceivable partial D1/R2 failure must be evaluated using the live Cloudflare account; automated CI cannot claim them verified.

## Where to continue

Follow [Cloudflare setup in exact order](./CLOUDFLARE_SETUP.md), then the [implementation test matrix](./IMPLEMENTATION_PLAN.md).

Architecture remains **one passkey-authenticated owner with multiple native email addresses via the Cloudflare-hosted web app**, not independent user logins or IMAP/SMTP accounts. No VPS is required.
