# LTM Email Service

A private, production webmail application developed and operated by Sanghyuk Mo.

> **Source-visible, not open source.** This repository is publicly viewable for portfolio, evaluation, and security-review purposes only. No permission is granted to use, copy, modify, run, deploy, redistribute, sublicense, sell, or create derivative works from this project. See [`LICENSE`](./LICENSE).

The production mailbox, credentials, stored email, connected accounts, and infrastructure remain private and are not part of this repository.

## Overview

LTM Email Service is a full-stack webmail application built around a private mailbox with optional connected Gmail accounts. It provides a responsive desktop/mobile mail client, authenticated API, inbound and outbound email processing, attachment handling, push notifications, and provider integrations.

## Architecture

- **React + TypeScript + Vite** — responsive webmail client
- **Cloudflare Workers** — API, authentication, inbound email handling, and provider integrations
- **Cloudflare Workers Static Assets** — frontend hosting
- **Cloudflare D1** — mail metadata/state, drafts, connected accounts, passkeys, sessions, and push subscriptions
- **Cloudflare R2** — raw RFC822/MIME messages, attachments, and profile assets
- **Cloudflare Email Routing / Email Service** — native inbound and outbound mail
- **WebAuthn / passkeys** — application authentication with server-side session state
- **Gmail API** — optional connected Gmail inboxes and sending accounts
- **Web Push / VAPID** — browser push notifications
- **GitHub Actions** — validation and security checks on version branches
- **Cloudflare Workers Builds + Wrangler** — production deployment from `main`

## Implemented features

The application currently includes:

- inbox, junk, starred, sent, drafts, archive, and trash folders; Junk displays messages Gmail currently labels as Spam for connected Gmail accounts
- native mailbox plus connected Gmail accounts
- account-aware compose/send
- reply and forward flows with threading metadata
- draft autosave
- read/unread, star, archive, and trash mutations
- search and automatic mailbox refresh
- attachment download and preview support
- sanitized rich HTML email rendering
- remote tracking-image blocking by default
- passkey setup/login and session management
- optional profile photo
- browser push notifications
- responsive mobile/PWA UI

## Security model

Repository visibility is **not** used as a security boundary. Production security depends on authenticated server-side controls and secret storage outside Git.

The current security model includes:

- WebAuthn/passkey authentication with required user verification
- secure, HTTP-only, same-site session cookies
- hashed server-side session tokens
- expiring, single-use authentication challenges
- authentication rate limiting
- same-origin checks for state-changing API requests
- restrictive API and attachment response headers
- sanitized inbound HTML with dangerous markup removed
- remote tracking images blocked by default
- provider OAuth credentials encrypted at rest
- outbound native sending restricted to the configured mailbox
- production credentials and cryptographic secrets supplied through protected runtime/CI secret stores rather than committed source
- production D1 identifiers resolved from the currently deployed Worker binding during authenticated deployment instead of being stored in the repository
- automated Gitleaks scanning across fetched branch/tag history on pull requests and major branches
- automated historical path auditing for accidentally committed environment files, mailbox exports, local databases, private-key files, and backup artifacts

No production mailbox contents, OAuth tokens, passkeys, session tokens, private cryptographic keys, API credentials, production database identifiers, mailbox exports, or local production database files are intended to be committed to this repository.

## Repository structure

```text
src/client/                 React client and UI
src/client/components/      reusable UI components
src/worker/                 Cloudflare Worker entry point and shared server logic
src/worker/api/             authenticated API handlers
src/worker/email/           inbound/outbound email processing
src/worker/providers/       native/Gmail provider abstraction and OAuth helpers
migrations/                 D1 schema migrations
public/                     PWA/static assets
scripts/                    build/asset and deployment helper scripts
.github/workflows/          version-branch validation and security scanning
```

## Planned: v3 — self-hosting, multi-domain, customization

The next major version, implemented on branches `v3.00`–`v3.04` but not yet merged or deployed. The current license stays in force until the v3 release.

- **v3.00 Config unification:** one `.env` file as the source of truth, rendered Wrangler config, scripted Worker-secret upload, no hard-coded instance identity
- **v3.01 Multi-domain:** native mailboxes on several domains under one global administrator
- **v3.02 Outbound transports:** Cloudflare stays the default; Resend opt-in per domain with signed delivery webhooks
- **v3.03 Theme foundation:** CSS colour tokenization with no visible change
- **v3.04 Customization:** admin-locked branding, user themes, icon sets, per-mailbox accents
- **Licensing:** others may run their own instance, including commercially, with credit given; redistribution and paid services stay prohibited

[Implementation status](./docs/v3/V3_IMPLEMENTATION_STATUS.md) · [Roadmap and decisions](./docs/v3/README.md) · [Self-hosting guide (target state)](./docs/v3/SELF_HOSTING.md) · [Licensing change](./docs/v3/LICENSING.md)

## v2.07: Repository security optimization and audit

This release closes cross-mailbox authorization gaps in sending and draft creation, restricts Gmail contact-avatar reads to an authenticated device, preserves attachment security policies, rate-limits OAuth initiation, and adds dependency security checks. See [security findings, remediations, and remaining production tasks](./docs/SECURITY_AUDIT_v2.07.md).

## v2.04: Consistent inbox theme and Cloudflare password fix

The sign-in page, administrator dashboard, Settings, modals and mailbox forms now use shared inbox dark-brown/orange tokens (including the same amber button gradient used for Send). Administrator passwords are 8–32 characters; Worker-native PBKDF2 via `node:crypto` replaces the earlier production-capped WebCrypto implementation without changing stored PBKDF2-SHA256 hashes. See [admin setup](./docs/multi-mailbox/ADMIN_MFA.md).

## v2.02: Reserved admin login with mandatory 2FA

Sign in as **`admin@liamthemo.com`** using an administrator password followed by the existing owner passkey. Successful login opens a standalone administration dashboard instead of the mail inbox. The administrator can choose passwords for individual mailboxes or generate replacements; both operations revoke the affected mailbox's saved device sessions. Initial admin password setup uses the existing passkey, then disables passkey-only access. [Administrator setup and MFA security](./docs/multi-mailbox/ADMIN_MFA.md).

## v2.01: Device-specific sign-ins and owner administration

The optional `v2.01` upgrade introduces **separate account sign-ins per device**: Google OAuth and custom email/password on the sign-in screen, and a distinct, owner-passkey-protected admin panel for creating and managing custom addresses. Existing Google mail credentials remain encrypted server-side and are only exposed after that device authorizes its account. [Architecture, migration and validation](./docs/multi-mailbox/DEVICE_SIGNIN_ADMIN.md).

## Planned: Cloudflare-native multi-mailbox webmail

A documentation-only proposal describes how to add multiple native `@liamthemo.com` mailboxes, per-mailbox folders and sender selection within the existing Cloudflare-hosted web app. It does **not** add IMAP/SMTP logins or deploy new mailbox capabilities. Keep the current `contact@liamthemo.com` mailbox and Gmail connections intact during implementation.

- [Roadmap and intended scope](./docs/multi-mailbox/README.md)
- [Architecture and schema design](./docs/multi-mailbox/ARCHITECTURE.md)
- [Implementation phases and validation](./docs/multi-mailbox/IMPLEMENTATION_PLAN.md)
- [Security, costs, Cloudflare constraints and open decisions](./docs/multi-mailbox/OPERATIONS.md)

**Outbound policy gate:** Cloudflare Email Sending is documented as transactional-only. Do not enable arbitrary person-to-person multi-mailbox sending until Cloudflare confirms that usage is permitted.

## Development and deployment

This repository reflects the source for a private production service. Runtime infrastructure, account configuration, credentials, and production-only values are managed separately from source control.

GitHub Actions run validation and full-history security checks only for pushes to version branches (`vX.XX`) and pull requests targeting those branches. They do not run on `main`.

Cloudflare Workers Builds is the only production deployment path. From v3, `wrangler.jsonc` is generated from `wrangler.template.jsonc` and instance settings (`npm run config:render`, see [config unification](./docs/v3/CONFIG_UNIFICATION.md)); set the instance values as Workers Builds build variables. The build resolves the D1 ID and applies remote migrations only for a Cloudflare production build on `main`. Recommended commands, with an additional deploy preflight, are:

- Build command: `npm run build:cloudflare`
- Deploy command: `npm run deploy`
- Production branch: `main`
- Build variables/secrets: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (secret), and the instance vars `APP_ORIGIN`, `PRIMARY_ADDRESS`, `ADMIN_ADDRESS`, `BRAND_NAME`
- Tests: `npm test`

The build resolves the production D1 binding from the deployed Worker before bundling, so the database ID stays out of source control. On preview branches, production binding hydration and migrations are skipped. The `npm run deploy` command refuses to run outside Cloudflare Workers Builds on `main`, verifies the generated config, applies D1 migrations, and deploys the Worker. Give the API token Workers Scripts read/edit and D1 edit access. Keep the preview command set to `npx wrangler preview`.

## Security reports

If you believe you have found a security vulnerability, **do not publish exploit details in a public issue**. Follow the private reporting instructions in [`SECURITY.md`](./SECURITY.md).

## License

**All rights reserved. No use is permitted.**

This project is proprietary source code made publicly visible for portfolio, evaluation, and security-review purposes. Public availability does **not** make this software open source and does not grant permission to use the software or its source code.

See [`LICENSE`](./LICENSE) for the complete terms.
