import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import type { EffectiveAppearance, IconSetId, Lock, Preferences } from "../worker/customization";
import { useInstance } from "./instance";

export type { EffectiveAppearance, IconSetId, Lock, Preferences };

// The look on screen (theme-boot.js applies it before the bundle loads), and
// each mailbox's own look, so switching to a mailbox needs no round trip.
const STORAGE_KEY = "ltm:appearance";
const ACCOUNT_KEY = (accountId: string) => `ltm:appearance:account:${accountId}`;

declare global {
  interface Window { __ltmApplyAppearance?: (appearance: Partial<EffectiveAppearance>) => void }
}

type AccountAppearance = { id: string; preferences: Preferences; effective: EffectiveAppearance; lock: Lock };

function readJson<T>(key: string): T | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return parsed && typeof parsed === "object" ? parsed as T : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be blocked */ }
}

/** Apply through theme-boot.js (same attributes it sets on load) and cache for the next cold start. */
function applyAppearance(appearance: EffectiveAppearance): void {
  try { window.__ltmApplyAppearance?.(appearance); } catch { /* theme-boot is optional */ }
  writeJson(STORAGE_KEY, appearance);
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
  // undefined until a screen says what it shows: a mailbox (its id) or the
  // signed-out and admin screens (null, the instance defaults). Until then the
  // look theme-boot.js applied stays, so nothing flashes while the app starts.
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
  const [account, setAccount] = useState<AccountAppearance | null>(null);
  const [startup] = useState<EffectiveAppearance>(() => ({ ...fallback, ...readJson<EffectiveAppearance>(STORAGE_KEY) }));
  // Cached instance details count: only a browser that has never loaded them waits.
  const knowsInstance = instance.loaded || instance.defaultTheme !== undefined;

  useLayoutEffect(() => {
    if (accountId === null && knowsInstance) applyAppearance(instanceDefaults);
  }, [accountId, knowsInstance, instanceDefaults]);

  // Before paint: the mailbox's cached look, then the server's current one.
  useLayoutEffect(() => {
    if (!accountId) { setAccount(null); return; }
    const cached = readJson<AccountAppearance>(ACCOUNT_KEY(accountId));
    if (cached?.effective) {
      setAccount({ ...cached, id: accountId });
      applyAppearance(cached.effective);
    }
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    fetch(`/api/preferences?accountId=${encodeURIComponent(accountId)}`, { cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<Omit<AccountAppearance, "id">> : null)
      .then(data => {
        if (!data || cancelled) return;
        const next = { id: accountId, ...data };
        setAccount(next);
        writeJson(ACCOUNT_KEY(accountId), next);
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
    const next = { id: accountId, preferences: data.preferences, effective: data.effective, lock: data.lock };
    setAccount(next);
    writeJson(ACCOUNT_KEY(accountId), next);
    applyAppearance(data.effective);
  }, [accountId]);

  const current = account && account.id === accountId ? account : null;
  const value = useMemo<AppearanceState>(() => ({
    effective: current?.effective ?? (accountId === undefined ? startup : instanceDefaults),
    preferences: current?.preferences ?? {},
    lock: current?.lock ?? instance.lock ?? null,
    accountId: accountId ?? null,
    setAccountId,
    save,
  }), [current, accountId, startup, instanceDefaults, instance.lock, save]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceState {
  return useContext(AppearanceContext) ?? {
    effective: fallback, preferences: {}, lock: null, accountId: null,
    setAccountId: () => undefined, save: async () => undefined,
  };
}

/** Appearance follows the mailbox the user is looking at (switched before the next paint). */
export function useActiveAccountAppearance(accountId: string | null): void {
  const { setAccountId } = useAppearance();
  useLayoutEffect(() => {
    setAccountId(accountId);
    return () => setAccountId(null);
  }, [accountId, setAccountId]);
}

/** Rendered by screens that show the instance's own look: sign-in, setup and the admin panel. */
export function InstanceAppearance(): null {
  useActiveAccountAppearance(null);
  return null;
}
