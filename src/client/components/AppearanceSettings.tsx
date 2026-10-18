import { useState } from "react";
import { ACCENT_SWATCHES, accentProblem, THEMES, type Density, type IconSetId, type TextSize, type ThemeChoice, type ThemeId } from "../../worker/customization";
import { useAppearance, type Preferences } from "../appearance";
import { ICON_SET_LABELS, IconSetPreview } from "./Icon";
import { PoweredBy } from "./PoweredBy";
import { version } from "../../../package.json";
import "../customization.css";

export const THEME_LABELS: Record<ThemeId, string> = {
  "ltm-dark": "Dark (default)",
  "ltm-ember": "Ember",
  light: "Light",
  graphite: "Graphite",
  "high-contrast": "High contrast",
};
const DENSITY_LABELS: Record<Density, string> = { compact: "Compact", comfortable: "Comfortable", spacious: "Spacious" };
const TEXT_LABELS: Record<TextSize, string> = { sm: "90%", md: "100%", lg: "112%", xl: "125%" };

/** Settings → Appearance: only the options the administrator has not locked. */
export function AppearanceSettings() {
  const { effective, preferences, lock, accountId, save } = useAppearance();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!accountId) return null;
  const allowed = (lock?.allowedThemes ?? [...THEMES]) as ThemeId[];
  const canSystem = allowed.includes("light") && allowed.includes("ltm-dark");
  const visible = {
    theme: !lock?.theme, accent: !lock?.accent, iconSet: !lock?.iconSet, density: !lock?.density, textSize: !lock?.textSize,
  };
  const activeTheme: ThemeId = effective.theme === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "ltm-dark")
    : effective.theme;
  const swatches = ACCENT_SWATCHES.filter(swatch => !accentProblem(swatch, activeTheme));

  async function update(patch: Preferences, message = "Appearance saved.") {
    setBusy(true); setNotice(null);
    try { await save(patch); setNotice(message); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not save appearance"); }
    finally { setBusy(false); }
  }

  if (!Object.values(visible).some(Boolean)) {
    return (
      <section className="settings-section appearance-settings">
        <h3>Appearance</h3>
        <p>Appearance is managed by your administrator.</p>
      </section>
    );
  }

  return (
    <section className="settings-section appearance-settings" aria-label="Appearance">
      <h3>Appearance</h3>
      <p>Saved for this mailbox and synced to your other devices.</p>

      {visible.theme && (
        <fieldset className="appearance-group">
          <legend>Theme</legend>
          <div className="appearance-options">
            {canSystem && (
              <button type="button" className={preferences.theme === "system" ? "selected" : ""} aria-pressed={preferences.theme === "system"}
                disabled={busy} onClick={() => void update({ theme: "system" as ThemeChoice })}>
                <span className="theme-swatch theme-swatch-system" aria-hidden="true" />Match device
              </button>
            )}
            {allowed.map(theme => (
              <button key={theme} type="button" className={effective.theme === theme ? "selected" : ""} aria-pressed={effective.theme === theme}
                disabled={busy} onClick={() => void update({ theme })}>
                <span className={`theme-swatch theme-swatch-${theme}`} aria-hidden="true" />{THEME_LABELS[theme]}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {visible.accent && (
        <fieldset className="appearance-group">
          <legend>Accent colour</legend>
          <div className="appearance-swatches">
            <button type="button" className={`accent-swatch accent-default ${!preferences.accent ? "selected" : ""}`}
              aria-label="Theme default" aria-pressed={!preferences.accent} disabled={busy} onClick={() => void update({ accent: null })}>
              Aa
            </button>
            {swatches.map(swatch => (
              <button key={swatch} type="button" className={`accent-swatch ${preferences.accent === swatch ? "selected" : ""}`}
                style={{ background: swatch }} aria-label={`Accent ${swatch}`} aria-pressed={preferences.accent === swatch}
                disabled={busy} onClick={() => void update({ accent: swatch })} />
            ))}
            <label className="accent-custom">
              Custom
              <input type="color" value={preferences.accent ?? "#ff8a3d"} disabled={busy}
                onChange={event => void update({ accent: event.target.value })} />
            </label>
          </div>
        </fieldset>
      )}

      {visible.density && (
        <fieldset className="appearance-group">
          <legend>Density</legend>
          <div className="appearance-options">
            {(Object.keys(DENSITY_LABELS) as Density[]).map(density => (
              <button key={density} type="button" className={effective.density === density ? "selected" : ""} aria-pressed={effective.density === density}
                disabled={busy} onClick={() => void update({ density })}>{DENSITY_LABELS[density]}</button>
            ))}
          </div>
        </fieldset>
      )}

      {visible.textSize && (
        <fieldset className="appearance-group">
          <legend>Text size</legend>
          <div className="appearance-options">
            {(Object.keys(TEXT_LABELS) as TextSize[]).map(size => (
              <button key={size} type="button" className={effective.textSize === size ? "selected" : ""} aria-pressed={effective.textSize === size}
                disabled={busy} onClick={() => void update({ textSize: size })}>{TEXT_LABELS[size]}</button>
            ))}
          </div>
        </fieldset>
      )}

      {visible.iconSet && (
        <fieldset className="appearance-group">
          <legend>Icons</legend>
          <div className="appearance-options">
            {(Object.keys(ICON_SET_LABELS) as IconSetId[]).map(set => (
              <button key={set} type="button" className={effective.iconSet === set ? "selected" : ""} aria-pressed={effective.iconSet === set}
                disabled={busy} onClick={() => void update({ iconSet: set })}>
                <IconSetPreview set={set} />{ICON_SET_LABELS[set]}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {visible.accent && (
        <fieldset className="appearance-group">
          <legend>Mailbox colour</legend>
          <p className="appearance-hint">A dot beside this mailbox in the account list.</p>
          <div className="appearance-swatches">
            <button type="button" className={`accent-swatch accent-default ${!preferences.accountColor ? "selected" : ""}`}
              aria-label="No colour" aria-pressed={!preferences.accountColor} disabled={busy} onClick={() => void update({ accountColor: null })}>
              —
            </button>
            {ACCENT_SWATCHES.map(swatch => (
              <button key={swatch} type="button" className={`accent-swatch ${preferences.accountColor === swatch ? "selected" : ""}`}
                style={{ background: swatch }} aria-label={`Mailbox colour ${swatch}`} aria-pressed={preferences.accountColor === swatch}
                disabled={busy} onClick={() => void update({ accountColor: swatch }, "Mailbox colour saved. It appears after the account list refreshes.")} />
            ))}
          </div>
        </fieldset>
      )}

      {notice && <p className="appearance-notice" role="status">{notice}</p>}
    </section>
  );
}

/** Settings → About: version and the required attribution. */
export function AboutSettings() {
  return (
    <section className="settings-section about-settings" aria-label="About">
      <h3>About</h3>
      <p>Version {version}</p>
      <PoweredBy />
    </section>
  );
}
