# v3 implementation status

**Status:** Implemented on version branches `v3.00` → `v3.06`; `v3.06` contains everything, including v2.08. `v3.05` is merged to `main`; production deploys from `main` through GitHub Actions (`.github/workflows/deploy.yml`). The new self-hosting [`LICENSE`](../../LICENSE) is in place on `v3.05`.

## Branches

| Branch | Content |
| --- | --- |
| `v3.00` | Config unification (first version: `.env` vars) |
| `v3.01` | Multi-domain |
| `v3.02` | Outbound transports + Resend |
| `v3.03` | Theme foundation (CSS tokens) |
| `v3.04` | Branding, lock, themes, icons, credit |
| `v3.05` | v2.08 merged; instance settings moved into D1; Cloudflare Email Sending API for all Cloudflare sending; per-domain themes; licence; GitHub Actions deploys |
| `v3.06` | Integration keys in D1 (Admin → Keys), encrypted with `PROVIDER_CREDENTIAL_KEY`; VAPID generated automatically (migration 0020) |

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

- `npm run typecheck`, `npm run build` and `npm test` pass on `v3.06` (30 Node test scripts, including all v2.08 regressions).
- Default theme is declaration-for-declaration identical to v2.08 (3745 declarations); every preset covers v2.08's new dialogs.
- Migrations 0001–0020 apply cleanly (node:sqlite) and seed no instance-specific data; 0016–0020 applied in production.
- Stored keys (v3.06) run against the real migrations: encryption, write-only API, Worker-secret mirroring, one-time VAPID generation.
- Settings window scrolls to its last section on desktop and phone sizes (checked in Chromium).
- Review fixes: passkey registration requires first-run setup; Resend webhooks only throttle failed signatures (per IP); oversized Cloudflare messages are refused before quota is reserved; accents are checked against the mailbox's domain theme; the primary domain is cached per isolate and the account list uses one domains query.

## Not verified (needs a real account or devices)

- Live inbound mail on a second domain; real sends through the Email Sending API and Resend; Resend webhooks; bounce suppression.
- WebAuthn ceremonies (first-run setup, step-up for admin changes).
- `npm run setup` / `deploy:self` against a fresh account.
- iPhone/iPad PWA appearance per preset.

## v3.06: keys in D1

- Gmail, Resend and Cloudflare sending keys are entered in **Admin → Keys** and stored in `instance_keys`, AES-GCM encrypted with the `PROVIDER_CREDENTIAL_KEY` Worker secret and bound to the key name. Values are write-only: the API returns only the source and a short hint. Saving or removing a key needs an administrator step-up and is audit-logged (`admin.key.updated` / `admin.key.removed`).
- A Worker secret with the same name takes precedence and is mirrored into D1 whenever it differs, so deleting the Worker secret later keeps the latest value.
- The VAPID pair is one row. An existing Worker secret pair is copied in (existing push subscriptions keep working); otherwise a pair is generated once.
- Without a valid `PROVIDER_CREDENTIAL_KEY`, the Worker behaves exactly as before (Worker secrets only).
- Resolved keys are cached per isolate for a minute; a change applies at once on the isolate that saved it.
- `npm run setup` generates `PROVIDER_CREDENTIAL_KEY` when `.env` has none.

## Production rollout (LTM instance)

**Done (2026-10-18):** D1 and R2 backed up; Workers Builds replaced by GitHub Actions after its build token kept failing; `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are repository secrets; v3.06 deployed from `main` with migrations 0016–0020; `email.liamthemo.com` serves v3 with `liamthemo.com` adopted as primary, Gmail and push enabled.

Remaining, by hand:

1. Disconnect Git under the Worker's **Settings → Build** if it is still connected, so Workers Builds stops running.
2. Admin panel: **Branding → App name** `LTM Mails`; **Mailboxes → contact@ → Sender name** `Liam` (otherwise outgoing mail shows `LTM Email`); re-enter forwarding or purge in **Mail settings** if used before.
3. Check: Domains shows `liamthemo.com` as primary and active; `admin@liamthemo.com` and `admin@email.liamthemo.com` both sign in; passkeys, Gmail, push, inbound and a send, reply and forward with an attachment from `contact@` work; Admin → Keys lists the keys and push keys as stored.
4. Delete Worker settings v3 no longer reads (`MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `FORWARD_TO`, `AUTH_SETUP_TOKEN`). Delete the `GOOGLE_*`, `VAPID_*`, `RESEND_*` and `CF_EMAIL_SENDING_TOKEN` Worker secrets only when a rollback to v2.08 is no longer needed (v2.08 reads them). Never delete `PROVIDER_CREDENTIAL_KEY`.
5. Rollback if needed: redeploy v2.08 (`6c0811a`). The v3 migrations are additive and do not affect it.
