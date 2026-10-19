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
| `v3.07` | All inboxes: one merged list of every account signed in on the device |
| `v3.08` | No primary mailbox: admin@<mail domain> is the administrator's mailbox; admins land in mail and switch to the admin panel and back |
| `v3.09` | Per-mailbox blocked senders (migration 0021) |
| `v3.10` | Per-mailbox profile photos; junk filter on for every mailbox with authentication and content signals (migration 0022) |
| `v3.11` | Native HTML email reader: full reader width, app-themed rendering for ordinary mail, a light card only for designed mail |
| `v3.12` | Easier setup: Deploy to Cloudflare button, in-app migrations, one-page setup with a Cloudflare token, automatic domain wiring (migration 0023) |

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

## v3.07: All inboxes

- Client-only. The account switcher offers **All inboxes** when two or more active accounts are signed in on the device. Each account is listed through its own `/api/messages` request, so the server's per-account authorization is unchanged; there is no new endpoint.
- Lists are merged newest first and each message is tagged with its account (`accountId`). Threads collapse per account, and read-your-writes shields are keyed by the message's own account.
- Opening, PATCH, permanent delete, draft opening, replies and forwards use the message's account. Bulk actions are split into one request per account. An account that fails to load is named in a notice while the others are shown.
- Every folder works in the merged view; counts are summed. Compose defaults to the primary mailbox.

## v3.08: admin@ mailbox, no primary mailbox

- `native:admin` = `admin@<main domain>`: created by first-run setup (which now asks for the mail domain) or by the bootstrap on the first request after upgrading. It cannot be disabled, deleted, purged or given a mailbox password; only the owner session opens it, and the admin addresses are excluded from device grants.
- The former primary mailbox (`native:primary`) keeps its ID, address and mail and is an ordinary mailbox. On a fresh install, setup deletes migration 0010's placeholder row (only while the install holds no data).
- Moved to admin@: default postmaster/abuse mailbox, forwarding, profile photo, VAPID contact, default account for requests without one.
- Sign-in: `admin@<main domain>` on any host, plus `admin@<app host>`; both open the same administrator record.
- Admin sessions open the mail app with every mailbox listed (since v3.10 it opens on All inboxes, like any device with two or more accounts). **Admin panel** in the sidebar and in Settings; **Back to mail** in the panel header; `#admin` keeps the panel across reloads, and the open mailbox is kept per tab.
- Phone layout: the admin panel no longer overflows the screen; its section links scroll.

## v3.09: blocked senders

- `blocked_senders (mailbox_id, pattern)`: a lower-case address, or `@domain` covering the domain and its subdomains (never a bare top-level domain). At most 1000 per mailbox; removed when the mailbox is purged.
- Inbound mail whose header From or envelope sender matches is stored with `is_junk = 1`, so it skips push notifications and forwarding; nothing is bounced.
- `GET/POST/DELETE /api/blocked-senders?accountId=` are authorized per account like the mail API (the mailbox's own session or the admin). Custom mailboxes only; Gmail accounts get a clear refusal.
- Blocking moves the sender's existing inbound mail in that mailbox to Junk (`moveExisting`, default on); unblocking leaves Junk as it is.
- UI: **Block** in the desktop reader, **Block sender** in the Unsubscribe dialog (phones), **Settings → Blocked senders** with a mailbox picker, add and Unblock.
- Fix: choosing the account that is already open no longer leaves the list on "Loading mail…"; it refreshes.

## v3.10: profile photos and junk filtering

- Photos: `/api/profile` and `/api/profile/photo` take `?accountId=` and are authorized against that mailbox (its own session or the admin); admin@ keeps the original R2 key, other mailboxes use `profile/mailbox/<id>.jpg`. `native_mailboxes.photo_version` (migration 0022) feeds account lists and Admin → Mailboxes without R2 lookups; admin@'s earlier photo is adopted once by the bootstrap. Purging a mailbox deletes its photo.
- Junk: migration 0022 turns `spam_filter_enabled` on for every mailbox, and new mailboxes (including admin@) are created with it on. `email/junk.ts` decides: upstream spam flags and failed authentication (DMARC fail, or SPF fail without DKIM pass; skipped for List-Id mail) are decisive; otherwise weighted content signals must reach 4. Senders the mailbox has written to skip content scoring. Only failures in Authentication-Results are used, so a forged header can never make mail look more trustworthy.
- Admin → Mailboxes no longer offers "Change password" for admin@ (it uses the administrator sign-in).
- Start: the app opens on All inboxes when two or more usable accounts are signed in, otherwise on the one account; the last mailbox used on the device no longer decides. Returning from the admin panel in the same tab keeps the open mailbox.
- Phone reader spacing: the open reader's toolbar no longer adds the top safe area a second time; reader actions sit in one compact row (icon above label, labels sized to the screen; 360px and wider fit in full); and in the installed iOS app (`display-mode: standalone`) the root is at least screen-tall, the workaround for the iOS 26 regression (WebKit 301108) that left an empty band under the tab bar. Chromium cannot reproduce that regression, so the last part needs a check on an iPhone.

## v3.11: native email reader

- HTML mail fills the reader column (the 760px cap and the always-white card are gone).
- After the sandboxed document loads, `emailTheme.ts` classifies it from computed styles. Any background image, or coloured (not white, not clear) backgrounds covering over 20% of the email, makes it **paper**: shown on a light card with its own colours. Everything else is **native**: transparent, the app font and text colour, accent links; white backgrounds are dropped, and text colours under 4.5:1 contrast against what is actually behind them are replaced.
- The email document is given the app's `color-scheme`; a mismatch makes browsers paint the frame on an opaque white canvas. Paper mail uses `color-scheme: light`.
- Wider-than-reader mail (600px newsletters on phones) is scaled with `zoom` to fit; the frame height follows the content with a ResizeObserver; the frame stays hidden until it is adapted, so there is no flash of unadapted mail. A real theme change re-renders the open email.
- Unchanged: sanitization in `emailHtml.ts`, the CSP (no remote images, scripts, forms or frames) and the iframe sandbox (no `allow-scripts`). `email-html.css` is excluded from `verify-css-equivalence` as a redesigned stylesheet; `test-email-reader` covers it.

## v3.12: easier setup

- **Deploy button:** `wrangler.jsonc` is committed (no account or database IDs) and is the Deploy to Cloudflare button's source; production deploys (`scripts/config-render.mjs`) fill in the D1 ID and vars, and command-line deploys restore the committed file. `.env.example` moved to `config/env.example` so the button asks for no keys. Worker vars: `LTM_WORKER_NAME`; new binding `CF_VERSION_METADATA`.
- **Migrations in the app:** `migrationRunner.ts` applies pending files (bundled with `import.meta.glob`) through the DB binding on the first request per isolate, one atomic batch per file, using Wrangler's `d1_migrations` history. Deploys still run Wrangler first; in Workers Builds a failed Wrangler run only warns.
- **Setup:** `POST /api/setup` takes the mail domain, administrator password and a Cloudflare token (or `AUTH_SETUP_TOKEN`). The token must see the exact Worker version serving the request (`/accounts/:id/workers/scripts/:name/versions/:version`), which proves it belongs to this app's account. Setup creates `PROVIDER_CREDENTIAL_KEY` as a Worker secret only when it is entirely absent (an invalid one is never replaced), stores the connection encrypted (`instance_keys` row `CLOUDFLARE`, migration 0023 rebuilds the table to allow it), wires the main domain, and returns a 30-minute grant (`setup_grants`, hashed) for passkey registration. The administrator finishes signed in.
- **Domains:** `POST /api/admin/domains/:domain/connect` (and `POST /api/admin/domains` with `connect: true`) finds the zone, asks before replacing another provider's MX records, enables Email Routing, points the catch-all at this Worker, onboards Email Sending, adds `v=DMARC1; p=none` if no DMARC record exists, and activates the domain when the zone's MX and catch-all confirm routing. Every step is idempotent and reported.
- **Admin → Keys:** connect, replace or remove the token (`PUT`/`DELETE /api/admin/cloudflare`, passkey step-up). The token is never returned.
- **Requires manual validation:** the Deploy button end to end in a fresh Cloudflare account; the token form link (Cloudflare publishes no template keys for the email permissions, which are added by hand); Email Sending onboarding on a paid plan.

## Production rollout (LTM instance)

**Done (2026-10-18):** D1 and R2 backed up; Workers Builds replaced by GitHub Actions after its build token kept failing; `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are repository secrets; v3.06 deployed from `main` with migrations 0016–0020; `email.liamthemo.com` serves v3 with `liamthemo.com` adopted as primary, Gmail and push enabled.

Remaining, by hand:

1. Disconnect Git under the Worker's **Settings → Build** if it is still connected, so Workers Builds stops running.
2. Admin panel: **Branding → App name** `LTM Mails`; **Mailboxes → contact@ → Sender name** `Liam` (otherwise outgoing mail shows `LTM Email`); re-enter forwarding or purge in **Mail settings** if used before.
3. Check: Domains shows `liamthemo.com` as primary and active; `admin@liamthemo.com` and `admin@email.liamthemo.com` both sign in; passkeys, Gmail, push, inbound and a send, reply and forward with an attachment from `contact@` work; Admin → Keys lists the keys and push keys as stored.
4. Delete Worker settings v3 no longer reads (`MULTI_SENDER_APPROVED`, `MAILBOX_PURGE_ENABLED`, `FORWARD_TO`, `AUTH_SETUP_TOKEN`). Delete the `GOOGLE_*`, `VAPID_*`, `RESEND_*` and `CF_EMAIL_SENDING_TOKEN` Worker secrets only when a rollback to v2.08 is no longer needed (v2.08 reads them). Never delete `PROVIDER_CREDENTIAL_KEY`.
5. Rollback if needed: redeploy v2.08 (`6c0811a`). The v3 migrations are additive and do not affect it.
