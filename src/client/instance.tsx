import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { IconSetId, Lock, ThemeId } from "../worker/customization";

/** Public instance identity from GET /api/instance (no addresses or secrets). */
export type InstanceInfo = {
  brandName: string;
  brandShortName: string;
  primaryDomain: string;
  features: { gmail: boolean; push: boolean };
  /** False on a fresh install until first-run setup chooses the mail domain. */
  initialized?: boolean;
  setupAvailable?: boolean;
  logoVersion?: string | null;
  accent?: string | null;
  defaultTheme?: ThemeId;
  defaultIconSet?: IconSetId;
  lock?: Lock;
  /** True once /api/instance has answered. */
  loaded: boolean;
};

function initialInstance(): InstanceInfo {
  // The Worker rewrites <title> and the app title meta before the bundle loads,
  // so the brand renders correctly before /api/instance answers.
  const shortName = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')?.content;
  return {
    brandName: document.title || "Mail",
    brandShortName: shortName || document.title || "Mail",
    primaryDomain: "",
    features: { gmail: true, push: true },
    loaded: false,
  };
}

const InstanceContext = createContext<(InstanceInfo & { refresh: () => void }) | null>(null);

export function InstanceProvider({ children }: { children: ReactNode }) {
  const [instance, setInstance] = useState<InstanceInfo>(initialInstance);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/instance", { cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<Omit<InstanceInfo, "loaded">> : null)
      .then(next => {
        if (!next || cancelled) return;
        setInstance(current => ({ ...current, ...next, loaded: true }));
        if (next.brandName) document.title = next.brandName;
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [version]);
  return (
    <InstanceContext.Provider value={{ ...instance, refresh: () => setVersion(value => value + 1) }}>
      {children}
    </InstanceContext.Provider>
  );
}

export function useInstance(): InstanceInfo & { refresh: () => void } {
  return useContext(InstanceContext) ?? { ...initialInstance(), refresh: () => undefined };
}

/** App icon: the uploaded logo when one exists, else the bundled default. */
export function instanceIconUrl(instance: InstanceInfo, size: 32 | 180 | 192 | 512): string {
  return instance.logoVersion
    ? `/api/instance/icon/${size}.png?v=${encodeURIComponent(instance.logoVersion)}`
    : "/apple-touch-icon.png";
}
