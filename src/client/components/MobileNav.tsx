import { useEffect, useRef, useState } from "react";
import type { ConnectedAccount, Folder, FolderDefinition } from "../mailTypes";
import { Icon } from "./Icon";
import { useInstance } from "../instance";
import { ALL_INBOXES_ID } from "../allInboxes";

type MobileNavProps = {
  folders: FolderDefinition[];
  activeFolder: Folder;
  unreadCount: number;
  draftCount: number;
  accounts: ConnectedAccount[];
  activeAccountId: string;
  showAllInboxes: boolean;
  connectingGmail: boolean;
  onAccountChange: (id: string) => void;
  onAddInbox: () => void;
  onOpenSettings: () => void;
  onFolderChange: (folder: Folder) => void;
  onCompose: () => void;
};

export function MobileNav({
  folders, activeFolder, unreadCount, draftCount, accounts, activeAccountId, showAllInboxes,
  connectingGmail, onAccountChange, onAddInbox, onOpenSettings, onFolderChange, onCompose,
}: MobileNavProps) {
  const { brandName } = useInstance();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const activeItem = useRef<HTMLButtonElement>(null);
  const active = accounts.find(account => account.id === activeAccountId);

  const closeDrawer = () => {
    setDrawerOpen(false);
    menuButton.current?.focus();
  };

  // The open drawer takes focus on its current folder and closes on Escape.
  useEffect(() => {
    if (!drawerOpen) return;
    activeItem.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeDrawer(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <>
      <div className="mobile-account-bar">
        <button ref={menuButton} className="mobile-menu-button" type="button" aria-label="Open folders"
          aria-expanded={drawerOpen} aria-controls="mobile-folder-drawer" onClick={() => setDrawerOpen(true)}>
          <Icon name="menu" size={18}/>
          {unreadCount > 0 ? <i className="mobile-menu-dot" aria-hidden="true"/> : null}
        </button>
        {active?.avatarUrl ? <img className="mobile-account-avatar" src={active.avatarUrl} alt=""/> : null}
        <select aria-label="Mail account" value={activeAccountId} onChange={event => onAccountChange(event.target.value)}>
          {showAllInboxes ? <option value={ALL_INBOXES_ID}>All inboxes</option> : null}
          {accounts.map(account => (
            <option key={account.id} value={account.id}>
              {account.provider === "gmail" ? "Gmail · " : ""}{account.emailAddress}
            </option>
          ))}
        </select>
        <button type="button" disabled={connectingGmail} onClick={onAddInbox}>
          <span>{connectingGmail ? "Connecting…" : "Add Inbox"}</span>
        </button>
        <button className="mobile-settings-button" type="button" aria-label="Settings" onClick={onOpenSettings}>
          <Icon name="more" size={18}/>
        </button>
      </div>
      <button className="mobile-compose-fab" type="button" aria-label="Compose new message" onClick={onCompose}>
        <Icon name="compose" size={22}/>
      </button>
      <div className={`mobile-drawer-backdrop ${drawerOpen ? "open" : ""}`} aria-hidden="true" onClick={closeDrawer}/>
      <nav id="mobile-folder-drawer" className={`mobile-drawer ${drawerOpen ? "open" : ""}`} aria-label="Mail folders" inert={!drawerOpen}>
        <header className="mobile-drawer-header">
          <div>
            <strong>{brandName}</strong>
            <small>{activeAccountId === ALL_INBOXES_ID ? "All inboxes" : active?.emailAddress ?? ""}</small>
          </div>
          <button className="mobile-drawer-close" type="button" aria-label="Close folders" onClick={closeDrawer}>×</button>
        </header>
        <div className="mobile-drawer-folders">
          {folders.map(item => {
            const count = item.key === "inbox" ? unreadCount : item.key === "drafts" ? draftCount : 0;
            const current = activeFolder === item.key;
            return (
              <button key={item.key} ref={current ? activeItem : undefined} className={`nav-item mobile-drawer-item ${current ? "active" : ""}`}
                type="button" aria-current={current ? "page" : undefined}
                onClick={() => { onFolderChange(item.key); closeDrawer(); }}>
                <span className="nav-item-main"><Icon name={item.icon} size={18}/>{item.label}</span>
                {count > 0 ? <span className="nav-count">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
