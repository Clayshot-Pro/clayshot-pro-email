import type { ConnectedAccount, NotificationState } from "../mailTypes";
import { notificationLabel } from "../mailUtils";
import { useInstance } from "../instance";
import { AboutSettings, AppearanceSettings } from "./AppearanceSettings";

type Props = {
  open: boolean;
  accounts: ConnectedAccount[];
  notificationState: NotificationState;
  notificationsDisabled: boolean;
  connectingGmail: boolean;
  sessionCount: number | null;
  busy: string | null;
  onClose: () => void;
  isAdmin: boolean;

  onToggleNotifications: () => void;
  onAddInbox: () => void;
  onRemoveAccount: (id: string) => void;
  onEditProfile: () => void;
  onViewSessions: () => void;
  onResetSessions: () => void;
  onLogout: () => void;
};

export function SettingsModal(props: Props) {
  const { brandName } = useInstance();
  if (!props.open) return null;

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header>
          <div>
            <span>Private mailbox</span>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button
            className="settings-close"
            type="button"
            onClick={props.onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </header>

        <div className="settings-scroll">
          <section className="settings-section">
            <h3>Inboxes</h3>
            <p>Accounts available inside {brandName}.</p>
            <div className="settings-accounts">
              {props.accounts.map((account) => (
                <div className="settings-account" key={account.id}>
                  {account.avatarUrl ? (
                    <img src={account.avatarUrl} alt="" />
                  ) : (
                    <span className="settings-avatar-fallback">
                      {account.emailAddress[0]?.toUpperCase()}
                    </span>
                  )}
                  <div>
                    <strong>{account.displayName || account.emailAddress}</strong>
                    <small>
                      {account.provider === "gmail" ? "Google · " : "Custom · "}
                      {account.emailAddress}
                    </small>
                  </div>
                  {(account.id === "native:primary" || account.provider === "gmail" || !props.isAdmin) ? (
                    <div className="settings-account-actions">
                      {account.id === "native:primary" ? (
                        <button type="button" disabled={props.busy !== null} onClick={props.onEditProfile}>
                          Edit profile
                        </button>
                      ) : null}
                      {(account.provider === "gmail" || !props.isAdmin) ? (
                        <button type="button" disabled={props.busy !== null} onClick={() => props.onRemoveAccount(account.id)}>
                          Remove
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <button
              className="settings-primary"
              type="button"
              disabled={props.connectingGmail || props.busy !== null}
              onClick={props.onAddInbox}
            >
              {props.connectingGmail ? "Connecting…" : "Add Inbox"}
            </button>
          </section>

          <AppearanceSettings />

          <section className="settings-section">
            <h3>Notifications</h3>
            <div className="settings-row">
              <div>
                <strong>Push notifications</strong>
                <small>
                  {notificationLabel(props.notificationState)} · alerts contain no sender or subject
                </small>
              </div>
              <button
                type="button"
                disabled={props.notificationsDisabled}
                onClick={props.onToggleNotifications}
              >
                {props.notificationState === "on" ? "Disable" : "Enable"}
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3>Security &amp; sessions</h3>
            {props.isAdmin ? (
              <>
                <div className="settings-row">
                  <div>
                    <strong>Passkeys</strong>
                    <small>Passkey creation is disabled after initial setup.</small>
                  </div>
                  <span className="settings-locked">Locked</span>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>Active sessions</strong>
                    <small>
                      {props.sessionCount === null
                        ? "Checking…"
                        : `${props.sessionCount} signed-in session${props.sessionCount === 1 ? "" : "s"}`}
                    </small>
                  </div>
                  <div className="settings-row-actions">
                    <button
                      type="button"
                      disabled={props.busy !== null}
                      onClick={props.onViewSessions}
                    >
                      View all
                    </button>
                    <button
                      type="button"
                      disabled={props.busy !== null}
                      onClick={props.onResetSessions}
                    >
                      Reset others
                    </button>
                  </div>
                </div>
              </>
            ) : null}
            <div className="settings-row danger">
              <div>
                <strong>Log out</strong>
                <small>Sign out all email accounts on this device. Other devices stay signed in.</small>
              </div>
              <button
                type="button"
                disabled={props.busy !== null}
                onClick={props.onLogout}
              >
                Log out
              </button>
            </div>
          </section>

          <AboutSettings />
        </div>
      </section>
    </div>
  );
}
