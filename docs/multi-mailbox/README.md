# Cloudflare-native multi-mailbox roadmap

> **Historical (v2).** A record of the v2 work; settings and steps it names may no longer exist. Current setup: [README](../../README.md).

**Status:** Planning only — no new mailbox features, routing rules, sender authorization, or database migrations have been deployed.

**Starting checkpoint:** `v1.04` in `LiamTheMo/LTM-Email-Service`. **Production:** `main`, deployed by Cloudflare Workers Builds.

## Decision and scope

Extend the existing **private, web-app-only** LTM Email Service at `email.liamthemo.com` to create, receive, store, and send from multiple native addresses at `liamthemo.com` using Cloudflare Workers Paid, Email Routing, Email Sending (subject to policy approval), D1, and R2.

- **In scope:** administrator-created addresses, native mailbox switching, distinct Inbox/Sent/Drafts/Archive/Trash/Junk state, sender selection, per-mailbox quotas/limits, abuse controls, retention, notifications, and safe migration of the existing native mailbox.
- **Preserve:** `contact@liamthemo.com`, stored mail and drafts, current passkey and session model, optional connected Gmail accounts, message threading, web push, and main-only Cloudflare deployments.
- **Not in scope:** IMAP, POP3, client-facing SMTP login, VPS hosting, separate passwords for each email address, delegated multi-user sign-in, automated public account registration, or a commercial/shared-tenancy mail hosting product.
- **Account model for the first release:** one existing authenticated site owner manages many distinct **mailbox addresses**. An email address is **not** automatically a separate web-app login identity. Future delegated users would require a separate authorization design.

An address is a real mailbox only when it is `active`: it can receive routed inbound messages and is eligible to be selected for outbound sending **only if** the outbound provider permits that use. Aliases/forward-only addresses should be separate future objects, not silently modeled as full mailboxes.

## Existing implementation — audited at v1.04

| Component | Current implementation | Needed change |
| --- | --- | --- |
| Native provider | `native:primary` and `PRIMARY_ADDRESS=contact@liamthemo.com` | Resolve a native provider per mailbox ID |
| Connected accounts | D1 `connected_accounts` supports `native` or `gmail`; only the native primary account resolves | Extend native registry without regressing Gmail |
| Inbound | `src/worker/email/receive.ts` parses and stores mail; `messages.message_id` is globally unique | Route by validated envelope recipient and support multi-recipient delivery |
| Message state | `threads`/`messages` store read/star/archive/delete globally | Mailbox-scoped visibility, flags, threading, folders, counts, and search |
| Drafts | `drafts` has no mailbox owner | Scope all drafts, replies, and forwarded attachments |
| Outbound | `src/worker/providers/native.ts` sends only from primary address; Wrangler `EMAIL` binding has one allowed sender | Validate sender against active mailbox plus binding/domain permissions |
| Authentication | Owner passkey/session, no new registration after initial setup | Keep owner-only mailbox management; enforce server-side authorization |
| Deployment | Cloudflare Workers Builds deploys from `main`; version branches run GitHub validation | Stage additive schema changes and protect main-only deployment |

The application is currently a **single native mailbox plus optional connected Gmail providers**, not yet multi-mailbox. The above is a roadmap rather than a feature claim.

## Architecture

```text
Internet SMTP sender
  -> Cloudflare Email Routing (catch-all / domain routing)
  -> Worker email handler
  -> validate normalized envelope recipient against active native mailbox in D1
  -> MIME validation, deduplication, storage in R2 + D1
  -> mailbox-scoped messages/threads and web-push notification

Browser (authenticated owner)
  -> existing React/PWA UI and Worker API
  -> mailbox chooser / admin mailbox management
  -> server-side authorize native mailbox ID
  -> D1 mailbox metadata + R2 message/attachment blobs

Compose from selected active mailbox
  -> server checks mailbox ownership, enabled state, rate limits, domain, sender
  -> approved outbound transport (Cloudflare Email Sending only if use case permitted)
  -> delivery status / sent-item lifecycle / bounce handling
```

The app should never trust a client-supplied `accountId`, `from`, message ID, or R2 key as proof of access. All queries and object retrievals must be authorized against the selected mailbox.

## Product acceptance criteria

1. Owner creates `personal@liamthemo.com` and `work@liamthemo.com` without changing DNS for each address.
2. Existing `contact@liamthemo.com` mail, drafts, attachments, flags, and threads remain readable after migration.
3. Inbox, drafts, sent, archive, trash, junk, search, counters, attachment access, and notifications are isolated to the selected native mailbox.
4. A message addressed to two active mailboxes can appear in both independently without duplicated or lost MIME; unknown recipients are explicitly rejected (not silently caught in a global inbox).
5. Sender selection cannot be forged in request payloads; disabled/deleted addresses cannot send.
6. Gmail-connected accounts continue working, separate from local/native mailboxes.
7. Inbox and compose function on desktop, iPhone PWA, and iPad PWA; the selected mailbox is visible and accessible.
8. Migration is recoverable, data is backed up, and main-only deployment remains enforced.
9. Real outbound messages are enabled only after Cloudflare confirms the proposed person-to-person sending workflow is supported under the current service policy.

## Documentation index

- [Technical architecture and data model](./ARCHITECTURE.md)
- [Phased implementation, migration, and validation checklist](./IMPLEMENTATION_PLAN.md)
- [Operational constraints, security, cost, and unresolved decisions](./OPERATIONS.md)
- [v2.00 current implementation status and rollout gates](./V2_IMPLEMENTATION_STATUS.md)
- [Cloudflare owner setup checklist](./CLOUDFLARE_SETUP.md)
- [v2.02 administrator password and passkey login](./ADMIN_MFA.md)

These documents are **planning inputs**. They do not authorize infrastructure changes or claim a deployment occurred.
