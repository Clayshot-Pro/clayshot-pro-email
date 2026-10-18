# LTM Email Service

**A Cloudflare-powered private webmail application** built with React, TypeScript, Vite, Workers, D1, R2, WebAuthn/passkeys and optional Gmail integration.

> **License — read before using this guide.** The source is public for inspection, but this repository is **not open source**. Its [proprietary LICENSE](./LICENSE) does **not** grant permission to copy, modify, run, fork for use, or deploy it. The steps below document installation for the repository owner or anyone who has obtained **separate written permission** from the copyright holder. Public repository access is not deployment authorization. To make community self-hosting generally available, the copyright holder would need to change the license.

## What you are deploying

This is an **authenticated web application**, not a traditional mail server. It does not provide IMAP/POP3/SMTP server accounts for Thunderbird, Outlook, or Apple Mail. Its native inbound messages enter through Cloudflare Email Routing's Email Worker, are indexed in D1 and stored as raw MIME/attachments in R2. Outbound native messages use Cloudflare Email Service bindings **only where the account and intended usage are supported**. Gmail connections use Google's API and OAuth separately.

| Component | Responsibility |
| --- | --- |
| React / Vite + Workers Static Assets | Desktop, mobile, and installable PWA frontend |
| Cloudflare Worker (`src/worker/index.ts`) | Authenticated APIs, Email Worker handler, scheduled cleanup |
| D1 (`DB`) | Mailboxes, message metadata, drafts, sessions, OAuth state, audit logs |
| R2 (`MAIL`) | Raw MIME, attachments and profile photos |
| Cloudflare Email Routing | Deliver incoming mail to the Worker's `email()` handler |
| Cloudflare Email Sending (`EMAIL` / `EMAIL_MULTI`) | Native outbound email where permitted |
| WebAuthn / passkeys | Owner authentication and fresh approval for sensitive admin operations |
| Gmail API | Optional account connection, reading, sending and contacts |
| Web Push / VAPID | Optional browser/PWA notifications |

The UI includes Inbox, Sent, Drafts, Junk, Archive, Trash, search, attachments, threading, mailbox switching, and responsive layouts. Ordinary native mailboxes have separate passwords and device sessions; the administrator uses a separate password **and passkey**.

## Before you start

You will need:

- Written authorization to use this repository (see [LICENSE](./LICENSE)).
- A Cloudflare account with access to **Workers, D1, R2, Email Routing and Email Sending**. Check each product's availability, eligibility, quotas, billing and supported use cases; a no-cost deployment is **not guaranteed**.
- A domain managed with **Cloudflare DNS** for the native mailbox (for example, `example.com`). Its MX records must be compatible with Cloudflare Email Routing.
- A GitHub repository you control, linked to Cloudflare Workers Builds. The provided production pipeline expects a branch named `main`.
- Git, Node.js **22 or later**, and npm. Node 22 is used in GitHub CI; Cloudflare Workers Builds may use a newer supported Node version.
- A passkey-capable device/browser. HTTPS is required for WebAuthn on real domains.
- Optionally, a Google Cloud project for Gmail OAuth and VAPID keys for push notifications.

**Security baseline:** Use fresh, separately owned D1/R2 resources for a new installation. Never point an experimental deployment at someone else's production mailbox storage. Back up both D1 **and** R2 before changing an existing deployment.

## 1. Choose your two domains and addresses

These are **separate settings**:

| Setting | Example | Where configured |
| --- | --- | --- |
| Web app URL | `https://mail.example.com` | Cloudflare Worker custom domain / route |
| Native email domain | `example.com` | Cloudflare Email Routing, Email Sending, mailbox rules |
| Primary native inbox | `contact@example.com` | Wrangler `PRIMARY_ADDRESS` and D1 seed migration |
| Preferred admin login | `admin@mail.example.com` | **Automatically derived** from the Worker's actual hostname |
| Gmail OAuth callback | `https://mail.example.com/api/accounts/gmail/callback` | **Automatically generated**, but must also be added in Google Cloud Console |

The admin username is a reserved **login identity**, not a real mailbox requiring MX records. The web host can change without changing the mail domain.

**Domain-change limitation:** WebAuthn credentials are tied to a specific relying-party hostname. A passkey registered at one hostname cannot simply sign in at a completely different one against the same D1 records. For a fresh installation, register a new passkey on its final hostname. For an existing deployment, see [domain migration precautions](./docs/DEPLOYMENT_DOMAINS.md) **before moving the hostname**.

## 2. Obtain and inspect the source

Only if authorized to use the code:

```bash
git clone https://github.com/LiamTheMo/LTM-Email-Service.git
cd LTM-Email-Service
npm ci
```

You can run the code quality checks without connecting a live email domain:

```bash
npm run typecheck
npm run build
```

Outside Cloudflare Workers Builds, `npm run build` compiles the app but **deliberately skips** production D1 binding hydration and remote migrations. It is not a production deployment.

### Personalize a fresh installation **before applying any migrations**

The repository is configured for its original mail domain, `liamthemo.com`. For **a new, empty database** using `example.com`, change all of the following to your own values:

1. `wrangler.jsonc`: change `vars.PRIMARY_ADDRESS` to `contact@example.com`, set `vars.FORWARD_TO` to an optional verified forwarding address or leave it empty, and replace `send_email[0].allowed_sender_addresses` with your approved primary sender. Set/verify the D1 database and R2 bucket **names** for your account.
2. Native mailbox creation, login, plus-addressing, and postmaster/abuse routing now derive their domain from `vars.PRIMARY_ADDRESS`; do not edit `mailboxRules.ts` manually. Initial D1 seed still needs to match the configured domain (next step).
3. `migrations/0010_native_mailboxes.sql`: **before the first application only**, replace the seeded `native:primary` email address `contact@liamthemo.com` with `contact@example.com`. The primary mailbox ID must remain `native:primary`.
4. Review branding and original-domain text, including `src/worker/push.ts` (VAPID contact address and notification fallback), `src/worker/providers/registry.ts` (default display name) and PWA assets, if rebranding.
5. Do **not** change `wrangler.jsonc`'s zero-valued `database_id` in the committed repository. Production resolves it privately during Cloudflare Builds.

**Already deployed?** Do not edit old SQL migrations in place or assume changing `PRIMARY_ADDRESS` migrates the D1 mailbox records. Use a separately reviewed **new migration** and plan email-routing/data consistency for any existing domain change.

**Worker name caveat:** The recommended first deployment keeps `"name": "ltm-email-service"`. The production verification script expects the generated path `dist/ltm_email_service/wrangler.json`. If you rename the Worker, also update `scripts/verify-production-d1.mjs` and verify Cloudflare build/hydration behavior; renaming `wrangler.jsonc` alone is insufficient.

## 3. Provision D1 and R2 in your Cloudflare account

From the repository root, authenticate to the correct Cloudflare account:

```bash
npx wrangler login
npx wrangler d1 create ltm-email-service
npx wrangler r2 bucket create ltm-email-service-mail
```

Or create both resources in the Cloudflare dashboard. If you use different names, update `wrangler.jsonc`'s `database_name` and `bucket_name` accordingly, keeping binding names **`DB` and `MAIL`**. Record the new D1 database ID privately; it must not be committed to this public repository.

The D1 database initially contains no application tables. The included migration files in `migrations/`, including admin step-up and security-audit schema, will create them.

For optional local testing with a separate local database:

```bash
npm run db:migrate:local
npm run dev
```

Local testing may require a **local-only** Wrangler configuration with the new D1 ID and appropriate mock/remote email bindings. This does not deploy or configure production Email Routing, and the Cloudflare Email Sending binding must not be assumed to send in an offline simulation.

## 4. Bootstrap the Worker and its D1 binding

**This is required for a brand-new Cloudflare account/Worker.** The protected production build intentionally reads the actual D1 database ID from an **already deployed Worker**. Without that prerequisite, the first build cannot resolve the placeholder ID.

In the Cloudflare dashboard:

1. Create a minimal/bootstrap Worker named **`ltm-email-service`** in the same Cloudflare account. This is a temporary bootstrap; it must not process live email or be trusted as the final application.
2. In that Worker's **Settings > Bindings**, add a D1 binding named **`DB`** pointing to the D1 database created above. Confirm the Worker has been **saved/deployed** with that binding so its settings are readable through the Cloudflare API.
3. Provision or attach the R2 bucket named in `wrangler.jsonc`. The final Wrangler deployment must expose it under binding **`MAIL`**.
4. Do not activate live Email Routing or issue administrator credentials until the full application and D1 migrations are deployed.

**Why this step exists:** `scripts/hydrate-production-d1.mjs` requests the deployed Worker's settings, finds **exactly one** D1 binding called `DB`, and temporarily substitutes that private ID during the Cloudflare production build. The placeholder in Git stays unchanged. It is not safe to publish a production D1 ID merely to get a first build passing.

Cloudflare dashboard labels can evolve. Follow the [official D1](https://developers.cloudflare.com/d1/) and [Workers Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/) guides if the controls are named differently.

## 5. Configure inbound Email Routing

After deploying the actual Worker (step 8):

1. In **Cloudflare > Email Service > Email Routing**, enable Email Routing for your **mail domain**. Review the MX/TXT records that Cloudflare wants to manage. Do not overwrite unrelated MX records blindly if your domain already receives mail elsewhere.
2. Under **Routing Rules**, route the primary address (for example `contact@example.com`) to **Send to a Worker > ltm-email-service**. Ensure the Worker provides its `email()` handler.
3. For additional native addresses, set up exact rules or a **catch-all** rule to the same Worker. Check exact-rule precedence before enabling catch-all.
4. Create new addresses through the administrator UI. A catch-all rule **does not create an inbox**: the Worker accepts only known, active native mailboxes and rejects unknown/disabled recipients.
5. From an external email provider, test a valid primary address, an additional mailbox, a plus alias, and an unregistered address. Confirm the unregistered address is rejected and valid messages appear in D1/R2 and the web UI.

`FORWARD_TO` is optional. If configured, the Worker forwards **non-Junk mail received by the primary native mailbox** after processing; this is not a replacement for Email Routing. Your destination must be eligible under Cloudflare's forwarding rules.

Docs: [Cloudflare Email Routing](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) · [Email Workers](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/).

## 6. Configure outbound Email Sending separately

Cloudflare Email Sending is separate from Email Routing. Workers Paid **does not automatically activate an outbound domain**. Cloudflare presently documents the product primarily for transactional email, so verify your intended usage is approved before relying on native personal correspondence.

**One-time configuration for automatic sending from all active native mailboxes:**

1. Open **Compute > Email Service > Email Sending** and onboard the domain used by `PRIMARY_ADDRESS`. Confirm SPF/DKIM/DMARC and bounce configuration in the **same Cloudflare account** as the Worker. Workers Paid alone does not activate Email Sending.
2. The Worker has two outbound bindings: restricted `EMAIL` for the primary mailbox and `EMAIL_DYNAMIC` for all other active native mailboxes. `EMAIL_DYNAMIC` does **not** require per-address allowlists or a runtime API token. Only addresses already authenticated as active native mailboxes under the configured domain can reach it through this app.
3. After deploying `main`, all active native mailboxes—including newly created ones—can attempt sending automatically. Send is not greyed out for active mailboxes simply because an optional API credential is absent.
4. Cloudflare enforces sending-domain onboarding and its account restrictions. Without an onboarded sending domain, unbound email bindings may only deliver to verified destinations. If Cloudflare rejects delivery, the compose window displays the transport error without hiding the Send control. Check Email Service activity for the actual result.
5. Optionally configure an **account-scoped Email Sending: Edit** API token as the Worker's runtime secret `CF_EMAIL_SENDING_TOKEN`. In that case, the app prefers the REST API and automatically injects `CF_EMAIL_SENDING_ACCOUNT_ID` from the existing private production build account ID. This is optional, **not** required for normal active native mailbox sending.
6. Verify a real send, replies, bounce behavior, domain authentication and account quotas. If Cloudflare does not allow your intended type of correspondence, use an approved transport instead.

Gmail accounts continue through Gmail OAuth and the Gmail API. Legacy `CLOUDFLARE_NATIVE_SENDERS` and `MULTI_SENDER_APPROVED` are unused. All outbound native attempts continue to apply server-side mailbox authorization, daily/rate limits, idempotency and quota controls.

Docs: [Cloudflare send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/) · [Email Sending REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) · [Domain onboarding](https://developers.cloudflare.com/email-service/get-started/send-emails/) · [Cloudflare FAQ](https://developers.cloudflare.com/email-service/reference/faq/).

### Unsubscribing from received mail

The **Unsubscribe** control is always available whenever a message is open, regardless of Inbox, Junk, Archive, Starred, Sent or **Trash** folder (desktop and mobile). It first checks standard `List-Unsubscribe` headers, then looks for likely unsubscribe instructions in the message body when headers are missing. Native messages can still use headers retained in R2, including older Trash messages; Gmail uses its message headers. Clicking the control opens an explanation dialog. External links are user-initiated only, never fetched automatically, and require a supported HTTPS or mailto destination.

**Unsubscribe cannot be guaranteed for every sender.** If a received message provides no unsubscribe mechanism, the dialog explains the limitation; it does not falsely report a successful unsubscription. Sent messages display the same control but explain why unsubscribing from a message you sent is not meaningful. Trash status does not suppress the action or its link. A sender-provided URL is not trusted automatically: review it before providing credentials or confirming anything. For mail without a usable subscription-management method, use Junk and other available mail controls.

## 7. Configure secrets (not Git files)

Use **Cloudflare Worker runtime secrets** under the Worker's **Settings > Variables & Secrets**, or `npx wrangler secret put SECRET_NAME` against the correct deployed Worker. Runtime secrets and **Workers Builds build-time variables** are separate. Do **not** put secrets in `wrangler.jsonc`'s public `vars` object.

| Name | Required? | Purpose |
| --- | --- | --- |
| `AUTH_SETUP_TOKEN` | **Yes for first-time owner registration** | One-time owner-controlled secret shown only during initial passkey setup |
| `PROVIDER_CREDENTIAL_KEY` | Gmail only | 32 random bytes, base64url encoded, for encrypting stored Gmail OAuth credentials |
| `GOOGLE_CLIENT_ID` | Gmail only | OAuth client identifier |
| `GOOGLE_CLIENT_SECRET` | Gmail only | OAuth client secret |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Push only | Matching Web Push/VAPID keypair |
| `CLOUDFLARE_NATIVE_SENDERS` | Cloudflare **build** variable (optional) | Exact comma-separated additional native sender addresses; only configure when sending domain and account policy permit. Never a browser/API value. |
| `MULTI_SENDER_APPROVED` | Deprecated | Old runtime flag does not grant sender access; use the explicit build-time address allowlist instead. |
| `MAILBOX_PURGE_ENABLED` | No; leave disabled | Enables daily irreversible deletion after the 30-day mailbox recovery period |

Generate a **unique** strong initial setup secret and, for Gmail, a separate 32-byte encryption key. For example, run these **locally** in your terminal and store the outputs privately:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The first value is suitable for `AUTH_SETUP_TOKEN`; the second for `PROVIDER_CREDENTIAL_KEY`. Never publish the outputs in a Git commit, terminal screenshot, public issue, or deployment log.

Keep the Gmail encryption key securely backed up. **Losing or rotating it without re-encrypting existing records can make stored OAuth credentials unreadable.** Remove `AUTH_SETUP_TOKEN` from the runtime configuration after owner registration has succeeded and been verified; the code also blocks new registration once a passkey exists.

For local development, use a **gitignored** `.dev.vars` file with local/test-only secrets. Do not connect local tests to the production D1/R2 resources.

### Optional: connect Gmail

1. Create a Google Cloud OAuth project/consent screen, enable the Gmail API and the APIs needed for the app's profile and contacts access.
2. Create a **Web application** OAuth client. Add the exact redirect URI: `https://YOUR-WORKER-HOST/api/accounts/gmail/callback`.
3. Configure the runtime `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PROVIDER_CREDENTIAL_KEY`.
4. Review the app's configured scopes (`gmail.modify`, `userinfo.profile`, `contacts.readonly`) and Google's consent-screen testing/verification rules. In Testing mode, refresh tokens may expire sooner than expected.
5. Sign in to the deployed app and use **Add Inbox > Gmail**. Test token refresh and cross-device access deliberately.

The redirect URI is generated from the live Worker hostname automatically, **but Google will reject it if not registered**. See [domain portability](./docs/DEPLOYMENT_DOMAINS.md).

### Optional: push notifications

Generate a VAPID keypair with a trusted Web Push utility and put its correctly encoded public/private keys in Worker runtime secrets. Update the VAPID contact (`VAPID_SUBJECT` in `src/worker/push.ts`) to an address you control if rebranding. Check permission prompts, browser support and iOS Home Screen installation behavior.

## 8. Connect Cloudflare Workers Builds and deploy

The repository is designed for **Cloudflare Workers Builds**, not production deployment from GitHub Actions.

1. In Cloudflare, connect your authorized GitHub repository to the **bootstrapped Worker** (`ltm-email-service`).
2. Set the **production branch to `main`**. Disable non-main preview deployment unless you have isolated preview databases, buckets and secrets.
3. Set the production **Build command** to `npm run build:cloudflare`.
4. Set the **Deploy command** to `npm run deploy`.
5. If preview builds are enabled and isolated, the repository's prior preview command is `npx wrangler preview`. It is **not** a substitute for configuring safe, separate preview resources.
6. In the **build environment** (not the Worker runtime secret environment), configure:
   - `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account containing the Worker and D1.
   - `CLOUDFLARE_API_TOKEN`: a private build secret with sufficient **Workers Scripts read/edit** and **D1 edit** permissions; grant only the other Cloudflare permissions actually needed for this deployment.
7. Confirm the bootstrap Worker already has the real `DB` binding (step 4), then trigger a production build from an authorized `main` commit. Follow its private build logs and check the **exact Git commit SHA**.

### What the build actually does

The production build scripts are intentionally gated by both `WORKERS_CI=1` and `WORKERS_CI_BRANCH=main`:

1. `scripts/hydrate-production-d1.mjs` reads the bootstrapped/deployed Worker's DB binding and injects its ID into the **temporary build configuration**.
2. `npm run typecheck` + `vite build` produce the client/Worker bundle.
3. `scripts/migrate-production-d1.mjs` applies pending D1 migrations **remotely**.
4. The deployment preflight (`scripts/assert-cloudflare-production.mjs` and `scripts/verify-production-d1.mjs`) rejects an off-main production deploy and an unresolved placeholder D1 ID.
5. `npm run deploy` checks migrations again for idempotence and invokes Wrangler to publish the Worker.

Production configuration errors should **fail closed**. Do not bypass those checks by committing your production D1 UUID or putting build credentials in GitHub source.

Relevant commands:

```bash
npm run typecheck
npm run build
npm run db:migrate:local
# Production deployment: Cloudflare Workers Builds on main only
```

Official references: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) · [D1 migrations](https://developers.cloudflare.com/d1/wrangler-commands/) · [R2 buckets](https://developers.cloudflare.com/r2/get-started/cli/).

## 9. Finish administrator onboarding

Open the **final HTTPS Worker hostname**, not a temporary preview address:

1. On the initial sign-in screen choose **Create administrator passkey**, enter your private `AUTH_SETUP_TOKEN` and register your device's passkey.
2. The newly registered owner session opens **Email administration**. Set an administrator password of **4–32 characters**. This invalidates previous owner sessions.
3. Sign in again using `admin@YOUR-WORKER-HOST`, the administrator password, and your passkey.
4. Sensitive admin actions require **fresh passkey verification**. Test a harmless mailbox setting update and confirm an event appears in **Security activity**.
5. Create or configure a native mailbox password if you want to sign in to that mailbox without an owner session. Native mailbox passwords are **4–32 characters**.
6. Securely store the administrator password and the passkey/recovery material. There is **no public administrator password-reset or passkey-bypass recovery route**. Do not remove D1 authentication records as an improvised recovery procedure.

The older `admin@liamthemo.com` username is a compatibility alias **only** on the original host under that configured mail domain; new unrelated deployments use the derived hostname address.

See [admin authentication](./docs/multi-mailbox/ADMIN_MFA.md).

## 10. Validate the deployed service

Before using it for real mail, complete this checklist:

- [ ] Cloudflare's production build **completed successfully** against the expected `main` commit.
- [ ] The correct D1 database contains migration records and application tables; the expected R2 bucket is attached under `MAIL`.
- [ ] Administrator login requires both password and passkey; an ordinary mailbox session cannot access `/api/admin/*` or `/api/mailboxes/*`.
- [ ] Sensitive administrator mutations prompt for fresh passkey approval; security events appear in the admin activity log.
- [ ] Valid incoming mail arrives through the Email Worker and appears in the Inbox. Test Junk, threading, attachments and quotas.
- [ ] Unknown or disabled recipient addresses are rejected rather than redirected into another mailbox.
- [ ] A native outbound test succeeds **only where policy, sending-domain verification and account limits allow it**.
- [ ] Gmail OAuth completes and can reconnect/refetch if enabled.
- [ ] Notifications, mobile navigation, PWA install and account switching work on intended browsers.
- [ ] D1 **and** R2 backups are stored securely and a sample **restore** has been tested.
- [ ] The `AUTH_SETUP_TOKEN` is removed after successful owner enrollment.
- [ ] Mailbox auto-purging (`MAILBOX_PURGE_ENABLED`) remains off until backup/restore procedures are proven.

The `/api/health` endpoint reports D1/R2 status but is under the authenticated API boundary in the current code; query it with a valid session rather than expecting an anonymous public health page.

## Troubleshooting

| Symptom | Likely cause / action |
| --- | --- |
| `DB references database 00000000-… not found` | Bootstrap Worker has no real saved `DB` binding, or build is running outside the protected production branch. Attach the correct D1 to the same-named Worker and retry `main`. Do **not** commit its UUID. |
| Production build cannot read Worker settings | Check `CLOUDFLARE_ACCOUNT_ID`, API token permissions, Worker name and presence of exactly one `DB` binding. |
| D1 tables missing / admin setup reports a server error | Verify the **remote migrations ran in the intended account/database** and review the private Cloudflare build log, without logging credentials or mail contents. |
| Worker loads but mail never arrives | Verify Email Routing DNS records, exact/catch-all rule precedence, Worker email-handler destination, and registered active native mailbox address. |
| `Invalid credentials` for your new admin login | Use `admin@<actual-worker-hostname>` (not automatically the native mail domain), and verify the password was initially configured. |
| Passkey fails after changing hostnames | RP IDs differ. Return to the original host or use a planned owner-controlled recovery/migration path; passkeys do not silently migrate. |
| Google reports `redirect_uri_mismatch` | Add the **exact** generated callback URI in the Google Cloud OAuth client. |
| Gmail connection fails or requires reconnecting | Verify OAuth scope/consent testing status, Google secrets, encrypted key availability and browser cookie state. |
| Native outbound is blocked | Active native mailboxes can always open Compose and attempt sending. Check that `EMAIL_DYNAMIC` is deployed, the sender domain is onboarded in Email Service, and Cloudflare has permitted the destination. Inspect the inline compose error and Email Service activity; the REST API token is optional. |
| Push notifications unavailable | Supply a valid VAPID keypair and check browser/device notification permissions. |
| Cloudflare preview branch fails | Preview resources and deployment environment differ from production; disable preview builds or configure isolated bindings. Do not debug by pointing previews at production D1. |

## Maintenance and security

- **Deploy from `main` only.** GitHub Actions validation and Gitleaks full-history scans run on permanent version branches (for example `v2.07`) and PRs targeting those branches. A typical release flows feature branch → version branch → `main` → verify Cloudflare Workers Build for the exact SHA.
- **Do not publish secrets or mail.** In particular, keep API tokens, OAuth secrets, setup secret, private VAPID key, provider encryption key, cookies, raw MIME, attachments, production D1 IDs, mailbox exports and backup files out of Git history and CI output.
- **Budget and quota monitoring.** Workers, D1, R2 and Email Service have separate limits and potentially billable consumption. Enable billing alerts and review outbound use before assuming the project is free.
- **Backups.** D1 holds metadata and R2 holds message bodies/attachments; restoring just one is insufficient. Test restoring both to an isolated environment.
- **Retention.** Administrator security activity is retained for up to **90 days** through scheduled cleanup. Native mailbox deletion provides a **30-day recovery period**; automated purge is opt-in.
- **Hardening.** Use Cloudflare WAF/bot controls, inspect sign-in and step-up denials, rotate compromised credentials, and test that non-admin mailbox sessions cannot execute administrative actions.
- **Incident reports.** Follow [SECURITY.md](./SECURITY.md); do not disclose vulnerabilities, personal mail, or credentials in public issues.

## Repository layout

```text
src/client/                   React/TypeScript/PWA interface
src/client/components/        UI and admin controls
src/worker/index.ts           Worker fetch, email and scheduled handlers
src/worker/auth.ts            WebAuthn owner sessions
src/worker/adminAuth.ts       Administrator password sign-in
src/worker/adminStepUp.ts     Fresh privileged-action passkey checks
src/worker/adminSecurityAudit.ts  Security event logging
src/worker/mailboxRules.ts    Native mail domain validation
src/worker/email/             Inbound storage and outbound sending
src/worker/providers/         Native mailbox and Gmail implementations
migrations/                   Ordered D1 schema migrations
public/                       Web/PWA assets and headers
scripts/                      D1 hydration, deploy guards and regressions
.github/workflows/            Version-branch CI and security checks
```

Additional reading:

- [Deployment hostnames, passkey RP IDs and mail-domain migrations](./docs/DEPLOYMENT_DOMAINS.md)
- [Administrator password + passkey setup](./docs/multi-mailbox/ADMIN_MFA.md)
- [Cloudflare routing/sending production checklist](./docs/multi-mailbox/CLOUDFLARE_SETUP.md)
- [Security audit](./docs/SECURITY_AUDIT_v2.07.md)
- [Operational constraints, sending policy and backups](./docs/multi-mailbox/OPERATIONS.md)

## License and permissions

Copyright © 2026 Sanghyuk Mo. **All rights reserved.**

This project is **source-visible proprietary software**, not a public self-hosting license. The setup steps above do **not** grant any rights to run or deploy it. Get **prior written permission from the copyright holder** before use, copying, modification, or deployment. See the complete [LICENSE](./LICENSE) and the private vulnerability-reporting guidance in [SECURITY.md](./SECURITY.md).
