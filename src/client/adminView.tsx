import { createContext, useContext } from "react";

/**
 * Administrator sessions switch between the mail app (default) and the admin
 * panel. AuthGate owns the state; both views read it from here.
 */
export type AdminView = {
  isAdmin: boolean;
  openAdmin: () => void;
  openMail: () => void;
};

const noop = () => undefined;
const AdminViewContext = createContext<AdminView>({ isAdmin: false, openAdmin: noop, openMail: noop });

export const AdminViewProvider = AdminViewContext.Provider;
export const useAdminView = (): AdminView => useContext(AdminViewContext);

/** The panel's own section links (#admin-domains, …) also select the panel. */
export const adminPanelRequested = (hash: string) => hash === "#admin" || hash.startsWith("#admin-");
