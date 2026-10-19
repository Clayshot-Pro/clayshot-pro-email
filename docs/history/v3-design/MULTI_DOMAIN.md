# v3.01 — Multi-domain mailboxes

> **Design record.** Written before implementation; the code, the [README](../../../README.md) and the [changelog](../../CHANGELOG.md) describe current behaviour.

**Document status:** Implemented on `v3.01`. **v3.05:** `MAIL_DOMAINS` and `ADMIN_ADDRESS` are gone; the primary domain comes from first-run setup (or the existing primary mailbox on upgrade), and the admin signs in as `admin@<app hostname>`. Domains also carry a theme. See [changelog](../../CHANGELOG.md). Depends on [v3.00 config unification](./CONFIG_UNIFICATION.md).

## Goal

One instance hosts native mailboxes on several domains, for example `hello@example.com` and `me@example.org`, all managed from the same admin panel and served from the same app origin.

## Administrator model

**Decision: global administrator.**

There are two common ways to run admin across several domains:

| Model | What it means | When it fits |
| --- | --- | --- |
| **Global (chosen)** | One admin account (`ADMIN_ADDRESS`) signs in with password + passkey and manages **every** domain and mailbox. | One person or organization owns all the domains. This is how the app works today, just with more than one domain. |
| Per-domain | Each domain has its own admin (e.g. `admin@example.org` can only manage `example.org` mailboxes). | You host domains for *other* people who shouldn't see each other's mailboxes. This is multi-tenant hosting and would need a new authorization layer. |

Consequences of the global model:

- `ADMIN_ADDRESS` lives on one domain (normally the primary). Login, MFA and step-up stay exactly as in v2.07.
- The local part `admin` stays **reserved on every domain**, so nobody can create `admin@example.org` as a regular mailbox and confuse it with the real admin.
- No schema column for domain ownership is added. If per-domain admins are ever needed, it'll be a separate design.

## Cloudflare constraints

- **Inbound:** each domain must be a zone on Cloudflare DNS in the same account, with Email Routing enabled and its **catch-all rule** set to *Send to a Worker → (this worker)*. Routing is per zone; there is no cross-zone catch-all.
- **Outbound via Cloudflare:** each domain must be onboarded for Email Sending (SPF/DKIM). The existing `MULTI_SENDER_APPROVED` policy gate still applies to non-primary senders. Domains that use Resend are covered in [v3.02](./OUTBOUND_TRANSPORTS.md).
- **Passkeys:** the WebAuthn RP ID is the **app host** (`APP_ORIGIN`), not a mail domain, so existing passkeys keep working no matter how many mail domains are added.

## Data model

Migration `0016_domains.sql`:

```sql
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  outbound_transport TEXT NOT NULL DEFAULT 'cloudflare'
    CHECK (outbound_transport IN ('cloudflare', 'resend', 'none')),
  postmaster_mailbox_id TEXT REFERENCES native_mailboxes(id),
  dns_checked_at TEXT,
  dns_report TEXT,                -- JSON from the last DNS check, shown in the admin UI
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_single_primary ON domains (is_primary) WHERE is_primary = 1;

ALTER TABLE native_mailboxes ADD COLUMN domain TEXT;
UPDATE native_mailboxes SET domain = lower(substr(email_address, instr(email_address, '@') + 1));
CREATE INDEX IF NOT EXISTS idx_native_mailboxes_domain ON native_mailboxes (domain, status);
```

`outbound_transport` is created here (default `cloudflare`) so that v3.02 needs no further domain migration.

### Bootstrap

- On startup, `ensurePrimaryDomain(config)` upserts `config.primaryDomain` as `active` and `is_primary = 1`.
- Optional `MAIL_DOMAINS=example.org,example.net` in `.env` creates any listed domain that doesn't exist yet as `pending`. Removing a domain from `.env` **never** disables or deletes it; that is always an explicit admin action, so a typo in `.env` can't cut off mail.

## Address rules

`normalizeMailboxAddress` in `mailboxRules.ts` stays pure and dependency-free, but takes its domain set as input:

```ts
export function normalizeMailboxAddress(
  value: string,
  opts: { domains: ReadonlySet<string>; defaultDomain: string; allowReserved?: boolean },
): string | null;
```

- A bare local part (`work`) still means the **primary** domain, as today.
- The domain must be in `domains` (callers pass active domains for routing and sending, and active + pending for admin creation).
- ASCII / punycode domains only; reject raw Unicode (IDN) input, length > 253, and labels that aren't valid.
- The reserved local parts (`postmaster`, `abuse`, `mailer-daemon`, `root`, `admin`) apply on every domain.

`mailboxForRecipient` alias resolution becomes per-domain:

- `postmaster@d` / `abuse@d` → the domain's `postmaster_mailbox_id`, falling back to the primary mailbox.
- `local+tag@d` → `local@d` on the **same domain only**. `a+x@b.com` must never resolve to `a@c.com`.
- An address on a `pending` or `disabled` domain is rejected at SMTP time, like an unknown mailbox today.

## Inbound

- `receive.ts` checks the envelope recipient's domain against active domains before looking up the mailbox.
- The fallback Message-ID uses the **receiving mailbox's** domain instead of `email.liamthemo.com`.
- `FORWARD_TO` behaviour is unchanged (primary mailbox only).

## Outbound

- The sender's domain must be `active` and its `outbound_transport` not `none`.
- v3.01 itself only supports `cloudflare`: primary address → `EMAIL`, other addresses → `EMAIL_MULTI`, gated by `MULTI_SENDER_APPROVED`. v3.02 adds Resend.
- From identity stays server-derived, as in v2.

## Admin UI

New **Domains** section in `AdminPanel`, above Mailboxes:

- List with status, mailbox count, transport, and when DNS was last checked.
- **Add domain** → created as `pending`. Shows a setup checklist for that domain:
  1. Zone exists on Cloudflare and Email Routing is enabled.
  2. MX records point to Cloudflare Email Routing.
  3. Catch-all rule → this Worker.
  4. SPF includes the selected sending provider.
  5. DKIM record present for the selected provider.
  6. DMARC record present (advisory).
- **Check DNS** runs MX/TXT lookups from the Worker over DNS-over-HTTPS (`https://cloudflare-dns.com/dns-query`) and saves the result to `dns_report`. Checks are advisory; the admin can activate a domain whose DMARC is missing, but not one without MX.
- **Activate / disable / set postmaster mailbox** require admin step-up and write `admin_security_events`.
- Disabling a domain rejects new inbound mail and blocks sending; its mailboxes and stored mail stay intact and readable.
- **Mailbox creation** gets a domain picker (active + pending domains). Address validation errors name the allowed domains instead of `liamthemo.com`.

## Limits

`MAX_MAILBOXES` (default 100) stays global across all domains and becomes configurable through `.env`.

## Tests

Extend `scripts/test-mailbox-rules.mjs`:

- Bare local parts map to the primary domain; addresses on unknown domains are rejected.
- Cross-domain plus-alias spoof (`a+x@b.com` with only `a@c.com` existing) → `null`.
- `admin@<any domain>` reserved; `postmaster@d` resolves to that domain's postmaster mailbox.
- Uppercase / whitespace normalization per domain; IDN input rejected; `example.com.evil` rejected.

Extend `scripts/test-mailbox-migration.py`: `0016` backfills `domain` for legacy rows and leaves `native:primary` untouched.

## Exit gate

- [ ] A second test domain receives mail into its own mailboxes; the primary domain is unaffected.
- [ ] Addresses on pending/disabled domains are rejected at SMTP time.
- [ ] No cross-domain alias resolution.
- [ ] Domain changes require step-up and appear in the security log.
- [ ] Existing passkeys, device sign-ins and Gmail accounts keep working.
