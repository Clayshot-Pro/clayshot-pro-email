import { useCallback, useEffect, useState, type FormEvent } from "react";
import { adminActionFetch, approveAdminAction, type AdminApproval } from "../adminActions";
import { useInstance } from "../instance";

type Mailbox = {
  id: string;
  email_address: string;
  display_name: string;
  status: "active" | "disabled";
  quota_bytes: number;
  used_bytes: number;
  deleted_at: string | null;
  purge_after: string | null;
  spam_filter_enabled: number;
};

async function api(path: string, method = "GET", body?: unknown, approval?: AdminApproval): Promise<Record<string, unknown>> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const response = method === "GET"
    ? await fetch(path, { cache: "no-store" })
    : await adminActionFetch(path, method, payload, approval);
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Mailbox operation failed");
  return result;
}

export function MailboxManager({ onChanged }: { onChanged: () => void }) {
  const { primaryDomain } = useInstance();
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [address, setAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newCredential, setNewCredential] = useState<{ address: string; password: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [quotaGB, setQuotaGB] = useState("5");
  const [spamEnabled, setSpamEnabled] = useState(false);
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [customPassword, setCustomPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api("/api/mailboxes");
      setMailboxes(data.mailboxes as Mailbox[]);
      setLoaded(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load mailboxes");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(id: string, action: () => Promise<unknown>, success: string) {
    setBusy(id); setNotice(null);
    try {
      await action();
      await load();
      onChanged();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Mailbox operation failed");
    } finally {
      setBusy(null);
    }
  }

  function edit(box: Mailbox) {
    setEditing(box.id);
    setEditName(box.display_name);
    setQuotaGB(String(box.quota_bytes / 1073741824));
    setSpamEnabled(box.spam_filter_enabled === 1);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("new", async () => {
      const created = await api("/api/mailboxes", "POST", { address, displayName });
      if (typeof created.password === "string") {
        setNewCredential({ address: String((created.mailbox as Mailbox).email_address), password: created.password });
      }
      setAddress(""); setDisplayName("");
    }, "Mailbox created. Cloudflare catch-all routing must be configured for new addresses to receive mail.");
  }

  async function change(box: Mailbox, status: "active" | "disabled") {
    await run(box.id, () => api(`/api/mailboxes/${encodeURIComponent(box.id)}`, "PATCH", { status }), `Mailbox ${status}.`);
  }

  async function remove(box: Mailbox) {
    if (!window.confirm(`Schedule deletion of ${box.email_address}? New messages will be rejected. You can restore it within 30 days. No messages will be erased immediately.`)) return;
    await run(box.id, () => api(`/api/mailboxes/${encodeURIComponent(box.id)}`, "DELETE"), "Mailbox disabled and scheduled for deletion. Recovery is available for 30 days.");
  }

  async function restore(box: Mailbox) {
    await run(box.id, () => api(`/api/mailboxes/${encodeURIComponent(box.id)}/restore`, "POST"), "Mailbox restored.");
  }

  async function purge(box: Mailbox) {
    if (!window.confirm(`Permanently erase ${box.email_address} and its stored emails and attachments? This cannot be undone. Verify your backup first.`)) return;
    await run(box.id, async () => {
      const path = `/api/mailboxes/${encodeURIComponent(box.id)}/purge`;
      const approval = await approveAdminAction(path, "POST");
      for (let batch = 0; batch < 300; batch++) {
        const result = await api(path, "POST", undefined, approval);
        if (result.complete === true) return;
      }
      throw new Error("Purging is incomplete; repeat the operation to continue safely.");
    }, "Mailbox and stored content permanently deleted.");
  }

  async function reconcile(box: Mailbox) {
    setBusy(box.id); setNotice(null);
    try {
      const path = `/api/mailboxes/${encodeURIComponent(box.id)}/reconcile`;
      const approval = await approveAdminAction(path, "POST");
      for (let i = 0; i < 500; i++) {
        const result = await api(path, "POST", undefined, approval);
        if (result.complete === true) {
          if (result.applied === true) {
            setNotice(`Storage reconciled: ${(Number(result.countedBytes) / 1048576).toFixed(1)} MB.`);
          } else {
            setNotice(String(result.warning ?? "Storage counter could not be reconciled."));
          }
          await load();
          return;
        }
      }
      setNotice("Reconciliation is incomplete. Run it again to continue.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Storage reconciliation failed");
    } finally { setBusy(null); }
  }

  async function submitCustomPassword(box: Mailbox) {
    if (customPassword.length < 16 || customPassword.length > 128) {
      setNotice("Choose a password between 16 and 128 characters"); return;
    }
    if (customPassword !== confirmPassword) {
      setNotice("The confirmation does not match the new password"); return;
    }
    if (!window.confirm(`Set a new password for ${box.email_address}? All signed-in devices using this mailbox will need to sign in again.`)) return;
    await run(box.id, async () => {
      await api(`/api/mailboxes/${encodeURIComponent(box.id)}/reset-password`, "POST", {password:customPassword});
      setCustomPassword("");setConfirmPassword("");setShowPassword(false);setPasswordFor(null);
      setNewCredential(null);
    }, "Password updated. All previous mailbox device sessions have been revoked.");
  }

  async function resetPassword(box: Mailbox) {
    if (!window.confirm(`Generate a new password for ${box.email_address}? This will sign out every device using that mailbox.`)) return;
    await run(box.id, async () => {
      const credential = await api(`/api/mailboxes/${encodeURIComponent(box.id)}/reset-password`, "POST");
      if (typeof credential.password !== "string") throw new Error("No password returned");
      setNewCredential({ address: box.email_address, password: credential.password });
    }, "New password generated. Copy it now; the previous password no longer works.");
  }

  async function save(box: Mailbox) {
    const value = Number(quotaGB);
    if (!Number.isFinite(value) || value < 0.01 || value > 10) {
      setNotice("Select a quota between 0.01 and 10 GB."); return;
    }
    await run(box.id, async () => {
      await api(`/api/mailboxes/${encodeURIComponent(box.id)}`, "PATCH", {
        displayName: editName, quotaBytes: Math.round(value * 1073741824), spamFilterEnabled: spamEnabled,
      });
      setEditing(null);
    }, "Mailbox settings saved.");
  }

  return (
    <section className="settings-section admin-mailbox-panel" id="admin-mailboxes" aria-label="Native mailbox management">
      <div className="admin-section-heading">
        <div>
          <p className="admin-section-kicker">Domain management</p>
          <h2>Mailboxes</h2>
          <p>Create and manage addresses on {primaryDomain || "your domain"}. Each mailbox has its own login and storage.</p>
        </div>
        <span className="admin-mailbox-count">{loaded ? `${mailboxes.length} total` : "Loading…"}</span>
      </div>

      {loaded && (
        <div className="admin-mailbox-stats" aria-label="Mailbox overview">
          <div><strong>{mailboxes.filter(box => box.status === "active" && !box.deleted_at).length}</strong><span>Active</span></div>
          <div><strong>{mailboxes.filter(box => box.status === "disabled" || box.deleted_at).length}</strong><span>Inactive</span></div>
          <div><strong>{(mailboxes.reduce((sum, box) => sum + box.used_bytes, 0) / 1048576).toFixed(1)} MB</strong><span>Counted storage</span></div>
        </div>
      )}

      <div className="admin-mailbox-create">
        <div className="admin-subsection-heading">
          <h3>Create an address</h3>
          <p>A secure password will be generated for the new mailbox.</p>
        </div>
        <form className="mailbox-create-form" onSubmit={e => void create(e)}>
          <label htmlFor="new-mailbox-address">
            Email address
            <input id="new-mailbox-address" autoComplete="off" spellCheck={false} type="text" maxLength={254}
              placeholder={`example@${primaryDomain || "example.com"}`} value={address} onChange={e => setAddress(e.target.value)}
              required className="mailbox-entry-input" />
          </label>
          <label htmlFor="new-mailbox-name">
            Display name <span className="admin-field-optional">(optional)</span>
            <input id="new-mailbox-name" maxLength={80} value={displayName} onChange={e => setDisplayName(e.target.value)}
              placeholder="Personal" className="mailbox-entry-input" />
          </label>
          <button className="settings-primary" type="submit" disabled={busy !== null || !address.trim()}>
            {busy === "new" ? "Creating…" : "Create mailbox"}
          </button>
        </form>
      {newCredential && <div className="mailbox-generated-password" role="status">
        <strong>One-time login for {newCredential.address}</strong>
        <p>Copy this password now. It is not stored in readable form and will disappear when this panel closes.</p>
        <code>{newCredential.password}</code>
        <div className="settings-row-actions">
          <button type="button" onClick={() => void navigator.clipboard.writeText(newCredential.password)}>Copy password</button>
          <button type="button" onClick={() => setNewCredential(null)}>Hide password</button>
        </div>
      </div>}
      </div>

      {notice ? <p className="admin-mailbox-notice" role="status">{notice}</p> : null}

      <div className="admin-mailbox-list">
        <div className="admin-subsection-heading admin-mailbox-list-heading">
          <h3>Existing addresses</h3>
          <span>{loaded ? `${mailboxes.length} registered` : "Loading…"}</span>
        </div>
        {loaded && mailboxes.length === 0 ? (
          <p className="admin-mailbox-empty">No mailboxes found.</p>
        ) : null}
      <div className="settings-accounts admin-mailbox-items">
        {mailboxes.map(box => {
          const expired = Boolean(box.purge_after && Date.parse(box.purge_after.replace(" ", "T") + "Z") <= Date.now());
          const isPrimary = box.id === "native:primary";
          return (
            <div className="settings-account admin-mailbox-item" key={box.id}>
              <span className="settings-avatar-fallback">{box.email_address.charAt(0).toUpperCase()}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="admin-mailbox-name-row">
                  <strong>{box.email_address}</strong>
                  <span className={`admin-mailbox-status ${box.deleted_at ? "is-pending" : box.status === "active" ? "is-active" : "is-disabled"}`}>
                    {box.deleted_at ? "Pending deletion" : box.status === "active" ? "Active" : "Disabled"}
                  </span>
                </div>
                <small className="admin-mailbox-storage">
                  {(box.used_bytes / 1048576).toFixed(1)} MB counted · {(box.quota_bytes / 1073741824).toFixed(2)} GB limit
                </small>
                {passwordFor===box.id && !box.deleted_at ? (
                  <form className="mailbox-password-form" onSubmit={event => {
                    event.preventDefault();void submitCustomPassword(box);
                  }}>
                    <label htmlFor={`password-${box.id}`}>New password
                      <input id={`password-${box.id}`} type={showPassword?"text":"password"}
                        autoComplete="new-password" minLength={16} maxLength={128} value={customPassword}
                        onChange={event=>setCustomPassword(event.target.value)} required/>
                    </label>
                    <label htmlFor={`confirm-${box.id}`}>Confirm password
                      <input id={`confirm-${box.id}`} type={showPassword?"text":"password"}
                        autoComplete="new-password" minLength={16} maxLength={128} value={confirmPassword}
                        onChange={event=>setConfirmPassword(event.target.value)} required/>
                    </label>
                    <label className="mailbox-password-show"><input type="checkbox" checked={showPassword}
                      onChange={event=>setShowPassword(event.target.checked)}/> Show passwords</label>
                    <small>At least 16 characters. Updating this password signs out devices using this mailbox.</small>
                    <button className="settings-primary" type="submit" disabled={busy!==null}>Update password</button>
                  </form>
                ) : null}
                {editing === box.id ? (
                  <div style={{ display: "grid", gap: 7, marginTop: 10 }}>
                    <label>Display name <input value={editName} maxLength={80} onChange={e => setEditName(e.target.value)} /></label>
                    <label>Quota in GB <input type="number" min="0.01" max="10" step="0.01" value={quotaGB} onChange={e => setQuotaGB(e.target.value)} /></label>
                    <label><input type="checkbox" checked={spamEnabled} onChange={e => setSpamEnabled(e.target.checked)} /> Move high-confidence suspected spam to Junk (experimental)</label>
                    <div className="settings-row-actions">
                      <button type="button" disabled={busy !== null} onClick={() => void save(box)}>Save</button>
                      <button type="button" disabled={busy !== null} onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="settings-row-actions">
                {!box.deleted_at && editing !== box.id && (
                  <button type="button" disabled={busy !== null} onClick={() => edit(box)}>Edit details</button>
                )}
                {!box.deleted_at && (
                  <button type="button" disabled={busy !== null} onClick={() => {
                    setPasswordFor(passwordFor === box.id ? null : box.id);
                    setCustomPassword("");setConfirmPassword("");setShowPassword(false);setNotice(null);
                  }}>{passwordFor === box.id ? "Cancel password change" : "Change password"}</button>
                )}
                {!box.deleted_at && (
                  <details className="admin-mailbox-more">
                    <summary>More actions</summary>
                    <div className="admin-mailbox-more-content">
                      <button type="button" disabled={busy !== null} onClick={() => void resetPassword(box)}>Generate password</button>
                      <button type="button" disabled={busy !== null} onClick={() => void reconcile(box)}>Recount storage</button>
                      {!isPrimary && (
                        <>
                          <button type="button" disabled={busy !== null} onClick={() => void change(box, box.status === "active" ? "disabled" : "active")}>
                            {box.status === "active" ? "Disable" : "Enable"}
                          </button>
                          <button className="mailbox-danger-button" type="button" disabled={busy !== null} onClick={() => void remove(box)}>Delete</button>
                        </>
                      )}
                    </div>
                  </details>
                )}
                {box.deleted_at && !expired && <button type="button" disabled={busy !== null} onClick={() => void restore(box)}>Restore</button>}
                {box.deleted_at && expired && <button className="mailbox-danger-button" type="button" disabled={busy !== null} onClick={() => void purge(box)}>Erase permanently</button>}
              </div>
            </div>
          );
        })}
      </div>
      </div>
      <p className="admin-mailbox-footnote">Deleted mailboxes are recoverable for 30 days. Storage totals can be reconciled with Cloudflare R2.</p>
    </section>
  );
}
