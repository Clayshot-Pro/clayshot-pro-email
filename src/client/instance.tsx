import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** Public instance identity from GET /api/instance (no addresses or secrets). */
export type InstanceInfo = {
  brandName: string;
  brandShortName: string;
  primaryDomain: string;
  features: { gmail: boolean; push: boolean };
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
  };
}

const InstanceContext = createContext<InstanceInfo | null>(null);

export function InstanceProvider({ children }: { children: ReactNode }) {
  const [instance, setInstance] = useState<InstanceInfo>(initialInstance);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/instance", { cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<InstanceInfo> : null)
      .then(next => {
        if (!next || cancelled) return;
        setInstance(current => ({ ...current, ...next }));
        if (next.brandName) document.title = next.brandName;
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return <InstanceContext.Provider value={instance}>{children}</InstanceContext.Provider>;
}

export function useInstance(): InstanceInfo {
  return useContext(InstanceContext) ?? initialInstance();
}
