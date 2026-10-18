import type { ConnectedAccount, Folder, FolderDefinition } from "../mailTypes";
import { Icon } from "./Icon";
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
  const active = accounts.find(account => account.id === activeAccountId);
  return (
    <>
      <div className="mobile-account-bar">
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
      <nav className="mobile-nav" aria-label="Mobile mail folders">
        {folders.map(item => {
          const count = item.key === "inbox" ? unreadCount : item.key === "drafts" ? draftCount : 0;
          return (
            <button key={item.key} className={activeFolder === item.key ? "active" : ""}
              type="button" onClick={() => onFolderChange(item.key)}>
              <span className="mobile-nav-icon">
                <Icon name={item.icon} size={18}/>{count > 0 ? <i>{count}</i> : null}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
