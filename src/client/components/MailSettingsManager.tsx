import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { MailSettings } from "../../worker/customization";
import { adminActionFetch } from "../adminActions";
import "../customization.css";

/** Instance mail settings stored in D1 (formerly FORWARD_TO, MAX_MAILBOXES, MAILBOX_PURGE_ENABLED vars). */
export function MailSettingsManager() {
  const [mail, setMail] = useState<MailSettings | null>(null);
  const [forwardTo, setForwardTo] = useState("");
  const [maxMailboxes, setMaxMailboxes] = useState("100");
  const [purgeEnabled, setPurgeEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/instance", { cache: "no-store" });
    const data = await response.json().catch(() => ({})) as { settings?: { mail: MailSettings }; error?: string };
    if (!response.ok || !data.settings) throw new Error(data.error || "Could not load mail settings");
    setMail(data.settings.mail);
    setForwardTo(data.settings.mail.forwardTo ?? "");
    setMaxMailboxes(String(data.settings.mail.maxMailboxes));
    setPurgeEnabled(data.settings.mail.purgeEnabled);
  }, []);
  useEffect(() => { load().catch(error => setNotice(error instanceof Error ? error.message : "Could not load")); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (purgeEnabled && !mail?.purgeEnabled && !window.confirm(
      "Turn on automatic purging? Mailboxes past their 30-day grace period will be erased permanently every day. Make sure you have a tested backup.")) return;
    setBusy(true); setNotice(null);
    try {
      const body = JSON.stringify({ mail: { forwardTo: forwardTo.trim() || null, maxMailboxes: Number(maxMailboxes), purgeEnabled } });
      const response = await adminActionFetch("/api/admin/instance", "PUT", body);
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not save mail settings");
      await load();
      setNotice("Mail settings saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save mail settings");
    } finally { setBusy(false); }
  }

  return (
    <section className="settings-section admin-domain-panel" id="admin-mail-settings" aria-label="Mail settings">
      <div className="admin-section-heading">
        <div>
          <p className="admin-section-kicker">Mail</p>
          <h2>Mail settings</h2>
          <p>Stored with your instance, not in Worker configuration.</p>
        </div>
      </div>
      {!mail ? <p className="admin-inline-state" role="status">{notice ?? "Loading mail settings…"}</p> : (
        <form onSubmit={event => void save(event)}>
          <div className="branding-grid">
            <label>
              Forward admin@ mail to
              <input type="text" inputMode="email" value={forwardTo} placeholder="Optional, e.g. me@example.net"
                autoCapitalize="none" spellCheck={false} maxLength={254} onChange={event => setForwardTo(event.target.value)} />
            </label>
            <label>
              Maximum mailboxes
              <input type="text" inputMode="numeric" value={maxMailboxes} onChange={event => setMaxMailboxes(event.target.value)} />
            </label>
          </div>
          <p className="branding-note">The forwarding address must be a verified destination in Cloudflare Email Routing.</p>
          <div className="branding-locks">
            <label>
              <input type="checkbox" checked={purgeEnabled} onChange={event => setPurgeEnabled(event.target.checked)} />
              Automatically purge deleted mailboxes after the 30-day grace period
            </label>
          </div>
          <div className="admin-domain-actions branding-actions">
            <button type="submit" className="settings-primary" disabled={busy}>{busy ? "Saving…" : "Save mail settings"}</button>
          </div>
          {notice && <p className="admin-inline-state" role="status">{notice}</p>}
        </form>
      )}
    </section>
  );
}
