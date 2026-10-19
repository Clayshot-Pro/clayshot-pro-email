# Security and repository optimization audit — v2.07

> **Historical.** A code review of v2.07. Later versions changed the setup and added features; see [SECURITY.md](../../SECURITY.md) for reporting issues.

Date: 2026-10-14
Scope: code-level review of the GitHub repository at the v2.06 production baseline, plus hardening changes in v2.07. This is **not** an independent penetration test, authenticated live-device assessment, Cloudflare configuration audit, or guarantee against all vulnerabilities.

## Remediated in this release

| Severity | Finding | Remediation | Regression |
| --- | --- | --- | --- |
| **High** | `POST /api/send` authorized the `accountId` URL query, while its send handler selected the mailbox using the multipart body. A signed-in device could authorize one mailbox but request a different sender. | Shared canonical account resolution uses the actual request body for sending, rejects conflicting URL/body identities, and checks that identity against the current device's grants before dispatch. | `scripts/test-account-access.mjs` |
| **High** | `POST /api/drafts` could authorize a query account then upsert a draft under a different account in JSON. | Authenticate the JSON account identity; reject account mismatches and invalid bodies before writing. | `scripts/test-account-access.mjs` |
| **Medium** | `GET /api/contact-avatar` accepted any known Gmail `accountId` without checking the requesting device's grant. | Require an active device grant in both the central route guard and the endpoint before requesting Google contacts/token services. | `scripts/test-account-access.mjs` |
| **Medium** | The generic API response wrapper replaced all custom `Content-Security-Policy` headers with a generic policy, dropping the download handler's stricter `sandbox` directive. | Preserve endpoint-specific CSP, use a strict default only when missing, and limit attachment preview framing to the app's origin. | Code inspection / GitHub build |
| **Medium** | Account-link initiation could be invoked repeatedly before a user/device session. | Apply the existing server-side per-IP authentication throttling to the Gmail OAuth start endpoint. | Route review |
| **Low** | API resources did not explicitly advertise a cross-origin resource policy. | Apply `Cross-Origin-Resource-Policy: same-origin` to API responses. | Code inspection |
| **Low** | A dormant inbox refresh timer still scheduled a near-infinite interval. | Remove timer and dead configuration while preserving refresh on focus, push and explicit actions. | GitHub build |
| **Maintenance** | Automated vulnerability update PRs and production dependency advisory gating were absent. | Add Dependabot updates targeting the tested version branch, and fail CI on high-severity production npm dependency advisories. | GitHub validation |

### Existing protections retained

- Admin identity separate from mailbox sign-in, with password then registered passkey; owner-only admin routes.
- Device-specific HttpOnly, Secure session cookies; database-backed session grants and revocation on mailbox password changes.
- Passwords hashed with salted scrypt; legacy PBKDF2 verification supported.
- Provider OAuth credentials encrypted with AES-GCM and unique associated data.
- D1 queries parameterized and bound to mailbox/provider identities in most handlers.
- Same-origin check for API mutations, output CSP and anti-sniff headers, email markup sanitization plus isolated iframe, remote image blocking.
- Native outbound rate limits, idempotency reservations, opt-in Junk filtering, and per-mailbox quotas.
- Full Git-history secret scanning, pinned GitHub Action versions, and existing migration/runtime regression checks.

## Outstanding work / residual risks, prioritized

### P1 — production controls, needs account owner access

1. **Backups and recovery**: verify the production D1 Time Travel retention window, independent backups for raw MIME and attachment objects in R2, and perform a test restore to an isolated environment. D1 recovery does not recover independently removed R2 objects. Cloudflare Paid D1 normally supports up to 30 days Time Travel on the production storage system; verify actual storage type and plan.
2. **WAF and edge abuse protection**: check Cloudflare WAF rules for `/api/auth/*`, `/api/device/login`, `/api/admin/login/password`, `/api/accounts/gmail/connect` and expensive mailbox/send operations. The D1 per-IP limits are useful but can be distributed across IPs; add edge-level rate limiting appropriate to personal usage.
3. **Live role tests**: test a device logged in as only mailbox A attempting to send, save a draft, access an attachment, or request contacts as mailbox/Gmail account B. Expect HTTP 403/400 with no cross-account side effects. Repeat on mobile PWA, desktop, and iPad.
4. **Production deployment settings**: ensure only `main` automatically deploys production and Cloudflare preview build failures are investigated separately. Verify that secrets are configured privately in Cloudflare, not committed. Confirm email-route catch-all rejects unknown mailbox recipients.
5. **OAuth and sending policy**: verify Google OAuth publishing/test-mode restrictions, disconnect behavior and authorized scopes; confirm the Cloudflare Email Sending use case/policy before setting `MULTI_SENDER_APPROVED=true`.

### P2 — further code hardening (future architectural change)

1. **At-most-once send under crashes**: outbound attempts use a D1 pending/accepted state, but provider-send and D1 acknowledgement cannot be atomic. A crash after SMTP/provider acceptance and before recording success leaves an uncertain result. Add an explicit recoverable `uncertain` state and operator-facing reconciliation; never silently retry an ambiguous send.
2. **Inbound and stored mail parsing**: the Worker sanitizer relies on regular-expression filtering, with browser DOM cleanup and iframe CSP as other layers. Adopt an allowlist-based, fuzz-tested parser for HTML email; retain scriptless sandboxing and remote resource blocking.
3. **Request body size enforcement**: the API currently checks declared `Content-Length`, which may be absent for streaming/chunked requests. Add stream-counted limits at the edge, particularly for multipart send and profile uploads, without buffering unbounded attacker-controlled bodies.
4. **Brute-force policy**: the app permits 8–32 character admin passwords by product requirement and requires a passkey. Consider optional password-strength/breached-password checks and per-admin-account lockout/backoff beyond per-IP throttles; avoid irreversible lockouts without recovery.
5. **Quota/data consistency**: reconcile orphaned R2 objects, D1 usage, and sent-item writes on failures. Alert on discrepancies and preserve mailbox audit events without PII leakage.
6. **Maintainability**: split the growing `App.tsx`, `index.ts`, and cumulative stylesheet overrides into tested modules/themes; do this incrementally with browser regression tests rather than a high-risk wholesale rewrite.

### P3 — operational monitoring

- Monitor unusual admin logins, passkey failures, rate-limit spikes, mailbox creation/deletion, sending volume and duplicate inbound receipt behavior; avoid plaintext email bodies, credentials and tokens in logs.
- Verify that `PROVIDER_CREDENTIAL_KEY`, Google OAuth client secret, VAPID keys and other production secrets are stored in Cloudflare secrets and have a documented secure rotation/recovery procedure.
- Confirm the GitHub branch protection rules require passing CI and secret scanning on version PRs.
- Update Dependabot `target-branch` from `v2.07` whenever the active permanent version branch advances.

## Tests and release gate

`npm ci --ignore-scripts`, TypeScript/Vite build, D1 migration smoke tests, mailbox rules, per-device authorization regression, admin layout regression, Node password crypto tests, real `workerd` crypto regression, production `npm audit --audit-level=high`, and full-history secret scanning must pass on the feature and version branches. Verify Cloudflare's production build on the `main` merge separately. A green build is **not** a substitute for a live authorization test or backup restore drill.

## References

- Cloudflare D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/
- Cloudflare WAF rate limiting: https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/
- Cloudflare Workers Access: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
