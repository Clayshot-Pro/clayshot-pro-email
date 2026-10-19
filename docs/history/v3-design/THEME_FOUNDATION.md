# v3.03 — Theme foundation (CSS tokenization)

> **Design record.** Written before implementation; the code, the [README](../../../README.md) and the [changelog](../../CHANGELOG.md) describe current behaviour.

**Document status:** Implemented on `v3.03` (rules kept in place rather than moved, proven equivalent by a static check). See [changelog](../../CHANGELOG.md). Independent of v3.01–v3.02; can be developed in parallel. Required by [v3.04 customization](./CUSTOMIZATION.md).

## Goal

Make the UI themeable **without changing how it looks today**. This phase is a refactor only: no new themes, no settings, no visible change. Keeping it separate means any visual regression can be traced to the refactor alone.

## Current state

Measured on v2.07:

| File | Lines | Hard-coded colour literals | `var(--…)` uses |
| --- | --- | --- | --- |
| `styles.css` | 511 | 155 | 66 |
| `dark.css` | 240 | 202 | 15 |
| `ui-overrides.css` | 1684 | 411 | 33 |
| `device-login.css` | 1292 | 37 | 209 |
| `mobile-accounts.css` | 3 | 21 | 26 |
| `email-html.css` | 29 | 2 | 1 |

That's about 830 literals. Other problems:

- `main.tsx` imports `styles.css` (a light palette) and then always imports `dark.css` on top of it. The light theme is effectively dead code that still ships.
- Two palettes coexist: the purple/slate inbox (`#b6a2c9`, `#322f42`, `#202531`) and the brown/orange sign-in and admin surfaces from v2.04 (`#1b0e07`, `#302a25`, `#ff9847`, `#ff742b`). `device-login.css` is already mostly tokenized.
- `index.html` hard-codes `<meta name="theme-color" content="#0d0c0b">` and the manifest does the same.
- `scripts/test-admin-layout.mjs` asserts on comments and rules inside `device-login.css`, so moving rules between files must keep that test passing (or update it in the same change).

## Token architecture

Three layers; components only consume layer 2 (or 3 where needed).

```text
Layer 1 — palette (per theme)      --p-slate-900: #202531;  --p-lilac-400: #b6a2c9; ...
Layer 2 — semantic (shared names)  --color-bg, --color-surface, --color-text, --color-accent, ...
Layer 3 — component (sparingly)    --compose-bg, --nav-active-indicator, ...
```

Semantic token set (initial):

| Group | Tokens |
| --- | --- |
| Surfaces | `--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-surface-sunken`, `--color-sidebar`, `--color-overlay` |
| Text | `--color-text`, `--color-text-muted`, `--color-text-subtle`, `--color-text-on-accent` |
| Lines | `--color-border`, `--color-border-strong`, `--color-focus-ring` |
| Accent | `--color-accent`, `--color-accent-hover`, `--color-accent-soft`, `--color-accent-strong` |
| Status | `--color-danger`, `--color-danger-soft`, `--color-success`, `--color-success-soft`, `--color-warning` |
| Effects | `--shadow-sm`, `--shadow-md`, `--shadow-lg` |
| Shape/type | `--radius-sm/md/lg/pill`, `--font-sans`, `--font-size-base`, `--density` (spacing scale multiplier) |
| Auth/admin | the existing `device-login.css` tokens, renamed into the same scheme |

## File layout after the refactor

```text
src/client/theme/
  tokens.css            semantic + component token defaults (references palette vars)
  themes/
    ltm-dark.css        [data-theme="ltm-dark"]   — today's inbox look (purple/slate)
    ltm-ember.css       [data-theme="ltm-ember"]  — today's sign-in/admin brown/orange
    light.css           [data-theme="light"]      — the current styles.css palette, restored
  base.css              resets, typography
src/client/styles.css, ui-overrides.css, ...   component rules using tokens only
```

- `dark.css` is removed; its overrides become the `ltm-dark` palette plus token references in the component rules.
- The sign-in/admin surfaces keep their current look by setting `data-theme="ltm-ember"` on their root element. **Scoped themes** (a subtree with its own `data-theme`) are a supported pattern, not a hack.
- `email-html.css` (rendered message bodies) is left alone. Theming email content is out of scope.

## Method

1. **Inventory:** add `scripts/audit-css-colors.mjs`, which lists every literal by file and line and groups identical values. Commit its first report as the starting point. (Removed in v3.24; `scripts/test-css-tokens.mjs` enforces the rule in CI.)
2. **Map:** assign each distinct value to a palette variable, then each use to a semantic token. Near-duplicates (e.g. `#1d1d1f` vs `#1b1b1d`) are merged only when the difference is invisible. Note every merge in the PR.
3. **Replace file by file** in small commits: `dark.css` → `styles.css` → `ui-overrides.css` → `device-login.css` → `mobile-accounts.css`.
4. **Guard:** CI fails if a colour literal appears outside `src/client/theme/themes/*.css` (allowlist: `email-html.css`, and `transparent`/`currentColor`).
5. **Boot without flash:** `public/theme-boot.js`, loaded synchronously in `<head>`, sets `data-theme` on `<html>` from a cached localStorage value before React mounts. It has to be an external file because the CSP is `script-src 'self'` (no inline scripts). It is wrapped in try/catch and falls back to the default theme.
6. **`theme-color`:** the meta tag is updated at runtime from `--color-bg` of the active theme; the manifest value comes from config (v3.00).

## Visual regression

Pixel diffs are the only way to prove "no visible change":

- Add a Playwright screenshot script (dev dependency) that captures, before and after: inbox list, reader, compose, settings, admin home, mailbox manager, sign-in, and device sign-in, at desktop (1440×900), iPhone (390×844) and iPad (820×1180).
- Baselines come from `main` at v2.07 with fixture data (no real mail).
- Allowed diff: anti-aliasing noise only. Anything larger blocks the merge.
- Manual pass on a real iPhone PWA and iPad, since status-bar colour and safe-area insets don't show up in headless screenshots.

## Exit gate

- [ ] Zero colour literals outside theme files (CI-enforced).
- [ ] Screenshot diffs clean on all screens and viewports.
- [ ] `test-admin-layout.mjs` and `test-add-inbox-ui.mjs` pass.
- [ ] No flash of the wrong theme on cold load (desktop and installed PWA).
- [ ] Switching `data-theme` on `<html>` in devtools to `light` gives a coherent light UI. It doesn't need to be polished yet; it proves the tokens are complete.
