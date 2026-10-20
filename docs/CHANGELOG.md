# Changelog

What changed in each v3 version, with the technical detail. `main` runs the version in `package.json` and is deployed by GitHub Actions (`.github/workflows/deploy.yml`); each version branch `vX.XX` contains everything before it. Setup and operation: [README](../README.md). What an operator has to do when updating: [UPGRADING.md](./UPGRADING.md).

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
| `v3.13` | Forks: deploy a GitHub fork with Cloudflare and update with Sync fork; app version and update notice; licence allows unmodified forks |
| `v3.14` | End-to-end and unit tests; fixes from a security and bug review; real outbound Message-IDs (migration 0024) |
| `v3.15` | Simpler fork deploys: the first GitHub Actions deploy creates the D1 database and R2 bucket; missing secrets are named |
| `v3.16` | Fork deploys also provision when the Worker exists without a database (an earlier failed setup); an unreadable Worker names the account and permissions |
| `v3.17` | New compose icon; mail with squeezed table layouts no longer renders one letter per line |
| `v3.18` | Reliable phone notifications: re-registration on start, sign-ins renewed while used, high-urgency pushes, Home Screen hint on iPhone; sender and subject in alerts; admin phones alerted for every mailbox (migration 0025) |
| `v3.19` | Images in mail: embedded images shown, remote images through a private image proxy (or on request), older mail rebuilt once (migration 0026) |
| `v3.20` | The deploy creates the encryption key (`PROVIDER_CREDENTIAL_KEY`) when missing, so push keys generate on their own; passkey-protected key backup in Admin → Keys |
| `v3.21` | Status badges for every key in Admin → Keys and a **Setup incomplete** notice when an essential key is missing |
| `v3.22` | GitHub Actions deploys hand the deploy token to the app (`CLOUDFLARE_DEPLOY_CONNECTION`), so domain setup works without connecting a token in the app |
| `v3.23` | Three-line new-mail alerts: sender, subject, preview |
| `v3.24` | Repository cleanup: unused routes and scripts removed, shared Worker helpers, bug and security fixes, dependency updates, reorganised docs |
| `v3.25` | Sign in with a username and a domain picked from a list; one Cloudflare token for deploys and the app |
| `v3.26` | Appearance is cached on the device, so themes, accents and icons no longer flash while the app starts or switches mailbox |
| `v3.27` | Phones: folders in a drawer from the left instead of a bottom tab bar, New message in the bottom-right corner, and an open message's actions along the bottom edge |
| `v3.28` | Desktop: equal-width message actions in order, with short labels (Unsub) when a word does not fit; list and message take turns in windows under 1280px; nothing runs off the bottom of short windows; aligned pane headers; sender names on one line |
| `v3.29` | Admin panel normalized (one button size, themed dropdowns, green set-up chips, a steady chevron); attachments open in the system viewer and never replace the app; a solid status-bar strip for iOS 26 Safari |

## Decisions applied in v3.05

| Decision | Result |
| --- | --- |
| Cloudflare sending without a token | One unrestricted `EMAIL` send binding is the default (no token, no per-address allowlist, no `MULTI_SENDER_APPROVED` gate); every active mailbox on an active domain can send. The Email Sending REST API is used instead only when `CF_EMAIL_SENDING_TOKEN` is set. `EMAIL_MULTI`/`EMAIL_DYNAMIC` are gone. Resend stays opt-in per domain. |
| Config off the Worker | No instance vars. Origin, passkey RP ID and admin sign-in come from the request URL (v2.08). Primary mailbox and domains come from D1 via first-run setup; branding, forwarding, mailbox limit and purge are admin settings in D1. `.env` holds only Worker secrets and deploy keys. The only rendered var is `CF_EMAIL_SENDING_ACCOUNT_ID`, copied from `CLOUDFLARE_ACCOUNT_ID`. |
| `PRIMARY_ADDRESS` removed | The primary mailbox is `native:primary` in D1; its domain is the primary domain. v2 installs are adopted automatically. (Since v3.08 admin@ replaces the primary mailbox.) |
| Per-domain theme | Admin picks a theme per domain; mailboxes on it use that theme (falls back to the instance default). Users override it only if the theme is unlocked. |
| Licence | Free self-hosting for personal and internal organizational use (including commercial), credit required; no redistribution, no hosting for others, no paid services. |

Superseded design details: `BRANDING_SOURCE`, `MAIL_DOMAINS` seeding and `ADMIN_ADDRESS` from the [v3 design records](./history/v3-design/README.md) no longer exist; the policy gate in [OUTBOUND_TRANSPORTS.md](./history/v3-design/OUTBOUND_TRANSPORTS.md) is replaced by the API transport.

## Verified at v3.06

- `npm run typecheck`, `npm run build` and `npm test` pass on `v3.06` (30 Node test scripts, including all v2.08 regressions).
- Default theme is declaration-for-declaration identical to v2.08 (3745 declarations); every preset covers v2.08's new dialogs.
- Migrations 0001–0020 apply cleanly (node:sqlite) and seed no instance-specific data; 0016–0020 applied in production.
- Stored keys (v3.06) run against the real migrations: encryption, write-only API, Worker-secret mirroring, one-time VAPID generation.
- Settings window scrolls to its last section on desktop and phone sizes (checked in Chromium).
- Review fixes: passkey registration requires first-run setup; Resend webhooks only throttle failed signatures (per IP); oversized Cloudflare messages are refused before quota is reserved; accents are checked against the mailbox's domain theme; the primary domain is cached per isolate and the account list uses one domains query.

## Not verified at v3.06 (needs a real account or devices)

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

## v3.13: forks and updates

- **Licence:** section 1A allows a public GitHub fork used only to run and update your own instance, while it holds no changes beyond upstream updates.
- **Fork deploys:** the GitHub Actions deploy runs in every fork on pushes to `main`, with the fork's `CLOUDFLARE_*` secrets; optional repository variables override the Worker, database and bucket names. A failed database lookup stops the deploy, so an existing instance is never bound to a new, empty database. (Workers Builds without deploy keys still works: `config-render.mjs` leaves the database ID out and Wrangler links it by name.)
- **Updates:** `package.json` carries the release version (`APP_VERSION`). `GET /api/admin/version` compares it with `main` of the project repository (cached six hours); the admin panel shows the version and an update notice pointing to **Sync fork**. Bump `version` with each release.
- **Requires manual validation:** a fork imported into a fresh Cloudflare account end to end.

## v3.14: tests and review fixes

- **Tests:** `npm run test:e2e` runs the real Worker locally (`wrangler dev`) with Chromium and a virtual passkey: setup, mailbox creation, inbound mail, safe reading of hostile HTML, attachments, access control, junk and blocking, sending, conversations, redelivery, drafts, All inboxes, sign-out, disabling a mailbox, and draft saves racing a discard or send. A second suite renders 27 XSS payloads in the reader frame. CI runs both (`e2e` job). `scripts/test-unit-core.mjs` and `scripts/test-audit-fixes.mjs` add unit and regression tests.
- **Sign-in:** rate limits group IPv6 clients by /64 and also limit each mailbox (30 attempts per 15 minutes, counted before the password check; a success clears them); disabling or deleting a mailbox signs out its devices at once; the first passkey is registered atomically; bodies without a length are refused.
- **Receiving:** HTML handling is linear-time (crafted mail can no longer stall the Worker), and the first sanitizer pass is no longer fooled by quoting, spacing, length, `/` separators or tags that reassemble; a failed store releases its delivery claim so Email Routing's retry is kept; attachment names lose bidi controls; HTML is capped at 2 MB.
- **Junk:** only the receiving server's result counts (the topmost Cloudflare `Authentication-Results` or `ARC-Authentication-Results`, else the topmost), so a forged `dkim=pass` no longer rescues failing mail; `List-Id` excuses a DMARC failure only when the list's own domain signed the message; a contact skips content checks only with DMARC or aligned DKIM.
- **Sending:** a failed send can be retried with the same message; Gmail replies join their thread and Gmail forwards keep attachments; subjects lose line breaks; stricter address check; only reply headers reach the Cloudflare binding.
- **Message-IDs:** sent mail stores its real RFC Message-ID, never a provider's own ID, so replies thread. The Cloudflare binding reports it; Resend sends it with its webhooks; the Cloudflare REST API cannot report or set one, so it is learned from the first authenticated, non-junk reply (same recipient, same subject, sent in the last 30 days). Migration 0024 brackets older IDs and clears provider IDs stored before.
- **Drafts:** saves run one at a time in order; discarding, sending or changing the sender waits for a save in flight, so a slow autosave never brings a draft back; the server refuses to recreate a sent draft or reuse another mailbox's draft id; a draft that cannot be saved says so; Gmail drafts are deleted when sent; up to 200 drafts per mailbox.
- **Mail list:** in the reader, archive, junk and delete apply to the whole conversation (archive and junk leave your own replies in Sent; undoing restores all of it); bulk actions apply to the selected messages; opening a conversation updates the unread count by every message it reads; sending from another account switches to it cleanly.
- **Domains:** a subdomain gets its own Email Routing MX records even when the zone already has routing; a catch-all that already forwards elsewhere is only replaced after confirmation.
- **Migrations:** the in-app runner keeps `CASE … END` inside triggers together.
- **Requires manual validation:** Gmail reply and forward with an attachment, the junk verdict on real Cloudflare-delivered mail, the Message-ID of mail sent through Resend (needs its webhook), and that the Cloudflare binding's `messageId` is the header recipients see.
- **Known limits (low):** a late autosave from a second tab can recreate a Gmail draft after sending; text typed while Send waits for a draft save is not sent; signing a device out does not revoke its Gmail token (removing the account does).
- **Kept by decision:** mailbox passwords stay 4–32 characters; Google sign-in stays open to any Google account.

## v3.15 and v3.16: simpler fork deploys

- **First deploy provisions:** when the Worker does not exist yet in the account, the GitHub Actions deploy creates the D1 database and R2 bucket by name (`provisionFirstDeploy` in `scripts/config-lib.mjs`). An existing Worker resolves its own database as before, and a failed lookup still stops the deploy, so an instance is never pointed at a new, empty database.
- **Clear failures:** a first workflow step names missing or malformed `CLOUDFLARE_*` secrets; R2 and D1 errors say which permission or dashboard step is missing. The run summary shows the workers.dev address.
- **Fork steps:** fork → enable Actions → token (*Edit Cloudflare Workers* + D1: Edit) → two repository secrets → run **Deploy production**.
- **Requires manual validation:** a first deploy into a fresh Cloudflare account.
- **v3.16:** a Worker that exists without a DB binding (made in the dashboard, or left by an earlier failed setup) has no data, so it is provisioned like a missing one. A Worker that cannot be read stops the deploy and names the account ID and token permissions to check.

## v3.17: compose icon and narrow mail

- **Compose icon:** a rounded square with a pencil, matching the other outline icons (and tinted in the duotone set).
- **One letter per line:** the reader set `overflow-wrap: anywhere`, which lets a single letter count as a table cell's minimum width; a squeezed newsletter layout then stacked its text letter by letter. It now uses `break-word`, and wide tables keep their width so the reader scales them to fit, as mail apps do. The sanitizer e2e suite renders such layouts at phone width and requires whole words.

## v3.18: reliable phone notifications

- **Why alerts stopped on some phones:** a push subscription is bound to the sign-in it was made in, and device sign-ins ended after a fixed 30 days. The phone kept its subscription and showed notifications as on, but the server only alerts live sign-ins, so alerts stopped silently.
- **Fixes:** the app re-registers its subscription on every start (so a new sign-in takes it over); a device sign-in is renewed for 30 days, with the same token, when the app is opened after a week; the service worker registers a subscription the browser rotates (`pushsubscriptionchange`); pushes are sent with high urgency (Android delivers them while idle) and a 24-hour TTL; failed deliveries log the push service and its reason.
- **iPhone/iPad:** outside an installed Home Screen app the bell says **Add to Home Screen for notifications** instead of "unavailable". Settings now says alerts show the sender, subject and a preview (they always did).
- **Alert text:** the sender is the title; the body is the subject, then a short preview.
- **Administrator:** a phone that turns alerts on while signed in as admin gets alerts for every mailbox for 30 days, renewed each time the app starts with the admin signed in. Admin passkey sessions stay short (12 hours, 1 hour idle); signing out as admin, signing out other sessions, ending that session or changing the admin password stops it (`push_subscriptions.all_mail_until`, migration 0025).
- **Requires manual validation:** an iPhone installed from the Home Screen and an Android phone receiving an alert after the update.

## v3.19: images in mail

- **Embedded images (`cid:`)** were stored as attachments but never shown. Attachments now keep their Content-ID; opening a message points the image at `/api/attachment-previews/<id>` (raster types only) and leaves it out of the attachment list.
- **Remote images** were deleted from the stored HTML. The sanitizer now keeps the address in `data-remote-src`, which never loads by itself. The reader shows it through `GET /api/image-proxy?url=…` (signed-in users only): public http(s) addresses on standard ports, redirects re-checked, images only, 10 MB cap, sandboxing CSP, cached in the reader's browser for a day. Senders see Cloudflare, never the reader's IP address, cookies or browser; they can still tell the email was opened.
- **Setting:** Settings → Images in mail → Remote images: shown automatically (default) or "Ask first" with **Show images** / **Always show** in the reader. Per device.
- **Older mail** (`messages.html_version` 1) is rebuilt once from its raw message when opened (up to 10 per conversation per open), which restores remote image addresses and fills in Content-IDs (migration 0026).
- **Requires manual validation:** newsletters with embedded logos and remote images on a phone.

## v3.20: encryption key created automatically

- **Why instances lacked push notifications:** VAPID keys are generated and stored encrypted with `PROVIDER_CREDENTIAL_KEY`, which only setup with a Cloudflare token (or connecting one in Admin → Keys) created. An instance set up with the setup secret had neither.
- **Deploy:** `npm run deploy` (GitHub Actions) ends with `scripts/ensure-worker-secrets.mjs`, which creates the Worker secret through the Cloudflare API when it is missing, never replacing an existing one. Problems are warnings; a deploy that succeeded never fails on this step. The app then generates its VAPID pair on the next request.
- **Backup:** Admin → Keys → **Back up encryption key** shows the key after a passkey approval (audited as `admin.encryption_key.shown`).
- **Requires manual validation:** a fork deploy creating the key, then push notifications on that instance.

## v3.21: key setup status at a glance

- **Admin → Keys:** each key has a status badge (green **Set up** / **Connected**, red **Missing**, grey **Not set** for optional keys) and a coloured edge; a summary at the top says whether the essential keys are in place and what each missing one breaks.
- **Essential keys:** the encryption key (`PROVIDER_CREDENTIAL_KEY`) and the push notification (VAPID) keys. Cloudflare and the provider keys are optional.
- **Admin page:** when an essential key is missing, a red **Setup incomplete** notice sits above the section links with a **Fix in Keys** link, and the Keys link has a red dot.
- **Tests:** `scripts/test-key-status.mjs`; the end-to-end suite checks the badges on a configured instance.

## v3.22: the deploy token connects Cloudflare

- **Deploy:** `npm run deploy` runs `scripts/wrangler-deploy.mjs`. On the GitHub Actions deploy from `main` it passes `wrangler deploy --secrets-file` with one Worker secret, `CLOUDFLARE_DEPLOY_CONNECTION` (`{ token, accountId, scriptName }` from `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and the Worker name). It goes up with the new version (no extra deployment); other secrets are kept; the temporary file is private and deleted. Version branches and deploys from a computer pass nothing.
- **Why a Worker secret, not D1:** D1 values are encrypted with `PROVIDER_CREDENTIAL_KEY`, which Cloudflare never returns, so the deploy cannot encrypt for D1. A Worker secret is encrypted by Cloudflare and follows the GitHub secret on every deploy.
- **App:** `cloudflareConnection` uses a token connected in Admin → Keys first, then the deploy's. Admin → Keys shows **Using the deploy's token** (hint only; no Remove, since the next deploy would bring it back). Domain setup and **Re-check Cloudflare setup** use it.
- **Unchanged:** first-run setup still needs a pasted token or the setup secret as proof of ownership; the deploy token is never accepted as proof.
- **Security:** the Worker holds the deploy token (Workers Scripts, D1, R2 edit). An in-app token already needed Workers Scripts: Edit, so the added reach is D1 and R2, which the Worker already has through its bindings.
- **Requires manual validation:** Admin → Keys on a fork after its next deploy; domain setup with a deploy token that has the email and DNS permissions.

## v3.23: notification layout

- Every new-mail alert is three lines: the sender's name (or address when there is none) as the title, then the subject, then the start of the message. Administrator alerts for other mailboxes no longer add "→ mailbox" to the title.

## v3.24: repository cleanup

- **Removed:** `GET /api/profile` (no caller since v3.10; photo state comes with the account list), `GET /api/contact-avatar` and `POST /api/auth/logout` (every sign-out uses `/api/device/logout`, which also ends the admin session). New Gmail connections ask only for mail and profile access, no longer `contacts.readonly`; existing grants keep working. The package scripts `cf-typegen`, `db:migrate:local` and `db:migrate:remote` and `scripts/audit-css-colors.mjs` (covered by `test-css-tokens`) are gone.
- **Shared code:** one set of byte, hashing and token helpers (`src/worker/bytes.ts`), one `jsonError` (`src/worker/http.ts`), shared message-row, quota and admin-request helpers, push state in its own hook, one in-memory D1 stub for tests. A test script listed in the run but missing now fails the run.
- **Security:** mail CSS can no longer make the reader's browser call the app's own API (the mail frame allows only embedded images and, once remote images are shown, the image proxy), so with **Ask first** a message cannot load remote images through CSS before you approve them; request bodies are capped while they are read, even without a `Content-Length`; sign-in attempts are counted per mailbox, whichever address form is typed; the app shell sends the same HSTS header as static assets; Gmail sign-in states expire after ten minutes; Resend webhook events are recorded only once processed, so a failed write is retried.
- **Fixes:** Gmail attachments preview and download; any message of a conversation longer than 100 opens (the newest 100 are shown); HTML entities in previews and alerts are decoded once; `%` and `_` are literal in search; sent mail no longer doubles line breaks; Edge on Windows can turn on alerts (`*.notify.windows.com`); account colours and sender blocks stay within D1's 100 bound parameters; purging an attachment-heavy mailbox deletes R2 files in batches of 1,000; removing admin sessions asks for the passkey; compose and settings open above the desktop top bar; clicking a notification focuses the open window without reloading it; Reply, Forward and drafts start without stale attachments, and several list, badge and draft count glitches are fixed.
- **CSS:** 673 declarations that were always overridden, rules for 17 classes no markup uses and four unread custom properties are gone (the stylesheet bundle drops from 209 kB to 186 kB); rendering is unchanged. `verify-css-equivalence` now compares the declarations that win the cascade, selector by selector.
- **Dependencies:** `@simplewebauthn/server` 14, `postal-mime` 4.0.11; Node.js 22.12 or later (`engines` in `package.json`); Dependabot targets the current version branch.
- **Docs:** sign-in docs merged into [SIGN_IN.md](./SIGN_IN.md), the v3 status page became this changelog, design records moved to [history](./history/README.md).

## v3.25: username and domain sign-in

- The sign-in form and Add inbox take a username, with the domain picked from a list on the right of the same field of the instance's active domains (main domain first; one domain is shown without a list). The last domain used is remembered on that browser, and a full address still works. `GET /api/instance` lists the active domains for it.
- One Cloudflare API token for everything: the README and the app list the same nine permissions, and **Create a Cloudflare token** now pre-selects the deploy permissions too (D1, Workers R2 Storage, Account Settings) as well as the domain ones, leaving only Email Sending and Email Routing Rules to add by hand. A test keeps the list, the link, the README and the Worker's permission messages in step.

## v3.26: no appearance flash

- Each mailbox's look (theme, accent, density, text size, icon set) is kept in this browser, so opening or switching to a mailbox shows it before the server answers; the server's answer still updates it.
- Until the app knows whether it shows a mailbox or a signed-out screen, it keeps the look applied at start-up instead of briefly switching to the instance defaults. Sign-in, setup and the admin panel ask for the instance's look themselves.
- The public instance details (name, accent, default theme and icon set, logo) are cached too, so the first screen does not wait for them.
- An end-to-end test records every theme and accent shown while the app reloads and expects only the mailbox's own.

## v3.27: phone navigation drawer

- The tab bar along the bottom of the phone layout is gone. The menu button at the left of the account bar opens the folders in a drawer that slides in from the left, with the unread and draft counts; choosing a folder, tapping outside or pressing Escape closes it. A dot on the menu button shows when the Inbox has unread mail.
- New message is a round button in the bottom-right corner.
- With a message open, its actions sit in one row of icon-over-label buttons along the bottom edge, above the home indicator, where the tabs were. The reader's top bar keeps only Back and Star; the duplicate action icons it had on phones are gone.
- The message actions run Reply, Forward, Archive (or Not junk), Junk, Unsubscribe, Delete (or Restore, then Delete forever in Trash), on phones and in the desktop footer alike (Block stays desktop-only, after Unsubscribe). Otherwise desktop is unchanged.

## v3.28: desktop reader fixes

- The message actions are equal-width buttons in one row, in the order Reply, Forward, Archive (or Not junk), Junk, Unsubscribe, Delete (Restore and Delete forever in Trash), on every screen. Each button is a CSS size container: when the word does not fit, Unsubscribe shows as **Unsub** and Delete forever as **Del forever**; in the narrowest desktop windows a button drops its icon before its word is cut. Block left the bar and is in the Unsubscribe dialog, as it already was on phones.
- Windows from 761 to 1279px wide no longer squeeze the open message between the sidebar and the list (the reader shrank to a sliver and its text broke a word or a letter per line): the list and the open message take turns, with a Back button, and the search bar stays.
- Desktop windows under about 750px tall no longer push the bottom of the reader and its action bar off screen: the row fits the window and the sidebar scrolls instead.
- The list's tab row (or the Drafts label) and the reader's title bar are both 61px tall, so their bottom borders form one line across the two panes (they were 12px apart).
- Sender names in the list and the reader heading are shown with non-breaking spaces, so no browser can break a name across lines (Safari on iPad showed "Intern / Insider" on two lines); a long name still ends in "…".

## v3.29: admin panel, attachments, iOS 26 top bar

- **Admin panel:** one stylesheet (`admin-ui.css`, loaded last, scoped to `#root .admin-home`) gives every section the same controls: primary, secondary and danger buttons of one height (36px) and text size (12px); fields and dropdowns of one height (40px) and text size (13px), with themed dropdowns that keep the phone's native picker; theme-coloured checkboxes; one pill for every status, green for anything enabled, active or set up (Passkey enabled, Active, Main, successful activity), red for problems; and one drawn chevron for every expanding row that turns in place (More actions used to swap glyphs and jump). Section labels match the navigation (Mailboxes, Keys, Security, Activity), and "(optional)" sits beside its field name.
- **Attachments:** the viewer has **Open** (the browser's or the system's own viewer, which has its own Done button in a Home Screen app) next to **Download**, and both open outside the app: in an installed app a plain link replaced the app with the file and left no way back. Tapping outside the file closes the viewer. The server still serves only images and PDFs inline, under a script-free Content-Security-Policy, and every other file as a sandboxed download.
- **iOS 26 Safari:** Safari blurs whatever sits under its top bar unless a solid, full-width element touches the top edge; a strip in the page colour now fills the status bar area and the gap above the account bar on phones.

