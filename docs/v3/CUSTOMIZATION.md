# v3.04 — Branding, themes and icons

**Document status:** Implemented on `v3.04` (icon sets shipped as outline, bold outline and duotone; logos uploaded as PNG). See [implementation status](./V3_IMPLEMENTATION_STATUS.md). Depends on [v3.00](./CONFIG_UNIFICATION.md) (config + `/api/instance`) and [v3.03](./THEME_FOUNDATION.md) (tokens).

## Scope

| Level | Who controls it | What |
| --- | --- | --- |
| **Instance branding** | Administrator | App name, short name, logo / app icon, accent colour, default theme, default icon set |
| **Administrator lock** | Administrator | Which appearance options users may change, and to what |
| **User appearance** | Each signed-in account, within the lock | Theme, colour scheme (light/dark/system), accent, density, text size, icon set |
| **Mailbox identity** | Administrator (and the mailbox owner, if unlocked) | Per-mailbox accent colour shown in the account switcher |

## Administrator lock

**Decision: the administrator controls branding and can lock appearance.**

Instance settings (D1, see schema below):

```jsonc
{
  "brandName": "Example Mail",
  "brandShortName": "Mail",
  "logoVersion": "2026-11-02T10:00:00Z",   // null → default mark
  "accent": "#b6a2c9",
  "defaultTheme": "ltm-dark",
  "defaultIconSet": "ltm",
  "lock": {
    "theme": false,          // true → users can't change theme
    "allowedThemes": ["ltm-dark", "light", "ltm-ember"],
    "accent": true,          // true → users can't override the accent
    "iconSet": false,
    "density": false,
    "textSize": false
  }
}
```

Rules:

- A locked field is **hidden in the user's Settings** and **rejected by the server** if submitted (`403`). Locking is enforced server-side, not just by hiding UI.
- When a field is locked, the client ignores any value the user saved earlier. The saved value is kept, so unlocking restores it.
- `allowedThemes` limits the picker even when the theme isn't fully locked. The default theme is always allowed.
- Changing instance settings requires admin step-up and is written to `admin_security_events`.

### Precedence

`D1 instance settings` > `.env` values from v3.00 (`BRAND_NAME`, `BRAND_SHORT_NAME`) > built-in defaults.

For operators who prefer configuration-as-code, `.env` can set `BRANDING_SOURCE=env`. The env values then always win, and the admin UI shows branding as read-only ("managed by deployment configuration"). Lock settings are always editable in the admin UI.

## Schema

Migration `0018_customization.sql`:

```sql
CREATE TABLE IF NOT EXISTS instance_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings TEXT NOT NULL DEFAULT '{}',      -- JSON, validated server-side
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_preferences (
  account_id TEXT PRIMARY KEY,              -- native mailbox id or connected Gmail account id
  preferences TEXT NOT NULL DEFAULT '{}',   -- JSON, validated server-side
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE native_mailboxes ADD COLUMN accent_color TEXT;
```

JSON is validated against a fixed schema: theme and icon-set IDs must exist, colours must be `#rrggbb`, density and text size must be from a fixed list. Unknown keys are dropped.

### Where user preferences live

Device sessions can hold several accounts (`device_session_accounts`) and have no single "user". Preferences are therefore stored **per account**, and the device applies **the active account's** preferences.

- This syncs across devices: signing in to the same mailbox elsewhere gives the same look.
- Switching between mailboxes can switch the look, which helps tell them apart. If that turns out to be confusing, the alternative is to apply the preferences of the account the device signed in with first. Decide after trying it on a real device.
- The last-applied preferences are cached in localStorage so `theme-boot.js` (v3.03) can apply them before React loads.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/instance` | public | v3.00 payload plus `accent`, `defaultTheme`, `defaultIconSet`, `logoVersion`, and the **lock** (so the sign-in page and Settings can render correctly) |
| `GET /api/instance/icon/:size.png` | public | Logo / app icon at 32, 180, 192, 512 px |
| `PUT /api/admin/instance` | admin + step-up | Update branding and lock |
| `PUT /api/admin/instance/logo` | admin + step-up | Upload icon set (see below) |
| `GET/PUT /api/preferences` | signed-in account | Read/update the active account's preferences; locked fields rejected |
| `PATCH /api/mailboxes/:id` | admin | Adds `accentColor` to the existing mailbox update |

## Logo and app icons

- Accepted formats: **PNG or WebP only**, square, at least 512×512, max 1 MB. **SVG is rejected**: an uploaded SVG served from the app origin can carry script, and the app's CSP is the only thing standing in the way.
- Resizing happens **in the admin's browser** (canvas) before upload, producing 32, 180, 192 and 512 px PNGs. The Worker re-checks the PNG signature, dimensions and size of each and stores them in R2 under `instance/icon/<size>.png`. No image-processing dependency is added to the Worker.
- Served with `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=31536000, immutable`, using `?v=<logoVersion>` to bust caches.
- The manifest, `apple-touch-icon` and favicon links (rewritten by the v3.00 `HTMLRewriter`) point at these routes. The default icon remains the static `public/apple-touch-icon.png` when no logo is uploaded.
- **iOS caches the home-screen icon when the app is installed.** The admin UI tells users they need to remove and re-add the app to see a new icon.
- The passkey `rpName` follows `brandName`. It's display-only, so changing it doesn't affect existing passkeys. `RP_ID` never changes.

## Themes

Built-in themes from v3.03: `ltm-dark`, `ltm-ember`, `light`, plus new presets added in this phase (for example a neutral grey dark theme and a high-contrast theme). Each preset is a palette file. Adding one doesn't need any component changes.

User-adjustable (if not locked):

- **Theme** from `allowedThemes`; **colour scheme** light/dark/system for themes that ship both variants.
- **Accent:** one of 8 preset swatches or a custom colour. Custom accents are checked for WCAG AA contrast against the theme's surface (4.5:1 for text on accent). Colours that fail are rejected with a message rather than silently adjusted.
- **Density:** compact / comfortable / spacious (`--density` multiplier).
- **Text size:** 90% / 100% / 112% / 125% (`--font-size-base`).

The accent is applied by setting `--color-accent` and deriving `--color-accent-hover/soft/strong` with `color-mix()` in CSS, so a single input value covers all accent tokens.

## Icon sets

- `Icon.tsx` changes from one `paths` map to `iconSets: Record<IconSetId, Record<IconName, ReactNode>>` plus a context provider. Call sites (`<Icon name="inbox" />`) don't change.
- Sets: `ltm` (current icons), `ltm-bold` (same paths, heavier stroke), and one new filled set.
- Any third-party icon set must use a permissive licence (MIT/ISC/Apache-2.0) and keep its attribution in a `THIRD_PARTY_NOTICES` file. That's compatible with the new LTM licence, since the third-party files stay under their own licences.
- The icon set is chosen by `defaultIconSet`, or by the user when `lock.iconSet` is false.

## Per-mailbox accent

- Optional `accent_color` on each native mailbox; Gmail accounts get one in `account_preferences`.
- Shown as a dot/ring on the avatar in the account switcher, sidebar and compose "From" picker.
- Purely visual. Doesn't affect the theme unless the user turns on "Use mailbox colour as accent".

## Attribution credit

The licence requires every instance to credit the project (see [LICENSING.md](./LICENSING.md#attribution-requirement)).

- A built-in "Powered by LTM Email Service" line, linking to the project repository, appears on the **sign-in page** and in **Settings → About**.
- It is rendered by a dedicated component that **reads nothing from instance settings, preferences or the lock**. Branding can change the app name and icon, but never this line.
- Every theme must keep it at WCAG AA contrast; the v3.03/v3.04 screenshot runs include it.
- A test asserts the component is present on both screens and that no instance or preference field can hide it.

## Settings UI

- **Settings → About** (new tab): version, the attribution credit, and links to the licence.
- **Settings → Appearance** (new tab in `SettingsModal`): theme, scheme, accent, density, text size, icon set, with a live preview. Locked items are hidden; if everything is locked, the tab shows "Appearance is managed by your administrator".
- **Admin → Branding** (new section in `AdminPanel`): name, short name, logo upload with preview of the generated sizes, accent, default theme/icon set, and the lock toggles with a short description of each.

## Out of scope

- Custom CSS uploaded by the admin. Even with a strict CSP, injected CSS can restyle security-relevant UI (e.g. hide the step-up prompt or fake a sign-in form). Revisit only with a sandboxed design.
- Theming the contents of HTML emails.
- Per-domain branding (one brand per instance, matching the [global admin model](./MULTI_DOMAIN.md#administrator-model)).

## Tests

- Preference validation: unknown theme/icon IDs, invalid colours, low-contrast accents, locked fields → `403`.
- Lock enforcement: server rejects writes to locked fields even when the client sends them.
- Logo upload: non-PNG/WebP, SVG, wrong dimensions, too large, PNG signature mismatch.
- Screenshot runs from v3.03 extended to every preset theme × light/dark.

## Exit gate

- [ ] Admin can rebrand (name, icon, accent) and the sign-in page, PWA manifest and tab title all update.
- [ ] Locks hide the controls and are enforced by the server.
- [ ] Preferences sync across two devices signed in to the same mailbox.
- [ ] Every preset theme passes contrast checks on text, buttons and focus rings.
- [ ] The default LTM look is unchanged for existing users who never touch the settings.
