# v3.00 — Config unification

> **Design record.** Written before implementation; the code, the [README](../../README.md) and the [implementation status](./V3_IMPLEMENTATION_STATUS.md) describe current behaviour.

**Document status:** Implemented on `v3.00`, then **superseded in v3.05**: the Worker has no instance vars at all. The origin and admin sign-in come from the request URL; the primary mailbox, domains, branding and mail settings live in D1; `.env` holds only secrets and deploy keys. The var tables below describe the v3.00 design. See [implementation status](./V3_IMPLEMENTATION_STATUS.md).

## Problem

Instance identity is spread across source code, `wrangler.jsonc`, Worker secrets set by hand in the dashboard, and deployment scripts that only work for the production account:

| Where | Hard-coded today |
| --- | --- |
| `src/worker/config.ts` | `APP_ORIGIN = https://email.liamthemo.com`, `RP_ID = email.liamthemo.com` |
| `src/worker/mailboxRules.ts:2` | `DOMAIN = "liamthemo.com"` |
| `src/worker/mailboxes.ts:46-48,65` | `contact@liamthemo.com` alias target, plus-alias domain, error text |
| `src/worker/adminAuth.ts:11`, `deviceAuth.ts:121,137` | `admin@liamthemo.com` |
| `src/worker/auth.ts:217-221` | passkey `rpName`, `userName`, `userDisplayName` |
| `src/worker/push.ts:30,74` | VAPID subject and fallback mailbox |
| `src/worker/email/receive.ts:97` | Message-ID fallback domain |
| `src/worker/providers/registry.ts:34,86` | `"LTM Email"`, sender name `"Liam"` |
| `migrations/0010_native_mailboxes.sql` | seeds `native:primary` as `contact@liamthemo.com` |
| Client (`AccountSignIn`, `AuthGate`, `Sidebar`, `TopBar`, `ComposeModal`, `MailboxManager`, `MobileNav`, `ProfileModal`, `SettingsModal`, `AddInboxModal`, `AdminPanel`) | brand "LTM Mails", admin address, domain placeholders |
| `public/manifest.webmanifest`, `public/sw.js`, `index.html` | app name, description |
| `wrangler.jsonc` | `PRIMARY_ADDRESS`, `allowed_sender_addresses`, worker/D1/R2 names |
| `scripts/assert-cloudflare-production.mjs`, `hydrate-production-d1.mjs`, `migrate-production-d1.mjs` | assume the LTM Workers Builds project on `main` |
| `scripts/test-*.mjs` | `https://email.liamthemo.com` test origins |

## Target design

### 1. One configuration manifest

A single committed file, `config/schema.mjs`, lists every key with its kind, so scripts and runtime agree on what is a secret:

```js
// kind: "var" (plain Worker var), "secret" (Worker secret), "deploy" (used only by scripts)
export const CONFIG = [
  { key: "APP_ORIGIN",            kind: "var",    required: true,  example: "https://mail.example.com" },
  { key: "PRIMARY_ADDRESS",       kind: "var",    required: true,  example: "hello@example.com" },
  { key: "ADMIN_ADDRESS",         kind: "var",    required: true,  example: "admin@example.com" },
  { key: "BRAND_NAME",            kind: "var",    required: false, default: "Mail" },
  { key: "BRAND_SHORT_NAME",      kind: "var",    required: false },
  { key: "OWNER_DISPLAY_NAME",    kind: "var",    required: false },
  { key: "PRIMARY_DISPLAY_NAME",  kind: "var",    required: false },
  { key: "MAIL_DOMAINS",          kind: "var",    required: false },            // v3.01 seed list
  { key: "FORWARD_TO",            kind: "var",    required: false },
  { key: "MULTI_SENDER_APPROVED", kind: "var",    required: false, default: "false" },
  { key: "MAILBOX_PURGE_ENABLED", kind: "var",    required: false, default: "false" },
  { key: "MAX_MAILBOXES",         kind: "var",    required: false, default: "100" },
  { key: "AUTH_SETUP_TOKEN",      kind: "secret", required: false },            // first-run only
  { key: "PROVIDER_CREDENTIAL_KEY", kind: "secret", required: false },          // required if Gmail enabled
  { key: "GOOGLE_CLIENT_ID",      kind: "secret", required: false },
  { key: "GOOGLE_CLIENT_SECRET",  kind: "secret", required: false },
  { key: "VAPID_PUBLIC_KEY",      kind: "secret", required: false },
  { key: "VAPID_PRIVATE_KEY",     kind: "secret", required: false },
  { key: "RESEND_API_KEY",        kind: "secret", required: false },            // v3.02
  { key: "RESEND_WEBHOOK_SECRET", kind: "secret", required: false },            // v3.02
  { key: "CLOUDFLARE_ACCOUNT_ID", kind: "deploy", required: true },
  { key: "CLOUDFLARE_API_TOKEN",  kind: "deploy", required: true },
  { key: "WORKER_NAME",           kind: "deploy", required: false, default: "ltm-email-service" },
  { key: "D1_DATABASE_NAME",      kind: "deploy", required: false, default: "ltm-email-service" },
  { key: "R2_BUCKET_NAME",        kind: "deploy", required: false, default: "ltm-email-service-mail" },
];
```

`.env.example` is generated from this manifest (`npm run config:example`) so it can never drift. `.gitignore` already ignores `.env` and `.env.*` and allows `.env.example`.

`MULTI_SENDER_APPROVED` and `MAILBOX_PURGE_ENABLED` move from "secret by convention" to plain vars: they are feature switches, not credentials. Existing secret values keep working because Worker secrets and vars share the same `env` namespace; the setup script deletes the old secret only after the var is in place.

### 2. Rendered Wrangler config

- `wrangler.jsonc` becomes **`wrangler.template.jsonc`** (committed, no instance values).
- `npm run config:render` reads `.env` (or process env in CI) and writes `wrangler.jsonc` (**gitignored**) with: worker name, `vars` for every `kind: "var"` key, D1/R2 names, the resolved D1 `database_id`, `send_email` bindings with `allowed_sender_addresses: [PRIMARY_ADDRESS]`, and the cron trigger.
- D1 ID resolution, in order: an explicit `D1_DATABASE_ID`; lookup **by name** through the Cloudflare API (new installs); lookup **from the deployed Worker's binding** (today's `hydrate-production-d1.mjs` behaviour, kept for the LTM production account).
- The renderer refuses to write if any `kind: "secret"` key would end up in `vars`.

The Cloudflare Vite plugin and Wrangler both read `wrangler.jsonc`, so local dev, build and deploy all use the same rendered file.

### 3. Why secrets stay Worker secrets

Workers do not read `.env` at runtime. Putting secrets into `vars` would expose them in plain text in the dashboard, in `wrangler.jsonc`, and in Workers Builds logs. So:

- **Local dev:** Wrangler 4 loads `.env` for local development when no `.dev.vars` exists, so the same file works unchanged.
- **Deploy:** `npm run secrets:push` converts the `kind: "secret"` keys from `.env` into JSON and pipes it to `wrangler secret bulk`. Empty values are skipped, never uploaded as empty strings. It prints key names only.
- **Rotation:** edit `.env`, rerun `secrets:push`. No dashboard visits.

The operator experience is "edit one file", while the runtime keeps the protections it has today.

### 4. Runtime config module

`src/worker/appConfig.ts`, a pure module with no Cloudflare imports, so it can be unit-tested the same way `adminStepUpPolicy.ts` is:

```ts
export type AppConfig = {
  origin: string;            // https://mail.example.com
  rpId: string;              // derived: new URL(origin).hostname
  primaryAddress: string;
  primaryDomain: string;     // derived from primaryAddress
  adminAddress: string;
  brand: { name: string; shortName: string };
  ownerDisplayName: string;
  primaryDisplayName: string;
  features: { gmail: boolean; push: boolean; multiSender: boolean; purge: boolean; resend: boolean };
  limits: { maxMailboxes: number };
};
export function loadConfig(env: Env): AppConfig | ConfigError;
```

- Validates on first use per isolate and memoizes the result.
- Feature flags are **derived** from what is present (e.g. `features.gmail` requires client ID, secret and `PROVIDER_CREDENTIAL_KEY`), so a missing optional secret disables a feature instead of failing at request time.
- Invalid required config makes every `/api/*` route return `503 {"error":"Instance is not configured"}`. Missing key **names** (never values) are written to Worker logs only.
- `config.ts` (`APP_ORIGIN`, `RP_ID`) is deleted; `index.ts` same-origin checks, WebAuthn (`auth.ts`, `adminStepUp.ts`) and Google OAuth redirect URIs read from `AppConfig`.

### 5. Client gets identity from the server

- New **public** endpoint `GET /api/instance` returns only what the sign-in page needs: `{ brandName, brandShortName, primaryDomain, features: { gmail, push } }`. It does **not** expose the admin address, mailbox list or domain list.
- The client-side admin check in `AccountSignIn.tsx:10` is replaced by a server decision: the login endpoint responds with `{ next: "password" | "password+passkey" }`. This also removes the admin address from the public bundle.
- `GET /manifest.webmanifest` becomes a Worker route built from config (name, short name, description, theme colour, icons).
- `index.html` `<title>` and `apple-mobile-web-app-title` are rewritten with `HTMLRewriter` for the shell document. `run_worker_first` gains `/`, `/index.html` and `/manifest.webmanifest`. iOS reads the app title when you add the app to the home screen, so this has to happen on the server, not after React loads.
- Push payloads always carry the brand name as the title, so `sw.js` no longer needs a hard-coded fallback.

### 6. Data bootstrap

`migrations/0010` seeds `native:primary` as `contact@liamthemo.com`, and migrations cannot read env. Add `ensurePrimaryMailbox(config)` (alongside `ensureNativeAccount`):

- **Fresh install** (the primary mailbox has no messages, drafts or credentials): set its address and display name from config.
- **Existing install** whose stored address differs from `PRIMARY_ADDRESS`: **do not rename automatically**. Log a warning and show a banner in the admin panel. Renaming a mailbox that has mail is a separate, explicit admin action with step-up.

For LTM production the values match, so nothing changes.

### 7. Scripts

| Script | Purpose |
| --- | --- |
| `npm run setup` | Interactive first run: validate `.env`, create D1 + R2 if missing (via Wrangler), render config, push secrets, apply migrations. Safe to re-run. |
| `npm run config:render` | Render `wrangler.jsonc` only. Used by both local and Workers Builds builds. |
| `npm run secrets:push` | Upload `kind: "secret"` keys with `wrangler secret bulk`. |
| `npm run deploy:self` | For CLI self-hosters: render → typecheck → build → migrate remote → `wrangler deploy`. Asks for confirmation showing the account ID and worker name. |
| `npm run deploy` | Unchanged for LTM production: still refuses to run outside Workers Builds on `main`. |

`assert-cloudflare-production.mjs` allows `npm run deploy` only from `main`: Workers Builds (`WORKERS_CI=1`, branch `main`) or the GitHub Actions deploy workflow (`refs/heads/main`). `deploy:self` uses its own confirmation instead.

### 8. Moving LTM production over

1. In Workers Builds, add the `kind: "var"` keys as **build variables** (they're not secret) so `config:render` produces today's exact values.
2. Leave the existing Worker secrets in place; names don't change.
3. Change the build command to `npm run config:render && npm run build:cloudflare`.
4. Deploy a v3.00 preview first, and diff the rendered `wrangler.jsonc` against the current file (ignoring `database_id`) before merging to `main`.

## Tests

- `scripts/test-app-config.mjs`: required keys, derived `rpId`/`primaryDomain`, feature derivation, secret-in-vars rejection, malformed origin/address.
- `scripts/test-config-render.mjs`: template rendering, secrets never present in output, D1 ID resolution order (mocked API).
- Existing `test-*.mjs` read `TEST_ORIGIN` instead of a hard-coded URL.
- CI guard: fail if `liamthemo` appears under `src/`, `public/` or `index.html`.

## Exit gate

- [ ] LTM production renders an equivalent config and behaves identically (passkey login, admin MFA, Gmail, push, inbound, outbound).
- [ ] A clean Cloudflare account deploys from `.env` with `npm run setup && npm run deploy:self`.
- [ ] No secret value appears in `wrangler.jsonc`, `dist/`, or CI logs (checked by a test that greps build output for every secret value in a fixture `.env`).
- [ ] New `LICENSE` in place (see [LICENSING.md](./LICENSING.md)).
