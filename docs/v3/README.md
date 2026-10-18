# v3.00 roadmap — self-hostable, multi-domain, customizable

**Status:** Planning only. No v3 code, migrations, configuration changes, or license changes have been made by this documentation.

**Starting checkpoint:** `main` at v2.07 (`13c0421`). **Development line:** `v3.00` and following `v3.0x` version branches. **Production:** `main`, deployed by Cloudflare Workers Builds.

## Goals

1. **Config unification:** one `.env` file is the single source of truth for an instance. A new operator can deploy their own instance without editing source code, and the existing production instance stops depending on hard-coded `liamthemo.com` values.
2. **Multi-domain:** native mailboxes on more than one domain, managed by the existing single administrator.
3. **Pluggable outbound sending:** Cloudflare Email Sending remains the default; Resend is an opt-in transport selectable per domain.
4. **Customization:** administrator-controlled instance branding (name, logo, icons, accent, default theme) with an administrator lock over what users may change, plus user themes and icon sets where allowed.
5. **Licensing:** allow others, including businesses, to run their own instance with credit given, while continuing to prohibit redistribution.

## Recorded decisions

| # | Question | Decision | Detail |
| --- | --- | --- | --- |
| 1 | May other people use the software? | **Yes — personal and commercial use and self-hosting permitted, with required attribution; redistribution and paid services prohibited.** | [LICENSING.md](./LICENSING.md) |
| 2 | Admin model across domains | **Global:** one administrator account manages every domain and mailbox. | [MULTI_DOMAIN.md](./MULTI_DOMAIN.md#administrator-model) |
| 3 | Should Resend replace Cloudflare sending by default? | **No.** Cloudflare stays the default; Resend is opt-in per domain. | [OUTBOUND_TRANSPORTS.md](./OUTBOUND_TRANSPORTS.md) |
| 4 | Who controls themes/branding? | **Administrator lock:** the admin sets branding and decides which appearance options users may change. | [CUSTOMIZATION.md](./CUSTOMIZATION.md#administrator-lock) |
| 5 | Secrets and `.env` | `.env` is the source of truth; secret values are still **uploaded as Worker secrets** by a script, never written into `wrangler.jsonc` or the bundle. | [CONFIG_UNIFICATION.md](./CONFIG_UNIFICATION.md#why-secrets-stay-worker-secrets) |

## Phases

| Version | Phase | Depends on | Summary |
| --- | --- | --- | --- |
| **v3.00** | [Config unification](./CONFIG_UNIFICATION.md) | — | Typed runtime config, remove hard-coded identity, `.env` → rendered Wrangler config + secret upload, setup/deploy scripts, license swap |
| **v3.01** | [Multi-domain](./MULTI_DOMAIN.md) | v3.00 | `domains` table, domain-aware address rules and routing, domain admin UI with DNS checklist |
| **v3.02** | [Outbound transports + Resend](./OUTBOUND_TRANSPORTS.md) | v3.01 | `OutboundTransport` interface, per-domain transport, Resend send + signed webhooks, suppression list |
| **v3.03** | [Theme foundation](./THEME_FOUNDATION.md) | — | Tokenize ~830 hard-coded CSS colour literals; no visible change |
| **v3.04** | [Customization](./CUSTOMIZATION.md) | v3.00, v3.03 | Instance branding, admin lock, user themes, icon sets, per-mailbox accent |

Supporting documents:

- [Self-hosting guide (target state)](./SELF_HOSTING.md) — what an operator will do once v3.00 ships.
- [Licensing change](./LICENSING.md) — options and a draft of the new terms.

### Sequencing

```text
v3.00 config ──► v3.01 domains ──► v3.02 transports ──┐
      │                                               ├──► v3.04 customization ──► main
      └──────────► v3.03 theme tokens (parallel) ─────┘
```

- **v3.00 is the foundation.** Domains, transports and branding all read from the config module it introduces.
- **v3.03 can run in parallel** with v3.01–v3.02: it only touches client CSS, which those phases do not.
- **v3.01 precedes v3.02** because transport selection is a per-domain setting.
- Each version branch follows the existing release process (temporary branch → version branch → `main`), and production `main` only moves when a phase's exit gate is met.

## Cross-phase acceptance criteria

1. The existing production instance (`contact@liamthemo.com`, Gmail connections, passkeys, admin MFA, stored mail) works unchanged after every phase.
2. `grep -ri liamthemo src/ public/ index.html` returns nothing after v3.00; all instance identity comes from configuration.
3. A fresh Cloudflare account can go from `git clone` to a working instance using only `.env` and documented npm scripts.
4. No secret value is ever written to a committed file, the rendered `wrangler.jsonc`, the client bundle, or build logs.
5. Every new admin-mutating route (domains, transports, branding) requires the existing admin step-up and writes to `admin_security_events`.
6. The v2.07 security properties (same-origin checks, mailbox scoping, attachment headers, rate limits) are preserved; new public endpoints are explicitly reviewed.
7. CI keeps running on `vX.XX` branches and gains tests for each phase.

## Explicitly out of scope for v3

- IMAP/POP3/SMTP client access.
- Per-domain administrators or delegated multi-tenant hosting (see [decision 2](./MULTI_DOMAIN.md#administrator-model)).
- Resend as an inbound provider.
- Arbitrary admin-supplied custom CSS.
- A public package or container image (redistribution is not licensed).

These documents are **planning inputs**. They do not authorize infrastructure changes or claim a deployment occurred.
