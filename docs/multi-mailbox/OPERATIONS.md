# Security, operations, pricing, and decision register

> **Historical (v2).** Kept as a record of the v2 planning. Settings it mentions such as `PRIMARY_ADDRESS`, `MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `FORWARD_TO`, `EMAIL_DYNAMIC` and Workers Builds-only deploys no longer exist in v3. To install, deploy or administer the app, follow the [README](../../README.md).

**Status:** Planning document. No operational settings or DNS records have been changed.

## Security requirements

- **Identity:** retain the existing owner-only passkey and server-side session model. Creating a mailbox address must not issue a new passkey, password, login session or separate site user.
- **Authorization:** deny by default. Every request must resolve a server-side active mailbox and verify ownership before queries or R2 object fetches. Avoid ID-only checks and cross-mailbox threading/draft/attachment access.
- **Input controls:** normalize addresses, prohibit external domains and reserved/system addresses, enforce limits on name length, mailbox count, recipients, MIME depth, raw bytes, attachments, and quota.
- **Outbound:** never treat the caller-provided From header or mailbox ID as authority. Rate-limit per mailbox and account, track delivery outcomes, guard against duplicate sends and account compromise.
- **Inbound:** validate SMTP envelope recipient, reject unknown/disabled addresses, sanitize HTML, block remote images by default, preserve existing parsing limits, and never expose raw headers or mail bodies in public logs.
- **Operations:** use immutable/audited administrative actions for creation, disabling, deletion, export and retention. Maintain protected backup access. Store tokens/config secrets only in Cloudflare secret stores.
- **Deletion:** disabling stops new mail immediately; deleting must require explicit confirmation, separate retention policy, safety window and R2/D1 cleanup/reconciliation. Shared raw MIME blobs are only removed when unreferenced.
- **Notifications:** never leak message content for another mailbox; push payload content must respect account/privacy settings.

## Cloudflare product constraints: verify before implementation

Authoritative references (checked 2026-10-13):

- [Email Service overview](https://developers.cloudflare.com/email-service/): outbound is described as **transactional** and in beta; the project must not assume unrestricted person-to-person usage is permitted.
- [Email Service FAQ](https://developers.cloudflare.com/email-service/reference/faq/): emphasizes transactional-only, with future marketing/bulk plans.
- [Email Sending bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/): `allowed_sender_addresses` is a fixed allowlist; sender domain must be onboarded. Allowing dynamic senders requires an explicit, audited application authorization design.
- [Email Sending limits](https://developers.cloudflare.com/email-service/platform/limits/): 50 recipients; normally 5 MiB outbound message size (25 MiB for verified destinations); rate/daily quotas depend on account standing.
- [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/): Workers Paid includes 3,000 outbound messages/month shared at the Cloudflare account level, then $0.35/1,000; inbound routing is unlimited but Worker handling is metered.
- [Email Routing API](https://developers.cloudflare.com/api/resources/email_routing/): catch-all rule may route to an Email Worker; validate existing route precedence before editing.
- [Workers + D1 + R2 pricing](https://developers.cloudflare.com/workers/platform/pricing/): already-paid Workers subscription may cover low traffic within included allowances; D1/R2 consumption can generate overages.

**Do not** present unlimited addresses as unlimited storage, delivery throughput, sending volume, or immunity from quotas. No SMTP/IMAP logins are provided by this proposal.

## Operating costs and controls

- **Fixed additional infrastructure for webmail:** potentially $0 USD/month beyond the existing Workers Paid subscription, *if* domain, Worker, D1, R2, routing and outbound usage remain within included capacity; not a promise of a free production bill.
- **Known shared sending allowance:** 3,000 outbound messages per Cloudflare account/month on Paid; daily limits may be lower and vary.
- **Metered risks:** D1 rows/storage, R2 stored GB/operations, Worker requests/CPU, emails above included quota, logs, backups and usage spikes.
- **Protection:** use quotas per mailbox, global hard caps, billing alerts, instrumentation without message contents, and a documented manual emergency stop of sends. Measure R2 orphan objects and D1 storage growth.
- **Backups:** establish D1 backup/restore approach and R2 retention/export strategy; verify a sampled restore before schema cutover. D1 metadata and R2 blobs must be restored to a mutually consistent point.

## Decision register

| ID | Decision | Current status / gate |
| --- | --- | --- |
| D-01 | Native mailboxes under `liamthemo.com`, managed from web app only | **Selected** |
| D-02 | Retain one owner passkey/session; mailbox addresses are not separate sign-ins | **Selected for MVP** |
| D-03 | Preserve existing `contact@` mailbox and connected Gmail | **Required** |
| D-04 | Inbound domain catch-all to Worker | **Proposed; verify existing routing and unknown-address rejection** |
| D-05 | Canonical shared R2 MIME plus mailbox delivery membership | **Preferred; validate migration constraints** |
| D-06 | Outbound using only Cloudflare Email Sending for everyday correspondence | **Blocked pending Cloudflare use-policy confirmation** |
| D-07 | Dynamic sending addresses vs `allowed_sender_addresses` defense-in-depth | **Open security design review** |
| D-08 | Mailbox quotas, retention, junk classification, bounce handling | **Open: defaults and policy to establish before rollout** |
| D-09 | Separate mailbox users / independent passkeys | **Deferred/out of MVP** |
| D-10 | Native IMAP/SMTP server or third-party mail server | **Explicitly out of scope** |

## Rollback and incident response

1. Keep existing `contact@` entry path and data readable through the initial shadow migration.
2. Before routing changes, capture a sanitized configuration snapshot plus protected D1 and R2 restore points, without committing mailbox data.
3. Provide feature flags to disable new-mailbox creation, mailbox send, and catch-all handling independently.
4. On failed migration, stop further schema/destructive cleanup, disable new routes, restore original routing and application revision where safe; reconcile D1 and R2 instead of blindly replaying sends.
5. Confirm `contact@` receives and sends again, Gmail remains connected, and existing drafts/messages are intact.
6. Record incident timeline and remediation privately, without leaking customer/mailbox data.

## Unresolved manual validation

- Cloudflare support/product confirmation of person-to-person outbound use.
- Authorized access to the live Cloudflare Email Routing/DNS and Sending configuration.
- Production baseline and recovery-point validation for private D1/R2 data.
- Manual live-mail tests on desktop/iPhone/iPad after actual implementation.
