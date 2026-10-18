import { useEffect, useState, type FormEvent } from "react";
import { MailboxManager } from "./MailboxManager";
import { DomainManager } from "./DomainManager";
import { SuppressionManager } from "./SuppressionManager";
import { BrandingManager } from "./BrandingManager";
import { PoweredBy } from "./PoweredBy";
import { AdminSecurityLog } from "./AdminSecurityLog";
import { adminActionFetch } from "../adminActions";
import { instanceIconUrl, useInstance } from "../instance";

export function AdminPanel() {
  const instance = useInstance();
  const { brandName } = instance;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [primaryMismatch, setPrimaryMismatch] = useState<{ stored: string; configured: string } | null>(null);
  const [domainVersion, setDomainVersion] = useState(0);

  useEffect(() => {
    fetch("/api/admin/status", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Unable to load administrator settings");
        const status = await response.json() as { passwordConfigured: boolean; primaryMismatch?: { stored: string; configured: string } | null };
        setConfigured(status.passwordConfigured);
        setPrimaryMismatch(status.primaryMismatch ?? null);
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : "Unable to load administrator settings"));
  }, []);

  async function saveAdminPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 32) {
      setError("Choose a password between 8 and 32 characters");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const response = await adminActionFetch("/api/admin/password", "POST", JSON.stringify({
        newPassword,
        currentPassword: configured ? currentPassword : undefined,
      }));
      const contentType = response.headers.get("Content-Type") ?? "";
      const result = contentType.includes("application/json")
        ? await response.json() as { error?: string }
        : null;
      if (!response.ok) {
        throw new Error(result?.error ?? `Unable to save the administrator password (HTTP ${response.status}). Please try again.`);
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // This revokes all previous administrator sessions. A fresh login requires
      // both the chosen password and the registered passkey.
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change password");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/device/logout", { method: "POST" });
    } finally {
      window.location.assign("/");
    }
  }

  const passwordSection = (
    <section className="settings-section admin-security-panel" id="admin-security" aria-label="Administrator security">
      <div className="admin-section-heading">
        <div>
          <p className="admin-section-kicker">Account security</p>
          <h2>Administrator password</h2>
          <p>A fresh passkey check is required to save security changes.</p>
        </div>
        {configured && <span className="admin-security-state">Passkey enabled</span>}
      </div>

      {configured === null ? (
        <p className="admin-inline-state" role="status">Checking password configuration…</p>
      ) : (
        <details className="admin-security-details" open={configured ? undefined : true}>
          <summary>{configured ? "Change administrator password" : "Complete administrator setup"}</summary>
          <div className="admin-security-content">
            <p>{configured
              ? "Changing your password signs out administrator sessions on every device."
              : "Choose your password to finish setup. You will sign in again using your password and passkey."}</p>
            <form className="auth-setup admin-password-form" onSubmit={event => void saveAdminPassword(event)}>
              {configured && (
                <label htmlFor="admin-current-password">
                  Current password
                  <input
                    id="admin-current-password" type="password" value={currentPassword}
                    onChange={event => setCurrentPassword(event.target.value)}
                    autoComplete="current-password" required
                  />
                </label>
              )}
              <label htmlFor="admin-new-password">
                New password
                <input
                  id="admin-new-password" type="password" value={newPassword}
                  onChange={event => setNewPassword(event.target.value)}
                  autoComplete="new-password" autoCapitalize="none" spellCheck={false}
                  minLength={8} maxLength={32} required
                />
              </label>
              <label htmlFor="admin-confirm-password">
                Confirm password
                <input
                  id="admin-confirm-password" type="password" value={confirmPassword}
                  onChange={event => setConfirmPassword(event.target.value)}
                  autoComplete="new-password" autoCapitalize="none" spellCheck={false}
                  minLength={8} maxLength={32} required
                />
              </label>
              <p className="admin-password-hint">8–32 characters. Special characters like ? and ! are supported.</p>
              <button type="submit" className="settings-primary" disabled={busy}>
                {busy ? "Saving…" : configured ? "Update password and sign out" : "Save password and sign out"}
              </button>
            </form>
          </div>
        </details>
      )}
      {error && <p role="alert" className="auth-error">{error}</p>}
    </section>
  );

  return (
    <main className="admin-home" id="admin-top">
      <div className="admin-home-card">
        <header className="admin-home-header">
          <div className="admin-home-identity">
            <img src={instanceIconUrl(instance, 180)} alt="" className="admin-home-logo" width={48} height={48} />
            <div>
              <p className="admin-section-kicker">{brandName} / Administrator</p>
              <h1>Email administration</h1>
              <p className="admin-home-subtitle">Manage your domains, mailboxes and account security.</p>
            </div>
          </div>
          <div className="admin-home-actions">
            <span className="admin-home-session" aria-label="Authenticated administrator">Secure session</span>
            <button type="button" className="auth-secondary" disabled={busy} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </header>

        <nav className="admin-home-nav" aria-label="Administrator sections">
          {configured && <a href="#admin-domains">Domains</a>}
          {configured && <a href="#admin-mailboxes">Mailboxes</a>}
          {configured && <a href="#admin-suppressions">Deliverability</a>}
          {configured && <a href="#admin-branding">Branding</a>}
          <a href="#admin-security">Security</a>
          <a href="#admin-audit">Activity</a>
        </nav>

        {primaryMismatch && (
          <p className="admin-config-warning" role="alert">
            PRIMARY_ADDRESS is {primaryMismatch.configured}, but the primary mailbox already holds mail as {primaryMismatch.stored}.
            It was not renamed automatically. Set PRIMARY_ADDRESS back, or plan an explicit migration.
          </p>
        )}
        {configured === false && passwordSection}
        {configured && <DomainManager onChanged={() => setDomainVersion(version => version + 1)} />}
        {configured && <MailboxManager key={domainVersion} onChanged={() => undefined} />}
        {configured && <SuppressionManager />}
        {configured && <BrandingManager />}
        {configured === true && passwordSection}
        {configured === true && <AdminSecurityLog />}
        {configured === null && (
          <section className="settings-section admin-loading-panel" role="status">
            Loading administrator settings…
          </section>
        )}

        <footer className="admin-home-footer">
          <span>Administrator access requires your password and passkey.</span>
          <a href="#admin-top">Back to top ↑</a>
        </footer>
        <PoweredBy />
      </div>
    </main>
  );
}
