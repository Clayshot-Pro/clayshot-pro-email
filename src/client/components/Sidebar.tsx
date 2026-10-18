import type { ConnectedAccount, Folder, FolderDefinition, NotificationState } from "../mailTypes";
import { notificationLabel } from "../mailUtils";
import { Icon } from "./Icon";
import { useInstance } from "../instance";
import { ALL_INBOXES_ID } from "../allInboxes";

type Props = {
  folders: FolderDefinition[];
  activeFolder: Folder;
  unreadCount: number;
  draftCount: number;
  notificationState: NotificationState;
  notificationsDisabled: boolean;
  accounts: ConnectedAccount[];
  activeAccountId: string;
  showAllInboxes: boolean;
  connectingGmail: boolean;
  onAccountChange: (id: string) => void;
  onAddInbox: () => void;
  onFolderChange: (folder: Folder) => void;
  onCompose: () => void;
  onToggleNotifications: () => void;
  onOpenSettings: () => void;
  /** Administrators only: switch to the admin panel. */
  onOpenAdmin?: () => void;
};

export function Sidebar({
  folders,
  activeFolder,
  unreadCount,
  draftCount,
  notificationState,
  notificationsDisabled,
  accounts,
  activeAccountId,
  showAllInboxes,
  connectingGmail,
  onAccountChange,
  onAddInbox,
  onFolderChange,
  onCompose,
  onToggleNotifications,
  onOpenSettings,
  onOpenAdmin,
}: Props) {
  const { brandName } = useInstance();
  return (
    <aside className="desktop-sidebar">
      <div className="brand-row">
        <div className="brand-copy"><strong className="brand-title">{brandName}</strong></div>
      </div>

      <button className="primary-compose" type="button" onClick={onCompose}>
        <Icon name="compose" size={17}/><span>New message</span>
      </button>

      <div className="account-switcher">
        <div className="nav-label">Accounts</div>
        <div className="desktop-account-list" role="list" aria-label="Mail accounts">
          {showAllInboxes ? (
            <button
              className={`desktop-account-option ${activeAccountId === ALL_INBOXES_ID ? "active" : ""}`}
              type="button"
              onClick={() => onAccountChange(ALL_INBOXES_ID)}
              aria-pressed={activeAccountId === ALL_INBOXES_ID}
            >
              <span className="desktop-account-fallback"><Icon name="inbox" size={13}/></span>
              <span className="desktop-account-copy">
                <strong>All inboxes</strong>
                <small>Every account on this device</small>
              </span>
              {activeAccountId === ALL_INBOXES_ID ? <span className="desktop-account-check">✓</span> : null}
            </button>
          ) : null}
          {accounts.map((account) => (
            <button
              key={account.id}
              className={`desktop-account-option ${account.id === activeAccountId ? "active" : ""}`}
              type="button"
              onClick={() => onAccountChange(account.id)}
              aria-pressed={account.id === activeAccountId}
            >
              {account.avatarUrl
                ? <img src={account.avatarUrl} alt=""/>
                : <span className="desktop-account-fallback"><Icon name="mail" size={13}/></span>}
              <span className="desktop-account-copy">
                <strong>{account.accentColor ? <i className="account-color-dot" style={{ background: account.accentColor }} aria-hidden="true" /> : null}{account.displayName || account.emailAddress}</strong>
                <small>{account.provider === "gmail" ? "Gmail" : "Custom"} · {account.emailAddress}</small>
              </span>
              {account.id === activeAccountId ? <span className="desktop-account-check">✓</span> : null}
            </button>
          ))}
        </div>
        <button className="desktop-add-account" type="button" disabled={connectingGmail} onClick={onAddInbox}>
          <Icon name="compose" size={14}/>{connectingGmail ? "Connecting…" : "Add Inbox"}
        </button>
      </div>

      <nav className="folder-nav" aria-label="Mail folders">
        <div className="nav-label">Mailbox</div>
        {folders.map((item) => {
          const count = item.key === "inbox" ? unreadCount : item.key === "drafts" ? draftCount : 0;
          return (
            <button
              key={item.key}
              className={`nav-item ${activeFolder === item.key ? "active" : ""}`}
              type="button"
              onClick={() => onFolderChange(item.key)}
            >
              <span className="nav-item-main"><Icon name={item.icon} size={17}/>{item.label}</span>
              {count > 0 ? <span className="nav-count">{count}</span> : null}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-spacer"/>
      <button className="notification-card" type="button" disabled={notificationsDisabled} onClick={onToggleNotifications}>
        <span className={`notification-icon ${notificationState === "on" ? "enabled" : ""}`}><Icon name="bell" size={16}/></span>
        <span className="notification-copy"><strong>{notificationLabel(notificationState)}</strong><small>Push alerts for new mail</small></span>
      </button>
      {onOpenAdmin ? (
        <button className="notification-card" type="button" onClick={onOpenAdmin}>
          <span className="notification-icon"><Icon name="archive" size={16}/></span>
          <span className="notification-copy"><strong>Admin panel</strong><small>Domains, mailboxes and keys</small></span>
        </button>
      ) : null}
      <button className="notification-card" type="button" onClick={onOpenSettings}>
        <span className="notification-icon"><Icon name="more" size={16}/></span>
        <span className="notification-copy"><strong>Settings</strong><small>Accounts, profile, and security</small></span>
      </button>
    </aside>
  );
}
