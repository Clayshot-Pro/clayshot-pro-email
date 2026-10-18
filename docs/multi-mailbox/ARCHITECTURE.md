# Multi-mailbox technical design

> **Historical (v2).** Kept as a record of the v2 planning. Settings it mentions such as `PRIMARY_ADDRESS`, `MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `FORWARD_TO`, `EMAIL_DYNAMIC` and Workers Builds-only deploys no longer exist in v3. To install, deploy or administer the app, follow the [README](../../README.md).

**Status:** Proposed design, subject to implementation review. Derived from source at `v1.04`.

## 1. Data model and identity separation

Existing `connected_accounts` is a provider registry, not a security boundary or full native mailbox data model. Introduce a native `mailboxes` table, with opaque stable IDs and a unique **normalized** address (casefold local part as a conservative application policy, Unicode/domain input normalized consistently; reject invalid and reserved addresses).

Suggested schema concepts (not production SQL):

| Entity | Key fields and requirements |
| --- | --- |
| `mailboxes` | ID, normalized address unique, display name, status (`active`, `disabled`, `deleting`), quota, usage, created/updated timestamps |
| `mailbox_memberships` | mailbox ID + existing owner principal ID + role (`owner`); reserved for future delegation, not new user sign-up |
| `mail_objects` / `messages` | canonical message and MIME identity with R2 pointer; immutable content identity distinct from mailbox state |
| `mailbox_messages` | mailbox ID + message ID, per-mailbox folder, is_read, is_starred, is_archived, is_deleted, junk state, received/sent timestamps, uniqueness and compound indexes |
| `mailbox_threads` or mailbox-scoped thread IDs | per-mailbox thread subject, counts, read/unread and last activity; never cross mailbox/thread isolation |
| `drafts` | add required mailbox ownership and sender identity, with indexes |
| `attachments` | link to canonical content; download authorization via a mailbox/message membership lookup |
| `outbound_attempts` | mailbox ID, idempotency key, send state, provider response/error, timestamps, recipient count, retry metadata |
| `mailbox_events` | minimal audited administrative mutations; no message bodies or tokens in logs |

Options for normalized storage:
- **Preferred:** one canonical raw MIME object in R2 and one per-recipient `mailbox_messages` membership, with mailbox-specific flags/folders. Reference counts or retained-content policy prevent premature deletion.
- **Acceptable first migration:** separate mailbox-scoped messages with distinct IDs and a shared blob pointer, provided all APIs enforce mailbox scope and deletion cannot remove another recipient's content.

Avoid treating `messages.message_id` as a globally unique delivery key: the same RFC Message-ID can legitimately be delivered to two of our addresses. Use a bounded ingestion/delivery idempotency key (for example message identity + normalized envelope recipient + source delivery identifier when available), plus uniqueness enforced for mailbox delivery. Do not deduplicate unrelated messages solely by subject or RFC Message-ID.

## 2. Recipient routing

1. Cloudflare Email Routing delivers domain traffic to the existing Worker using a configured catch-all Worker action, **after explicit production routing validation**.
2. Read `message.to` (SMTP envelope recipient) as the authoritative target; do not rely on potentially spoofed visible `To:` or `Cc:` headers.
3. Normalize/validate that recipient matches `liamthemo.com`; resolve exactly one active mailbox. Unknown, disabled, invalid, or non-local recipients: reject via `message.setReject`, with non-disclosing error wording.
4. Enforce message/attachment size limits, sanitize HTML, reject dangerous MIME, enforce quotas, and store canonical raw MIME and attachment blobs with opaque R2 keys.
5. Associate each accepted delivery with the intended mailbox atomically where possible. Provide reconciliation for partial R2/D1 failures and delayed cleanup of orphan objects.
6. Notify only the selected mailbox and apply forwarding only when configured and authorized for that mailbox.

Cloudflare Routing catch-all is domain-wide; review precedence of any existing explicit address rules before cutover. Test known, unknown, and multi-address deliveries; ensure Gmail integration is **not** accidentally redirected.

## 3. Reads, searches, and mutations

The native provider should accept a *resolved and authorized mailbox ID* in its constructor rather than implicitly querying all `messages`.

Every native API must scope **at the database predicate**, not just filter returned JSON:
- folder listings, inbox unread counts, search, threaded views;
- message GET/PATCH, status, archive, trash, permanent deletion, restore;
- draft create/update/get/delete and reply/forward;
- attachment download/preview and signed URL handling;
- push subscription preferences, recipient attribution, quota checks.

Select a native mailbox by a validated `accountId` backed by D1 membership; reject an unknown ID, inactive mailbox or missing permission with 403/404. The owner session grants permission, but routes must still check the resource belongs to that mailbox. Do not allow the default native account to serve as a cross-mailbox bypass.

For threading, resolve `References` and `In-Reply-To` **within the recipient mailbox only**. Two independent mailboxes may hold independent thread/flag state for a shared original message.

## 4. Sending and provider integration

The native sender must derive `from` and Reply-To from the server-resolved mailbox; never trust posted addresses. Verify active mailbox, owner membership, allowed domain, quotas, recipients, rate limits, request idempotency, and the provider response before marking `sent`. Persist/send status carefully so retries do not duplicate mail.

Current `wrangler.jsonc` has `allowed_sender_addresses: ["contact@liamthemo.com"]`. Changing this is an **explicit security decision**:
- a static allowlist would require redeploying on each mailbox creation;
- a domain-authorized unrestricted binding removes that control and must be paired with stringent **server-side** mailbox authorization, audit logging, rate limits, and a feature flag;
- any sender authorization workaround that bypasses Cloudflare policy is prohibited.

Outbound sending remains **blocked for arbitrary personal/business correspondence** until Cloudflare confirms the relevant usage policy. Do not silently fall back to another provider in a design described as Cloudflare-only. Document a supported alternative separately if confirmation is negative.

Keep Gmail providers untouched, with `provider='gmail'` and OAuth credentials handled as today; native mailbox IDs must not collide with Gmail account IDs.

## 5. Proposed API and UI contracts

These are targets for implementation, not existing endpoints:

| Method / route | Behavior |
| --- | --- |
| `GET /api/mailboxes` | List allowed native mailboxes, quotas/status |
| `POST /api/admin/mailboxes` | Create validated domain mailbox (owner-only; idempotent) |
| `PATCH /api/admin/mailboxes/:id` | Rename display name, change quota, disable/reactivate |
| `DELETE /api/admin/mailboxes/:id` | Two-stage disable, retention/export confirmation, delayed purge |
| `GET /api/messages?accountId=...` | Existing API: native provider filtered to authorized mailbox |
| `POST /api/send` | Existing API: sender resolved from authorized active native mailbox |
| `GET /api/mailboxes/:id/usage` | Storage/message usage and limits |

The UI adds an owner-only **Mailboxes** section, clear per-mailbox address switching, an explicit sender identity in compose, warnings on disabled mailboxes, error recovery, and a deliberate deletion/export confirmation. Account switching must never expose stale messages from the previously selected mailbox.

## 6. Compatibility and rollout

1. Inventory current native messages/drafts/attachments and Gmail-connected accounts.
2. Create schema additively; backfill a single `contact@liamthemo.com` native mailbox with the stable existing `native:primary` mapping.
3. Shadow-read and compare counts before flipping native reads/writes.
4. Enable new mailbox creation behind a disabled-by-default feature flag; preserve existing receive/send paths until cutover.
5. Configure routing only after a safe fallback/test plan, then test recipient mapping, message delivery, and error handling.
6. Enable outbound multi-sender only after Cloudflare policy confirmation and a separate security review.
7. Retain old columns/data for a defined rollback window; remove compatibility code only after backup/restore validation.

**Invariant:** existing messages, read state, drafts and attachments must remain accessible to the original native mailbox throughout rollout. Never destructively rewrite an existing version checkpoint branch.
