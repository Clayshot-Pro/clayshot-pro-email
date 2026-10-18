# Implementation plan and acceptance checklist

> **Historical (v2).** Kept as a record of the v2 planning. Settings it mentions such as `PRIMARY_ADDRESS`, `MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `FORWARD_TO`, `EMAIL_DYNAMIC` and Workers Builds-only deploys no longer exist in v3. To install, deploy or administer the app, follow the [README](../../README.md).

**Document status:** Planned; no phases have been implemented by this documentation-only change.

## Workstream 0 — Validate requirements and Cloudflare feasibility

- [ ] Record Cloudflare's explicit answer on whether manual person-to-person/business correspondence from webmail is supported by **Email Sending**, which Cloudflare currently describes as transactional-only.
- [ ] Confirm `liamthemo.com` domain is properly onboarded for Email Sending, SPF/DKIM/DMARC, and current sender-binding behavior.
- [ ] Inspect active Email Routing rules and catch-all support; test overlap/precedence without interrupting `contact@`.
- [ ] Inventory production native messages, drafts, R2 objects, subscriptions, Gmail connections, forward rules, and quota usage using access-controlled tooling (never dump personal data to repository logs).
- [ ] Agree that MVP is **one owner session with multiple mailbox addresses**, not separate user accounts or conventional IMAP/SMTP logins.
- [ ] Establish measurable rollout gates, backups, recovery point, and rollback procedure.

**Exit gate:** documented policy decision + verified account capabilities; otherwise inbound-only planning can continue but general-purpose outbound must remain disabled.

## Workstream 1 — Additive D1 schema and access model

- [ ] Add `mailboxes` with normalized addresses, active/disabled lifecycle, quotas, uniqueness and indexes.
- [ ] Introduce mailbox-specific message state and thread attribution, preserving canonical MIME references; add mailbox ownership to drafts.
- [ ] Backfill `native:primary` to `contact@liamthemo.com` and preserve historical message IDs, R2 keys, flags, threading, drafts, and attachments.
- [ ] Add per-message and per-delivery uniqueness/dedup safeguards, including duplicate RFC Message-ID across two recipients.
- [ ] Audit every handler for mailbox scoping, including attachment previews, reply/forward, push, counts, search, and deletion.
- [ ] Build migration/reconciliation and deterministic tests; do not delete legacy data in this phase.

**Exit gate:** primary mailbox behaves identically; backups and shadow-read counts match.

## Workstream 2 — Management API and webmail UX

- [ ] Build owner-only create/list/disable/update/delete APIs with normalization, reserved-name validation, quotas, anti-enumeration and audit events.
- [ ] Add Mailboxes administration, switcher and per-mailbox compose From selector on desktop/iPhone/iPad.
- [ ] Update native provider registry to resolve each native account and return only authorized records.
- [ ] Ensure that drafts, unread counts, search, folder state and notifications are linked to the selected mailbox.
- [ ] Preserve connected Gmail navigation/compose behavior and existing passkey/session controls.
- [ ] Implement safe account deletion workflow: immediate disable, explicit retention/export policy, delayed purge and restore path.

**Exit gate:** create two mailboxes locally, switch between them and prove zero cross-mailbox access.

## Workstream 3 — Receiving and storage

- [ ] Validate a catch-all route to the Worker and existing explicit route precedence.
- [ ] Resolve the **envelope** recipient, reject unknown/disabled mailboxes and deliver to active mailbox IDs.
- [ ] Handle multi-recipient duplicate delivery, failure retry/dedup, quota exceeded, invalid MIME, and partial R2/D1 writes.
- [ ] Add per-mailbox Junk support as a local feature with a documented detection policy (current native Junk is empty; Gmail Junk is Gmail's Spam label).
- [ ] Preserve optional forwarding with per-mailbox authorization, and handle notification recipient attribution.
- [ ] Test deliverability from external domains and verify stored MIME/attachments and thread boundaries.

**Exit gate:** independent inbound delivery works for new addresses with no regressions to primary native mail or Gmail.

## Workstream 4 — Outbound (conditional)

- [ ] Obtain Cloudflare approval for actual manual-personal mail use **before** enabling general send from created addresses.
- [ ] Evaluate the `send_email` sender-binding restriction and set a server-authorized sender model.
- [ ] Validate eligible domain, sender mailbox status, recipient policy, attachment size, abuse/rate limits and idempotency.
- [ ] Persist send state as pending / accepted / failed (not just optimistic Sent); examine bounce and suppression behavior.
- [ ] Test from each mailbox to representative external providers using allowed messages, and verify From/Reply-To, threading and SPF/DKIM/DMARC.
- [ ] Verify no impersonation by modifying `accountId` / `from` / reply target in requests.

**Exit gate:** send behavior is within Cloudflare terms and passes end-to-end tests; otherwise retain inbound-only functionality and document that sending is blocked.

## Workstream 5 — Release and operational acceptance

- [ ] Execute tests/build/typecheck/security scan and confirm CI on the intended version branch.
- [ ] Recheck all review findings and resolve actionable regressions.
- [ ] Create descriptive temporary branch from intended version checkpoint; commit changes there.
- [ ] Merge temporary branch into that version checkpoint; validate.
- [ ] Merge version checkpoint to `main`; only `main` triggers production Cloudflare deployment.
- [ ] Verify Cloudflare Workers Builds succeeded, migration completed, health endpoints, routing, UI and notification behavior.
- [ ] Manually validate external live mail on desktop, iPhone and iPad, including reply/forward and attachment safety.
- [ ] Record production observations, rollback readiness, and phase completion evidence in release notes.

## Testing matrix

| Scenario | Required result |
| --- | --- |
| Create two valid addresses and one duplicate/case-variant | Two active mailboxes; duplicate rejected |
| Message to unregistered/disabled recipient | Explicit rejection; no data leakage |
| Inbound to both active addresses | Both receive independent read/flag/delete state |
| Same RFC Message-ID arrives for two mailboxes | No dropped or cross-linked delivery |
| Read/search/archive/trash/restore from mailbox A | No mailbox B content or counts change |
| Alter `accountId` in message/draft/attachment APIs | Access denied when unauthorized |
| Compose from disabled or forged sender | Send blocked with safe error |
| Reply/forward to a message in another mailbox | Access denied |
| Fail R2 write or D1 commit during receive | Message rejected/retried; no hidden partial delivery |
| Gmail OAuth/connected Inbox/Junk/compose | Existing behavior preserved |
| Upgrade/backfill existing `contact@` | Counts, flags, drafts, attachments and threads retained |
| Native Junk | Clearly labeled, no unsupported spam-classifier claims |
| Cloudflare deploy | `main` only; migrations are safe/idempotent; live smoke test passes |

## Definition of done

The project is not complete when code is pushed. Every feature must be implemented, independently validated, reviewed, deployed from `main`, and checked in production. Distinguish final status as **Completed / Passed**, **Requires Manual Validation**, or **Incomplete / Needs Work**, with evidence and any remaining blockers.
