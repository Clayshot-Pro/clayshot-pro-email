# v3.02 — Pluggable outbound transports and Resend

> **Design record.** Written before implementation; the code, the [README](../../README.md) and the [implementation status](./V3_IMPLEMENTATION_STATUS.md) describe current behaviour.

**Document status:** Implemented on `v3.02`; **updated in v3.05**: Cloudflare sending uses one unrestricted `EMAIL` binding by default (no token), or the Email Sending REST API when `CF_EMAIL_SENDING_TOKEN` is set; the `MULTI_SENDER_APPROVED` gate is gone, so every active mailbox on an active Cloudflare domain can send. Resend is unchanged. See [implementation status](./V3_IMPLEMENTATION_STATUS.md). Depends on [v3.01 multi-domain](./MULTI_DOMAIN.md) for the per-domain `outbound_transport` column.

## Decision

**Cloudflare Email Sending stays the default transport.** Resend is an **opt-in** transport that the administrator enables for each domain. New installs default to Cloudflare; Resend is only used where an admin has explicitly switched a domain to it and the instance has a `RESEND_API_KEY`.

Why offer Resend at all:

- Cloudflare documents Email Sending as transactional-only, which is why non-primary senders sit behind `MULTI_SENDER_APPROVED` today. A domain switched to Resend can send person-to-person mail without waiting on that Cloudflare approval.
- Resend sends signed delivery/bounce/complaint webhooks, which closes the bounce-visibility gap listed in [V2_IMPLEMENTATION_STATUS.md](../multi-mailbox/V2_IMPLEMENTATION_STATUS.md).

Inbound mail stays on Cloudflare Email Routing for every domain. Resend receiving is out of scope.

## Current coupling

`NativeMailProvider.sendMessage` (`src/worker/providers/native.ts:129`) picks `env.EMAIL` or `env.EMAIL_MULTI` and builds the Cloudflare payload inline. `send.ts:180` applies the `MULTI_SENDER_APPROVED` gate, and `send.ts` maps Cloudflare `E_*` error codes to safe messages. Idempotency (`outbound_attempts`), quotas and rate limits all live in `send.ts` and don't depend on the transport. That's the right layer to keep them in.

## Design

### Interface

`src/worker/transports/types.ts`:

```ts
export type OutboundMessage = {
  from: { email: string; name: string };
  replyTo: string;
  to: string[]; cc: string[]; bcc: string[];
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
  attachments: { filename: string; type: string; content: ArrayBuffer }[];
  idempotencyKey: string;               // outbound_attempts.client_key, scoped by mailbox
};

export type TransportResult = { providerMessageId: string | null };

export class TransportError extends Error {
  constructor(readonly code: SafeDeliveryCode, readonly retryable: boolean) { super(code); }
}

export interface OutboundTransport {
  readonly kind: "cloudflare" | "resend";
  send(message: OutboundMessage): Promise<TransportResult>;
}
```

`SafeDeliveryCode` is the existing `SAFE_DELIVERY_CODES` set in `send.ts`, moved next to the interface so every transport maps onto the same user-facing errors.

### Selection

```ts
transportFor(env, config, mailbox, domain): OutboundTransport | TransportUnavailable
```

| Domain `outbound_transport` | Mailbox | Result |
| --- | --- | --- |
| `cloudflare` | primary | `CloudflareTransport(env.EMAIL)` |
| `cloudflare` | other | `CloudflareTransport(env.EMAIL_MULTI)` **only if** `MULTI_SENDER_APPROVED=true`, else unavailable |
| `resend` | any active | `ResendTransport` if `RESEND_API_KEY` is set, else unavailable |
| `none` | any | unavailable (receive-only domain) |

`registry.ts` `sendEnabled` uses the same function so the UI and server always agree on whether a mailbox can send.

`NativeMailProvider.sendMessage` builds an `OutboundMessage` (HTML conversion stays where it is) and delegates to the selected transport.

### Resend transport

- `POST https://api.resend.com/emails` with `Authorization: Bearer ${RESEND_API_KEY}` and an `Idempotency-Key` header derived from `mailbox_id` + `client_key`, so a retried request can't produce a second email.
- Body: `from` as `"Name <address>"` (display name sanitized as today), `to`/`cc`/`bcc`, `reply_to`, `subject`, `text`, `html`, `headers` (threading `In-Reply-To`/`References` only), `attachments` as base64 `content` with `filename` and `content_type`.
- Size: the app's 4 MB attachment cap is well under Resend's limit; keep the app cap.
- Errors: map by Resend's error `name` onto existing codes, e.g. rate limiting → `E_RATE_LIMIT_EXCEEDED`, quota → `E_DAILY_LIMIT_EXCEEDED`, unverified/invalid sender domain → `E_SENDER_DOMAIN_NOT_AVAILABLE`, anything else → `E_DELIVERY_FAILED`. **Check the exact error names against Resend's current API docs when implementing**; unknown names must fall through to `E_DELIVERY_FAILED`, never to raw provider text.
- Timeouts/network failures after the request was sent mark the attempt `uncertain`, matching the current rule that accepted sends are never retried automatically.
- Recommend the operator creates a **sending-only** Resend API key restricted to the relevant domains.

### Webhooks

New route `POST /api/webhooks/resend`:

- Exempt from the session and same-origin checks in `index.ts` (it's server-to-server), and **only** that exact path.
- Verify the Svix signature: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}` with the base64-decoded `RESEND_WEBHOOK_SECRET` (without the `whsec_` prefix); constant-time compare against each `v1,` signature in `svix-signature`; reject timestamps more than 5 minutes off. Unsigned or invalid requests get `401` with no detail.
- Deduplicate on `svix-id` in a small table so replays are no-ops.
- Handled events: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`. Others are acknowledged and ignored.
- Rate limited like the auth endpoints; body size capped.

### Schema

Migration `0017_outbound_transports.sql`:

```sql
ALTER TABLE outbound_attempts ADD COLUMN transport TEXT NOT NULL DEFAULT 'cloudflare';
ALTER TABLE outbound_attempts ADD COLUMN last_event TEXT;
ALTER TABLE outbound_attempts ADD COLUMN last_event_at TEXT;
CREATE INDEX IF NOT EXISTS idx_outbound_attempts_provider ON outbound_attempts (transport, provider_message_id);

CREATE TABLE IF NOT EXISTS suppressed_recipients (
  address TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'manual')),
  source TEXT NOT NULL,                       -- 'resend' | 'admin'
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, event_id)
);
```

- A webhook event finds its attempt by `(transport, provider_message_id)`, updates `last_event`, and sets `messages.delivery_status` on the Sent copy (`delivered`, `delayed`, `bounced`, `complained`).
- Hard bounces and complaints add the recipient to `suppressed_recipients`. `send.ts` checks the list before calling any transport and returns the existing `E_RECIPIENT_SUPPRESSED` message. This applies to Cloudflare domains too.
- The cron job prunes `webhook_receipts` older than 30 days.

## Admin UI

- In the **Domains** section, each domain gets a transport selector: Cloudflare / Resend / Receive only. Switching requires step-up and is logged.
- Choosing Resend shows: whether `RESEND_API_KEY` is configured (yes/no, never the value), the SPF/DKIM records Resend needs (from the DNS check), the webhook URL to paste into Resend, and a notice that **message content for this domain passes through Resend as a third-party processor**.
- A **Suppressed recipients** list with remove (step-up).
- Mailbox rows show why sending is unavailable (policy gate, transport not configured, domain receive-only).

## Rollback

Switching a domain back to Cloudflare is a single D1 update. Records already sent through Resend keep `transport='resend'` so late webhooks still match them.

## Tests

- `scripts/test-transport-selection.mjs`: the selection table above, including `MULTI_SENDER_APPROVED` and a missing API key.
- `scripts/test-resend-webhook.mjs`: valid signature, tampered body, wrong secret, stale timestamp, replayed `svix-id`, unknown event type.
- `scripts/test-resend-errors.mjs`: provider error names map only to safe codes; unknown names → `E_DELIVERY_FAILED`.
- Payload test: a request with a forged `from` or `accountId` still sends as the server-derived mailbox.

## Exit gate

- [ ] A Resend-enabled test domain sends, replies (threading intact) and forwards with attachments.
- [ ] Delivered and bounced webhooks update Sent items; a bounced address is suppressed.
- [ ] A Cloudflare-default domain behaves exactly as in v3.01.
- [ ] No API key or webhook secret appears in logs, responses or the bundle.
