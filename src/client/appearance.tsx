import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EffectiveAppearance, IconSetId, Lock, Preferences } from "../worker/customization";
import { useInstance } from "./instance";

export type { EffectiveAppearance, IconSetId, Lock, Preferences };

const STORAGE_KEY = "ltm:appearance";

declare global {
  interface Window { __ltmApplyAppearance?: (appearance: Partial<EffectiveAppearance>) => void }
}

/** Apply through theme-boot.js (same attributes it sets on load) and cache for the next cold start. */
export function applyAppearance(appearance: EffectiveAppearance): void {
  try { window.__ltmApplyAppearance?.(appearance); } catch { /* theme-boot is optional */ }
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance)); } catch { /* storage may be blocked */ }
}

type AppearanceState = {
  effective: EffectiveAppearance;
  preferences: Preferences;
  lock: Lock | null;
  accountId: string | null;
  setAccountId: (accountId: string | null) => void;
  save: (patch: Preferences) => Promise<void>;
};

const fallback: EffectiveAppearance = { theme: "ltm-dark", accent: null, density: "comfortable", textSize: "md", iconSet: "ltm" };
const AppearanceContext = createContext<AppearanceState | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const instance = useInstance();
  const instanceDefaults = useMemo<EffectiveAppearance>(() => ({
    theme: instance.defaultTheme ?? "ltm-dark",
    accent: instance.accent ?? null,
    density: "comfortable",
    textSize: "md",
    iconSet: instance.defaultIconSet ?? "ltm",
  }), [instance.defaultTheme, instance.accent, instance.defaultIconSet]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [account, setAccount] = useState<{ id: string; preferences: Preferences; effective: EffectiveAppearance; lock: Lock } | null>(null);

  // Signed-out screens and the admin panel follow the instance defaults.
  useEffect(() => {
    if (!accountId && instance.loaded) applyAppearance(instanceDefaults);
  }, [accountId, instance.loaded, instanceDefaults]);

  useEffect(() => {
    if (!accountId) { setAccount(null); return; }
    let cancelled = false;
    fetch(`/api/preferences?accountId=${encodeURIComponent(accountId)}`, { cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<{ preferences: Preferences; effective: EffectiveAppearance; lock: Lock }> : null)
      .then(data => {
        if (!data || cancelled) return;
        setAccount({ id: accountId, ...data });
        applyAppearance(data.effective);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [accountId]);

  const save = useCallback(async (patch: Preferences) => {
    if (!accountId) throw new Error("Open a mailbox to change its appearance");
    const response = await fetch(`/api/preferences?accountId=${encodeURIComponent(accountId)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    const data = await response.json().catch(() => ({})) as { preferences?: Preferences; effective?: EffectiveAppearance; lock?: Lock; error?: string };
    if (!response.ok || !data.effective || !data.preferences || !data.lock) throw new Error(data.error || "Could not save appearance");
    setAccount({ id: accountId, preferences: data.preferences, effective: data.effective, lock: data.lock });
    applyAppearance(data.effective);
  }, [accountId]);

  const current = account && account.id === accountId ? account : null;
  const value = useMemo<AppearanceState>(() => ({
    effective: current?.effective ?? instanceDefaults,
    preferences: current?.preferences ?? {},
    lock: current?.lock ?? instance.lock ?? null,
    accountId,
    setAccountId,
    save,
  }), [current, instanceDefaults, instance.lock, accountId, save]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceState {
  return useContext(AppearanceContext) ?? {
    effective: fallback, preferences: {}, lock: null, accountId: null,
    setAccountId: () => undefined, save: async () => undefined,
  };
}

/** Appearance follows the mailbox the user is looking at. */
export function useActiveAccountAppearance(accountId: string | null): void {
  const { setAccountId } = useAppearance();
  useEffect(() => {
    setAccountId(accountId);
    return () => setAccountId(null);
  }, [accountId, setAccountId]);
}
