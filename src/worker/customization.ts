/**
 * Pure validation for instance branding, the administrator lock and per-account
 * appearance preferences. D1 and R2 access lives in branding.ts.
 */
export const THEMES = ["ltm-dark", "ltm-ember", "light", "graphite", "high-contrast"] as const;
export const ICON_SETS = ["ltm", "ltm-bold", "duotone"] as const;
export const DENSITIES = ["compact", "comfortable", "spacious"] as const;
export const TEXT_SIZES = ["sm", "md", "lg", "xl"] as const;
export const ACCENT_SWATCHES = ["#ff8a3d", "#b6a2c9", "#5b8def", "#3fb67b", "#e5a50a", "#e06c75", "#2bb3c0", "#9aa0a6", "#2f5dff", "#1f7a4d", "#b3261e", "#6d3fd1"] as const;

export type ThemeId = typeof THEMES[number];
export type IconSetId = typeof ICON_SETS[number];
export type Density = typeof DENSITIES[number];
export type TextSize = typeof TEXT_SIZES[number];
export type ThemeChoice = ThemeId | "system";

/** Surface colour of each theme, used to keep custom accents visible (WCAG 1.4.11, 3:1). */
export const THEME_SURFACES: Record<ThemeId, string> = {
  "ltm-dark": "#12100f",
  "ltm-ember": "#141110",
  light: "#ffffff",
  graphite: "#18191b",
  "high-contrast": "#0a0a0a",
};

/** --color-bg of each theme, used for the PWA/status-bar theme colour. */
export const THEME_BACKGROUNDS: Record<ThemeId, string> = {
  "ltm-dark": "#0d0c0b",
  "ltm-ember": "#0d0c0b",
  light: "#f5f5f7",
  graphite: "#121314",
  "high-contrast": "#000000",
};

export type Lock = {
  theme: boolean;
  accent: boolean;
  iconSet: boolean;
  density: boolean;
  textSize: boolean;
  allowedThemes: ThemeId[];
};

/** Operational mail settings, editable by the admin (formerly Worker vars). */
export type MailSettings = {
  /** Copy of primary-mailbox mail to this address (must be verified in Email Routing). */
  forwardTo: string | null;
  maxMailboxes: number;
  /** Daily cron permanently purges mailboxes past their 30-day grace period. */
  purgeEnabled: boolean;
};

export type InstanceSettings = {
  brandName: string | null;
  brandShortName: string | null;
  logoVersion: string | null;
  accent: string | null;
  defaultTheme: ThemeId;
  defaultIconSet: IconSetId;
  lock: Lock;
  mail: MailSettings;
};

export type Preferences = Partial<{
  theme: ThemeChoice;
  accent: string | null;
  density: Density;
  textSize: TextSize;
  iconSet: IconSetId;
  accountColor: string | null;
}>;

export const DEFAULT_SETTINGS: InstanceSettings = {
  brandName: null,
  brandShortName: null,
  logoVersion: null,
  accent: null,
  defaultTheme: "ltm-dark",
  defaultIconSet: "ltm",
  lock: { theme: false, accent: false, iconSet: false, density: false, textSize: false, allowedThemes: [...THEMES] },
  mail: { forwardTo: null, maxMailboxes: 100, purgeEnabled: false },
};

const ADDRESS = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?.)+[a-z][a-z0-9-]*$/;
export const isMailAddress = (value: string): boolean => value.length <= 254 && ADDRESS.test(value);

const HEX = /^#[0-9a-f]{6}$/;
export const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Black or white, whichever reads better on the accent (always >= 4.5:1). */
export function inkFor(accent: string): "#000000" | "#ffffff" {
  return contrastRatio(accent, "#000000") >= contrastRatio(accent, "#ffffff") ? "#000000" : "#ffffff";
}

export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return HEX.test(lower) ? lower : null;
}

/** An accent must stay visible as a UI colour against the theme's surface. */
export function accentProblem(accent: string, theme: ThemeId): string | null {
  return contrastRatio(accent, THEME_SURFACES[theme]) >= 3
    ? null
    : `This colour is too close to the ${theme} background. Choose a ${theme === "light" ? "darker" : "lighter"} colour.`;
}

const label = (value: unknown, max: number): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return clean || null;
};

/** Merge stored JSON with defaults, dropping anything invalid. */
export function readSettings(raw: unknown): InstanceSettings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const lockInput = (input.lock && typeof input.lock === "object" ? input.lock : {}) as Record<string, unknown>;
  const allowed = Array.isArray(lockInput.allowedThemes)
    ? THEMES.filter(theme => (lockInput.allowedThemes as unknown[]).includes(theme))
    : [...THEMES];
  const defaultTheme = isOneOf(THEMES, input.defaultTheme) ? input.defaultTheme : DEFAULT_SETTINGS.defaultTheme;
  const mailInput = (input.mail && typeof input.mail === "object" ? input.mail : {}) as Record<string, unknown>;
  const forwardTo = typeof mailInput.forwardTo === "string" ? mailInput.forwardTo.trim().toLowerCase() : "";
  const maxMailboxes = Number(mailInput.maxMailboxes);
  return {
    brandName: label(input.brandName, 40),
    brandShortName: label(input.brandShortName, 20),
    logoVersion: typeof input.logoVersion === "string" && /^[\w:.-]{1,40}$/.test(input.logoVersion) ? input.logoVersion : null,
    accent: normalizeHex(input.accent),
    defaultTheme,
    defaultIconSet: isOneOf(ICON_SETS, input.defaultIconSet) ? input.defaultIconSet : DEFAULT_SETTINGS.defaultIconSet,
    lock: {
      theme: lockInput.theme === true,
      accent: lockInput.accent === true,
      iconSet: lockInput.iconSet === true,
      density: lockInput.density === true,
      textSize: lockInput.textSize === true,
      // The default theme is always allowed.
      allowedThemes: allowed.includes(defaultTheme) ? allowed : [defaultTheme, ...allowed],
    },
    mail: {
      forwardTo: isMailAddress(forwardTo) ? forwardTo : null,
      maxMailboxes: Number.isInteger(maxMailboxes) && maxMailboxes >= 1 && maxMailboxes <= 10_000 ? maxMailboxes : DEFAULT_SETTINGS.mail.maxMailboxes,
      purgeEnabled: mailInput.purgeEnabled === true,
    },
  };
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

/** Validate an admin update (branding, lock and mail settings). */
export function updateSettings(current: InstanceSettings, input: unknown): Result<InstanceSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Invalid settings", status: 400 };
  const body = input as Record<string, unknown>;
  const next: InstanceSettings = structuredClone(current);
  if ("brandName" in body || "brandShortName" in body) {
    if ("brandName" in body) {
      if (body.brandName !== null && typeof body.brandName !== "string") return { ok: false, error: "Invalid name", status: 400 };
      next.brandName = label(body.brandName, 40);
    }
    if ("brandShortName" in body) {
      if (body.brandShortName !== null && typeof body.brandShortName !== "string") return { ok: false, error: "Invalid short name", status: 400 };
      next.brandShortName = label(body.brandShortName, 20);
    }
  }
  if ("defaultTheme" in body) {
    if (!isOneOf(THEMES, body.defaultTheme)) return { ok: false, error: "Unknown theme", status: 400 };
    next.defaultTheme = body.defaultTheme;
  }
  if ("defaultIconSet" in body) {
    if (!isOneOf(ICON_SETS, body.defaultIconSet)) return { ok: false, error: "Unknown icon set", status: 400 };
    next.defaultIconSet = body.defaultIconSet;
  }
  if ("accent" in body) {
    if (body.accent === null) next.accent = null;
    else {
      const accent = normalizeHex(body.accent);
      if (!accent) return { ok: false, error: "Accent must be a #rrggbb colour", status: 400 };
      const problem = accentProblem(accent, next.defaultTheme);
      if (problem) return { ok: false, error: problem, status: 400 };
      next.accent = accent;
    }
  }
  if ("lock" in body) {
    const lock = body.lock as Record<string, unknown> | null;
    if (!lock || typeof lock !== "object" || Array.isArray(lock)) return { ok: false, error: "Invalid lock", status: 400 };
    for (const key of ["theme", "accent", "iconSet", "density", "textSize"] as const) {
      if (key in lock) {
        if (typeof lock[key] !== "boolean") return { ok: false, error: `Invalid lock.${key}`, status: 400 };
        next.lock[key] = lock[key] as boolean;
      }
    }
    if ("allowedThemes" in lock) {
      if (!Array.isArray(lock.allowedThemes) || !lock.allowedThemes.every(theme => isOneOf(THEMES, theme))) {
        return { ok: false, error: "Unknown theme in allowedThemes", status: 400 };
      }
      next.lock.allowedThemes = THEMES.filter(theme => (lock.allowedThemes as string[]).includes(theme));
    }
  }
  if ("mail" in body) {
    const mail = body.mail as Record<string, unknown> | null;
    if (!mail || typeof mail !== "object" || Array.isArray(mail)) return { ok: false, error: "Invalid mail settings", status: 400 };
    if ("forwardTo" in mail) {
      if (mail.forwardTo === null || mail.forwardTo === "") next.mail.forwardTo = null;
      else if (typeof mail.forwardTo !== "string" || !isMailAddress(mail.forwardTo.trim().toLowerCase())) {
        return { ok: false, error: "Forwarding address must be a valid email address", status: 400 };
      } else next.mail.forwardTo = mail.forwardTo.trim().toLowerCase();
    }
    if ("maxMailboxes" in mail) {
      if (!Number.isInteger(mail.maxMailboxes) || Number(mail.maxMailboxes) < 1 || Number(mail.maxMailboxes) > 10_000) {
        return { ok: false, error: "Mailbox limit must be between 1 and 10000", status: 400 };
      }
      next.mail.maxMailboxes = Number(mail.maxMailboxes);
    }
    if ("purgeEnabled" in mail) {
      if (typeof mail.purgeEnabled !== "boolean") return { ok: false, error: "Invalid purge setting", status: 400 };
      next.mail.purgeEnabled = mail.purgeEnabled;
    }
  }
  if (!next.lock.allowedThemes.includes(next.defaultTheme)) next.lock.allowedThemes.unshift(next.defaultTheme);
  return { ok: true, value: next };
}

/**
 * Validate a user's appearance update against the lock. Locked fields are
 * rejected (403) rather than silently ignored, so the server is the boundary.
 */
export function updatePreferences(
  current: Preferences, input: unknown, settings: InstanceSettings, domainTheme: ThemeId | null = null,
): Result<Preferences> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Invalid preferences", status: 400 };
  const body = input as Record<string, unknown>;
  const { lock } = settings;
  const next: Preferences = { ...current };
  const locked = (field: string) => ({ ok: false as const, error: `${field} is managed by your administrator`, status: 403 });
  for (const key of Object.keys(body)) {
    if (!["theme", "accent", "density", "textSize", "iconSet", "accountColor"].includes(key)) {
      return { ok: false, error: `Unknown preference ${key.slice(0, 40)}`, status: 400 };
    }
  }
  if ("theme" in body) {
    if (lock.theme) return locked("Theme");
    if (body.theme !== "system" && !(isOneOf(THEMES, body.theme) && lock.allowedThemes.includes(body.theme))) {
      return { ok: false, error: "That theme is not available", status: 400 };
    }
    if (body.theme === "system" && !(lock.allowedThemes.includes("light") && lock.allowedThemes.includes("ltm-dark"))) {
      return { ok: false, error: "System theme needs both light and dark themes to be allowed", status: 400 };
    }
    next.theme = body.theme as ThemeChoice;
  }
  if ("accent" in body) {
    if (lock.accent) return locked("Accent colour");
    if (body.accent === null) next.accent = null;
    else {
      const accent = normalizeHex(body.accent);
      if (!accent) return { ok: false, error: "Accent must be a #rrggbb colour", status: 400 };
      const theme = !lock.theme && next.theme && next.theme !== "system" ? next.theme : domainTheme ?? settings.defaultTheme;
      const problem = accentProblem(accent, theme);
      if (problem) return { ok: false, error: problem, status: 400 };
      next.accent = accent;
    }
  }
  if ("accountColor" in body) {
    if (lock.accent) return locked("Account colour");
    next.accountColor = body.accountColor === null ? null : normalizeHex(body.accountColor);
    if (body.accountColor !== null && !next.accountColor) return { ok: false, error: "Account colour must be a #rrggbb colour", status: 400 };
  }
  if ("density" in body) {
    if (lock.density) return locked("Density");
    if (!isOneOf(DENSITIES, body.density)) return { ok: false, error: "Unknown density", status: 400 };
    next.density = body.density;
  }
  if ("textSize" in body) {
    if (lock.textSize) return locked("Text size");
    if (!isOneOf(TEXT_SIZES, body.textSize)) return { ok: false, error: "Unknown text size", status: 400 };
    next.textSize = body.textSize;
  }
  if ("iconSet" in body) {
    if (lock.iconSet) return locked("Icon set");
    if (!isOneOf(ICON_SETS, body.iconSet)) return { ok: false, error: "Unknown icon set", status: 400 };
    next.iconSet = body.iconSet;
  }
  return { ok: true, value: next };
}

/** Stored preferences, filtered to valid values (locked values are kept but not applied). */
export function readPreferences(raw: unknown): Preferences {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prefs: Preferences = {};
  if (input.theme === "system" || isOneOf(THEMES, input.theme)) prefs.theme = input.theme as ThemeChoice;
  if (normalizeHex(input.accent)) prefs.accent = normalizeHex(input.accent);
  if (normalizeHex(input.accountColor)) prefs.accountColor = normalizeHex(input.accountColor);
  if (isOneOf(DENSITIES, input.density)) prefs.density = input.density;
  if (isOneOf(TEXT_SIZES, input.textSize)) prefs.textSize = input.textSize;
  if (isOneOf(ICON_SETS, input.iconSet)) prefs.iconSet = input.iconSet;
  return prefs;
}

export type EffectiveAppearance = {
  theme: ThemeChoice;
  accent: string | null;
  density: Density;
  textSize: TextSize;
  iconSet: IconSetId;
};

/** What the client applies: instance defaults, then unlocked user choices. */
export function effectiveAppearance(
  settings: InstanceSettings, prefs: Preferences, domainTheme: ThemeId | null = null,
): EffectiveAppearance {
  const { lock } = settings;
  // The admin's theme for the mailbox's domain wins over the instance default,
  // so the look switches with the mailbox. Users override it only if unlocked.
  const baseTheme = domainTheme ?? settings.defaultTheme;
  const theme = !lock.theme && prefs.theme && (prefs.theme === "system" || lock.allowedThemes.includes(prefs.theme))
    ? prefs.theme : baseTheme;
  return {
    theme,
    accent: (!lock.accent && prefs.accent) || settings.accent,
    density: (!lock.density && prefs.density) || "comfortable",
    textSize: (!lock.textSize && prefs.textSize) || "md",
    iconSet: (!lock.iconSet && prefs.iconSet) || settings.defaultIconSet,
  };
}

export const ICON_SIZES = [32, 180, 192, 512] as const;

/** Check a PNG's signature and IHDR dimensions without decoding it. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
