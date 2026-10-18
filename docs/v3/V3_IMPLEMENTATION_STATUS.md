# v3 implementation status

**Status:** Implemented on version branches `v3.00` → `v3.05`; `v3.05` contains everything, including v2.08. Not yet merged to `main` or deployed. The new self-hosting [`LICENSE`](../../LICENSE) is in place on `v3.05`.

## Branches

| Branch | Content |
| --- | --- |
| `v3.00` | Config unification (first version: `.env` vars) |
| `v3.01` | Multi-domain |
| `v3.02` | Outbound transports + Resend |
| `v3.03` | Theme foundation (CSS tokens) |
| `v3.04` | Branding, lock, themes, icons, credit |
| `v3.05` | v2.08 merged; instance settings moved into D1; Cloudflare Email Sending API for all Cloudflare sending; per-domain themes; licence |

## Decisions applied in v3.05

| Decision | Result |
| --- | --- |
| Cloudflare sending without a token | One unrestricted `EMAIL` send binding is the default (no token, no per-address allowlist, no `MULTI_SENDER_APPROVED` gate); every active mailbox on an active domain can send. The Email Sending REST API is used instead only when `CF_EMAIL_SENDING_TOKEN` is set. `EMAIL_MULTI`/`EMAIL_DYNAMIC` are gone. Resend stays opt-in per domain. |
| Config off the Worker | No instance vars. Origin, passkey RP ID and admin sign-in come from the request URL (v2.08). Primary mailbox and domains come from D1 via first-run setup; branding, forwarding, mailbox limit and purge are admin settings in D1. `.env` holds only Worker secrets and deploy keys. The only rendered var is `CF_EMAIL_SENDING_ACCOUNT_ID`, copied from `CLOUDFLARE_ACCOUNT_ID`. |
| `PRIMARY_ADDRESS` removed | The primary mailbox is `native:primary` in D1; its domain is the primary domain. v2 installs are adopted automatically. |
| Per-domain theme | Admin picks a theme per domain; mailboxes on it use that theme (falls back to the instance default). Users override it only if the theme is unlocked. |
| Licence | Free self-hosting for personal and internal organizational use (including commercial), credit required; no redistribution, no hosting for others, no paid services. |

Superseded design details: `BRANDING_SOURCE`, `MAIL_DOMAINS` seeding and `ADMIN_ADDRESS` from CONFIG_UNIFICATION.md / MULTI_DOMAIN.md / CUSTOMIZATION.md no longer exist; the policy gate in OUTBOUND_TRANSPORTS.md is replaced by the API transport.

## Verified

- `npm run typecheck`, `npm run build` and `npm test` pass on `v3.05` (29 Node test scripts, including all v2.08 regressions).
- Default theme is declaration-for-declaration identical to v2.08 (3745 declarations); every preset covers v2.08's new dialogs.
- Migrations 0001–0019 apply cleanly (node:sqlite) and seed no instance-specific data.
- Review fixes: passkey registration requires first-run setup; Resend webhooks only throttle failed signatures (per IP); oversized Cloudflare messages are refused before quota is reserved; accents are checked against the mailbox's domain theme; the primary domain is cached per isolate and the account list uses one domains query.

## Not verified (needs a real account or devices)

- Live inbound mail on a second domain; real sends through the Email Sending API and Resend; Resend webhooks; bounce suppression.
- WebAuthn ceremonies (first-run setup, step-up for admin changes).
- `npm run setup` / `deploy:self` against a fresh account.
- iPhone/iPad PWA appearance per preset.

## Production rollout (LTM instance)

1. Back up D1 and R2 and test a restore.
2. Workers Builds keeps `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; no other build variables are needed. Remove any instance build variables added earlier.
3. Worker secrets: `CF_EMAIL_SENDING_TOKEN` is optional (without it, sending uses the `EMAIL` binding). Keep the existing Gmail/VAPID secrets. If `CF_EMAIL_SENDING_ACCOUNT_ID` exists as a **secret**, delete it (it is now a rendered var). `MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `FORWARD_TO`, `PRIMARY_ADDRESS` are no longer read; if you used `FORWARD_TO` or purge, re-enter them in **Admin → Mail settings**.
4. Migrations 0016–0019 are additive and apply during the deploy. They seed no instance data.
5. Right after deploy, in the admin panel: **Branding → App name** `LTM Mails`, and **Mailboxes → contact@ → Sender name** `Liam` (otherwise outgoing mail shows the display name `LTM Email`).
6. Then check: Domains shows `liamthemo.com` as primary and active; `admin@liamthemo.com` and `admin@email.liamthemo.com` both sign in; passkeys, Gmail, push, inbound and a send from `contact@` work.
