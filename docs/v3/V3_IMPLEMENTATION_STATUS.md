# v3 implementation status

**Status:** Code implemented on version branches `v3.00` → `v3.04` (each builds on the previous; `v3.04` contains everything). Not merged to `main`, not deployed, `LICENSE` not yet replaced.

## Branches

| Branch | Phase | Head |
| --- | --- | --- |
| `v3.00` | Config unification | `60c2f13` |
| `v3.01` | Multi-domain | `fa85466` |
| `v3.02` | Outbound transports + Resend | `bf20c35` |
| `v3.03` | Theme foundation (merged from the theme worktree) | `a6d63a6` |
| `v3.04` | Branding, themes, icons, credit (+ merge of v3.03) | latest |

## Verified

- `npm run typecheck`, `npm run build` and `npm test` pass on `v3.04` (20 Node test scripts: config, render parity with the v2 `wrangler.jsonc`, identity guard, auth boundary, step-up coverage, mailbox and multi-domain rules, migrations via `node:sqlite`, transport selection, Resend payload/errors/webhooks, branding/lock/preferences, CSS token guard and default-theme equivalence).
- Default theme proven declaration-for-declaration identical to v2.07 (3594 declarations).
- Local smoke test with `vite dev` + local D1 (all 18 migrations): shell title/app-title rewritten from config, generated manifest, `/api/instance`, icon fallback, fresh-install primary mailbox adopting `PRIMARY_ADDRESS`, primary + `MAIL_DOMAINS` domain bootstrap, mailbox sign-in, inbox render, Appearance settings (theme, accent with readable ink, duotone icons) saved per mailbox and restored after reload, admin panel Domains (live DNS-over-HTTPS check correctly blocking activation without MX), Deliverability and Branding sections, unsigned webhook rejected with 401.

## Not verified (needs a real Cloudflare account / devices)

- Live inbound mail on a second domain; Email Routing catch-all per zone.
- Real sends through Cloudflare and Resend; Resend webhooks from Resend's servers; bounce suppression end to end.
- Admin mutations that require a passkey step-up (domain activation, branding save, logo upload) — the UI and server paths are covered by tests, but the WebAuthn ceremony was not exercised.
- `npm run setup` / `deploy:self` against a fresh account; `wrangler secret bulk` upload.
- iPhone/iPad PWA: install title and icon, theme-color, safe areas in each preset.
- Screenshot-diff baselines (Playwright) from THEME_FOUNDATION.md were replaced by the stronger static equivalence check; presets were reviewed visually in a desktop browser only.

## Deviations from the design docs

- **Theme files:** rules were not merged or moved (to keep equivalence provable); `dark.css` stays and the tokens live in `src/client/theme/`. The live default inbox is the brown/orange look, so `ltm-dark` is that look and there is no purple preset.
- **Icon sets:** `ltm` (outline), `ltm-bold`, `duotone` (instead of "filled"); no third-party icons, so no `THIRD_PARTY_NOTICES` yet.
- **Logo:** source may be PNG or WebP; the browser always uploads PNG at 32/180/192/512. The logo upload route has its own 6 MB step-up body limit; every other admin route keeps 64 KB.
- **Resend webhook suppression** only suppresses when the event names exactly one recipient (avoids suppressing the wrong address on multi-recipient sends).
- **Preferences** follow the active mailbox (decision left open in CUSTOMIZATION.md).

## Blocker before merging to `main`: v2.08

`origin/main` moved to v2.08 (`6c0811a`) after this work branched from `13c0421`. v2.08 overlaps with v3:

- Sending: replaces `EMAIL_MULTI` + `MULTI_SENDER_APPROVED` with `EMAIL_DYNAMIC` and the Cloudflare Email Sending REST API (`CF_EMAIL_SENDING_ACCOUNT_ID`, `CF_EMAIL_SENDING_TOKEN`, `emailServiceApi.ts`, `senderPolicy.ts`). v3.02's transport selection needs a third Cloudflare path and the policy gate revisited.
- Address rules: v2.08 derives the domain from `PRIMARY_ADDRESS`; v3.01 replaces this with the domain table.
- CSS: ~240 new lines in `ui-overrides.css` with colour literals that must be tokenized to pass the v3.03 guard.
- `wrangler.jsonc`, `worker-configuration.d.ts`, `send.ts`, `native.ts`, `registry.ts`, `index.ts`, `mailboxes.ts` all conflict.

## Production rollout (LTM instance), once merged

1. Workers Builds → build variables (plain, not secret): `APP_ORIGIN=https://email.liamthemo.com`, `PRIMARY_ADDRESS=contact@liamthemo.com`, `ADMIN_ADDRESS=admin@liamthemo.com`, `BRAND_NAME=LTM Mails`, `PRIMARY_DISPLAY_NAME=LTM Email`, `OWNER_DISPLAY_NAME=Liam`, plus `MULTI_SENDER_APPROVED` / `MAILBOX_PURGE_ENABLED` if used. Keep `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
2. If `MULTI_SENDER_APPROVED` or `MAILBOX_PURGE_ENABLED` exist as Worker **secrets**, delete them first (a var cannot share a secret's name).
3. Build command stays `npm run build:cloudflare` (it now renders `wrangler.jsonc`); deploy command stays `npm run deploy`.
4. Migrations 0016–0018 are additive and apply in the existing deploy step. Back up D1 first.
5. After deploy: confirm passkey login, admin MFA, Gmail, push, inbound to `contact@`, a send from the primary mailbox, and that Domains shows `liamthemo.com` as primary.
6. Replace `LICENSE` with the reviewed text from [LICENSING.md](./LICENSING.md) and update the README banner.
