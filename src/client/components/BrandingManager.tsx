import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { THEMES, type IconSetId, type InstanceSettings, type ThemeId } from "../../worker/customization";
import { adminActionFetch } from "../adminActions";
import { instanceIconUrl, useInstance } from "../instance";
import { ICON_SET_LABELS } from "./Icon";
import { THEME_LABELS } from "./AppearanceSettings";
import "../customization.css";

type Payload = { settings: InstanceSettings; effectiveNames: { name: string; shortName: string } };
const ICON_SIZES = [32, 180, 192, 512] as const;
const LOCK_LABELS: Record<"theme" | "accent" | "iconSet" | "density" | "textSize", string> = {
  theme: "Theme", accent: "Accent and mailbox colours", iconSet: "Icon set", density: "Density", textSize: "Text size",
};

async function bytesToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** Resize a square PNG/WebP in the browser into the PNG sizes the Worker accepts. */
async function generateIcons(file: File): Promise<Record<string, string>> {
  if (!["image/png", "image/webp"].includes(file.type)) throw new Error("Choose a PNG or WebP image (SVG is not accepted)");
  if (file.size > 5 * 1024 * 1024) throw new Error("Choose an image smaller than 5 MB");
  const bitmap = await createImageBitmap(file);
  if (bitmap.width !== bitmap.height) throw new Error("The image must be square");
  if (bitmap.width < 512) throw new Error("The image must be at least 512 × 512 pixels");
  const icons: Record<string, string> = {};
  for (const size of ICON_SIZES) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable in this browser");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size, size);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode the icon");
    icons[String(size)] = await bytesToBase64(blob);
  }
  bitmap.close();
  return icons;
}

export function BrandingManager() {
  const instance = useInstance();
  const [data, setData] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<InstanceSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/instance", { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as Payload & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Could not load branding");
    setData(payload);
    setDraft(payload.settings);
  }, []);
  useEffect(() => { load().catch(error => setNotice(error instanceof Error ? error.message : "Could not load branding")); }, [load]);

  async function run(key: string, action: () => Promise<Response>, success: string) {
    setBusy(key); setNotice(null);
    try {
      const response = await action();
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Branding update failed");
      await load();
      instance.refresh();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Branding update failed");
    } finally { setBusy(null); }
  }

  function save() {
    if (!draft || !data) return;
    const body: Record<string, unknown> = {
      accent: draft.accent, defaultTheme: draft.defaultTheme, defaultIconSet: draft.defaultIconSet, lock: draft.lock,
    };
    body.brandName = draft.brandName;
    body.brandShortName = draft.brandShortName;
    void run("save", () => adminActionFetch("/api/admin/instance", "PUT", JSON.stringify(body)), "Branding saved.");
  }

  async function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    let icons: Record<string, string>;
    try { icons = await generateIcons(file); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not read the image"); return; }
    await run("logo", () => adminActionFetch("/api/admin/instance/logo", "PUT", JSON.stringify({ icons })),
      "App icon updated. On iPhone and iPad, remove and re-add the home-screen app to see the new icon.");
  }

  if (!data || !draft) {
    return (
      <section className="settings-section admin-domain-panel" id="admin-branding" aria-label="Branding">
        <p className="admin-inline-state" role="status">{notice ?? "Loading branding…"}</p>
      </section>
    );
  }

  const set = (patch: Partial<InstanceSettings>) => setDraft(current => current ? { ...current, ...patch } : current);
  const setLock = (patch: Partial<InstanceSettings["lock"]>) => setDraft(current => current ? { ...current, lock: { ...current.lock, ...patch } } : current);

  return (
    <section className="settings-section admin-domain-panel" id="admin-branding" aria-label="Branding">
      <div className="admin-section-heading">
        <div>
          <p className="admin-section-kicker">Branding</p>
          <h2>Name, icon and appearance</h2>
          <p>Applies to the sign-in page, the installed app and every mailbox. The "Powered by LTM Email Service" credit always stays visible.</p>
        </div>
      </div>

      <div className="branding-logo">
        <img src={instanceIconUrl(instance, 180)} alt="Current app icon" width={56} height={56} />
        <label className="auth-secondary">
          {busy === "logo" ? "Uploading…" : "Upload icon"}
          <input type="file" accept="image/png,image/webp" hidden disabled={busy !== null} onChange={event => void uploadLogo(event)} />
        </label>
        {draft.logoVersion && (
          <button type="button" className="auth-secondary" disabled={busy !== null}
            onClick={() => void run("logo", () => adminActionFetch("/api/admin/instance/logo", "DELETE"), "Default icon restored.")}>
            Use default icon
          </button>
        )}
      </div>
      <p className="branding-note">Square PNG or WebP, at least 512 × 512. It is resized in your browser to 32, 180, 192 and 512 px.</p>

      <div className="branding-grid">
        <label>
          App name
          <input type="text" maxLength={40} value={draft.brandName ?? ""}
            placeholder={data.effectiveNames.name} onChange={event => set({ brandName: event.target.value || null })} />
        </label>
        <label>
          Short name (home screen)
          <input type="text" maxLength={20} value={draft.brandShortName ?? ""}
            placeholder={data.effectiveNames.shortName} onChange={event => set({ brandShortName: event.target.value || null })} />
        </label>
        <label>
          Default theme
          <select value={draft.defaultTheme} onChange={event => set({ defaultTheme: event.target.value as ThemeId })}>
            {THEMES.map(theme => <option key={theme} value={theme}>{THEME_LABELS[theme]}</option>)}
          </select>
        </label>
        <label>
          Default icons
          <select value={draft.defaultIconSet} onChange={event => set({ defaultIconSet: event.target.value as IconSetId })}>
            {(Object.keys(ICON_SET_LABELS) as IconSetId[]).map(id => <option key={id} value={id}>{ICON_SET_LABELS[id]}</option>)}
          </select>
        </label>
        <label>
          Accent colour
          <span className="appearance-swatches">
            <input type="color" value={draft.accent ?? "#ff7a2f"} onChange={event => set({ accent: event.target.value })} />
            {draft.accent && <button type="button" className="auth-secondary" onClick={() => set({ accent: null })}>Theme default</button>}
          </span>
        </label>
      </div>

      <div className="branding-locks">
        <strong>What users may change</strong>
        {(Object.keys(LOCK_LABELS) as (keyof typeof LOCK_LABELS)[]).map(key => (
          <label key={key}>
            <input type="checkbox" checked={!draft.lock[key]} onChange={event => setLock({ [key]: !event.target.checked })} />
            {LOCK_LABELS[key]}
          </label>
        ))}
        {!draft.lock.theme && (
          <div>
            <small>Themes users can pick</small>
            <div className="branding-themes">
              {THEMES.map(theme => (
                <label key={theme}>
                  <input type="checkbox" disabled={theme === draft.defaultTheme} checked={draft.lock.allowedThemes.includes(theme)}
                    onChange={event => setLock({
                      allowedThemes: event.target.checked
                        ? THEMES.filter(id => id === theme || draft.lock.allowedThemes.includes(id))
                        : draft.lock.allowedThemes.filter(id => id !== theme),
                    })} />
                  {THEME_LABELS[theme]}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="admin-domain-actions branding-actions">
        <button type="button" className="settings-primary" disabled={busy !== null} onClick={save}>
          {busy === "save" ? "Saving…" : "Save branding"}
        </button>
      </div>
      {notice && <p className="admin-inline-state" role="status">{notice}</p>}
    </section>
  );
}
