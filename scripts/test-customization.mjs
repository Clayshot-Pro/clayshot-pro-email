import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACCENT_SWATCHES, accentProblem, contrastRatio, DEFAULT_SETTINGS, effectiveAppearance, inkFor, pngDimensions,
  readPreferences, readSettings, THEMES, updatePreferences, updateSettings,
} from "../src/worker/customization.ts";

// Contrast helpers.
assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
for (let value = 0; value < 256; value += 15) {
  const hex = `#${value.toString(16).padStart(2, "0").repeat(3)}`;
  assert.ok(contrastRatio(hex, inkFor(hex)) >= 4.5, `${hex} always gets readable ink`);
}
assert.equal(accentProblem("#202632", "ltm-dark") !== null, true, "accent matching the dark background is rejected");
assert.equal(accentProblem("#fafafa", "light") !== null, true, "near-white accent on light is rejected");
assert.equal(accentProblem("#b6a2c9", "ltm-dark"), null);
for (const theme of THEMES) assert.ok(ACCENT_SWATCHES.filter(swatch => !accentProblem(swatch, theme)).length >= 4, `${theme} offers at least four usable swatches`);

// Stored settings are sanitized and defaulted.
assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
const dirty = readSettings({ brandName: "<b>Acme</b>\u0000 Mail", accent: "#ABCDEF", defaultTheme: "nope", logoVersion: "../../x",
  lock: { theme: "yes", allowedThemes: ["light", "bogus"] } });
assert.equal(dirty.brandName, "b Acme /b Mail");
assert.equal(dirty.accent, "#abcdef");
assert.equal(dirty.defaultTheme, "ltm-dark");
assert.equal(dirty.logoVersion, null);
assert.equal(dirty.lock.theme, false);
assert.deepEqual(dirty.lock.allowedThemes, ["ltm-dark", "light"], "the default theme is always allowed");

// Admin updates.
let result = updateSettings(DEFAULT_SETTINGS, { brandName: "Acme Mail", defaultTheme: "light", accent: "#5b8def",
  lock: { theme: true, allowedThemes: ["graphite"] } }, false);
assert.ok(result.ok);
assert.equal(result.value.brandName, "Acme Mail");
assert.deepEqual(result.value.lock.allowedThemes, ["light", "graphite"]);
assert.equal(updateSettings(DEFAULT_SETTINGS, { brandName: "X" }, true).status, 409, "BRANDING_SOURCE=env makes names read-only");
assert.ok(updateSettings(DEFAULT_SETTINGS, { accent: "#5b8def" }, true).ok, "env branding still allows accent and locks");
assert.equal(updateSettings(DEFAULT_SETTINGS, { defaultTheme: "neon" }, false).status, 400);
assert.equal(updateSettings(DEFAULT_SETTINGS, { accent: "red" }, false).status, 400);
assert.equal(updateSettings(DEFAULT_SETTINGS, { accent: "#fefefe", defaultTheme: "light" }, false).status, 400);
assert.equal(updateSettings(DEFAULT_SETTINGS, { lock: { theme: 1 } }, false).status, 400);
assert.equal(updateSettings(DEFAULT_SETTINGS, [], false).status, 400);
assert.notEqual(updateSettings(DEFAULT_SETTINGS, { brandName: "Y" }, false).value, DEFAULT_SETTINGS, "updates never mutate input");
assert.equal(DEFAULT_SETTINGS.brandName, null);

// User preferences are bounded by the lock, enforced server-side.
const locked = { ...DEFAULT_SETTINGS, lock: { ...DEFAULT_SETTINGS.lock, theme: true, accent: true } };
assert.equal(updatePreferences({}, { theme: "light" }, locked).status, 403);
assert.equal(updatePreferences({}, { accent: "#5b8def" }, locked).status, 403);
assert.equal(updatePreferences({}, { accountColor: "#5b8def" }, locked).status, 403);
assert.ok(updatePreferences({}, { density: "compact", textSize: "lg", iconSet: "duotone" }, locked).ok);
assert.equal(updatePreferences({}, { theme: "graphite" }, { ...DEFAULT_SETTINGS, lock: { ...DEFAULT_SETTINGS.lock, allowedThemes: ["ltm-dark"] } }).status, 400,
  "themes outside allowedThemes are refused");
assert.equal(updatePreferences({}, { theme: "system" }, { ...DEFAULT_SETTINGS, lock: { ...DEFAULT_SETTINGS.lock, allowedThemes: ["ltm-dark"] } }).status, 400);
assert.ok(updatePreferences({}, { theme: "system" }, DEFAULT_SETTINGS).ok);
assert.equal(updatePreferences({}, { accent: "#000001" }, DEFAULT_SETTINGS).status, 400, "low-contrast accents are refused");
assert.equal(updatePreferences({}, { unknown: true }, DEFAULT_SETTINGS).status, 400);
assert.equal(updatePreferences({}, { density: "huge" }, DEFAULT_SETTINGS).status, 400);
assert.equal(updatePreferences({}, { iconSet: "../x" }, DEFAULT_SETTINGS).status, 400);
assert.deepEqual(readPreferences({ theme: "light", accent: "#ZZZZZZ", density: "compact", evil: "<x>" }), { theme: "light", density: "compact" });

// Effective appearance ignores locked choices but keeps them stored.
const prefs = { theme: "light", accent: "#5b8def", density: "compact", textSize: "xl", iconSet: "duotone" };
assert.deepEqual(effectiveAppearance(DEFAULT_SETTINGS, prefs), { theme: "light", accent: "#5b8def", density: "compact", textSize: "xl", iconSet: "duotone" });
const allLocked = { ...DEFAULT_SETTINGS, accent: "#ff8a3d", lock: { theme: true, accent: true, iconSet: true, density: true, textSize: true, allowedThemes: [...THEMES] } };
assert.deepEqual(effectiveAppearance(allLocked, prefs), { theme: "ltm-dark", accent: "#ff8a3d", density: "comfortable", textSize: "md", iconSet: "ltm" });
assert.equal(effectiveAppearance({ ...DEFAULT_SETTINGS, lock: { ...DEFAULT_SETTINGS.lock, allowedThemes: ["ltm-dark"] } }, prefs).theme, "ltm-dark",
  "a theme removed from allowedThemes falls back to the default");

// PNG checks without decoding.
const png = new Uint8Array(33);
png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
new DataView(png.buffer).setUint32(16, 512);
new DataView(png.buffer).setUint32(20, 512);
assert.deepEqual(pngDimensions(png), { width: 512, height: 512 });
assert.equal(pngDimensions(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")), null, "SVG is never a PNG");
assert.equal(pngDimensions(png.slice(0, 20)), null);

// Wiring: lock enforcement and attribution cannot be configured away.
const branding = readFileSync(new URL("../src/worker/branding.ts", import.meta.url), "utf8");
assert.match(branding, /updatePreferences\(current, input, settings\)/);
assert.match(branding, /deviceAuthorized\(request, env, accountId\)/, "preferences are scoped to an account signed in on this device");
const credit = readFileSync(new URL("../src/client/components/PoweredBy.tsx", import.meta.url), "utf8");
assert.match(credit, /Powered by/);
assert.match(credit, /https:\/\/github\.com\/LiamTheMo\/LTM-Email-Service/);
assert.doesNotMatch(credit, /useInstance|preferences|lock|props/i, "the credit reads no settings and takes no props");
assert.match(readFileSync(new URL("../src/client/AuthGate.tsx", import.meta.url), "utf8"), /<PoweredBy \/>/, "the sign-in page shows the credit");
assert.match(readFileSync(new URL("../src/client/components/SettingsModal.tsx", import.meta.url), "utf8"), /<AboutSettings \/>/);
assert.match(readFileSync(new URL("../src/client/components/AppearanceSettings.tsx", import.meta.url), "utf8"),
  /export function AboutSettings\(\) \{[\s\S]*<PoweredBy \/>/, "Settings → About shows the credit");

console.log("PASS: branding validation, administrator lock, preferences, contrast, PNG checks and attribution");
