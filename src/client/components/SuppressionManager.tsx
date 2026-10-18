import { useCallback, useEffect, useState, type FormEvent } from "react";
import { adminActionFetch } from "../adminActions";

type Suppression = { address: string; reason: "hard_bounce" | "complaint" | "manual"; source: string; created_at: string };

const REASON: Record<Suppression["reason"], string> = {
  hard_bounce: "Hard bounce",
  complaint: "Spam complaint",
  manual: "Added manually",
};

/** Recipients that native mailboxes may not send to (bounces, complaints, manual blocks). */
export function SuppressionManager() {
  const [items, setItems] = useState<Suppression[] | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/suppressions", { cache: "no-store" });
    const data = await response.json().catch(() => ({})) as { suppressions?: Suppression[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Could not load suppressed recipients");
    setItems(data.suppressions ?? []);
  }, []);
  useEffect(() => { load().catch(error => setNotice(error instanceof Error ? error.message : "Could not load")); }, [load]);

  async function mutate(path: string, method: string, body: unknown, success: string) {
    setBusy(true); setNotice(null);
    try {
      const response = await adminActionFetch(path, method, body === undefined ? undefined : JSON.stringify(body));
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Operation failed");
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Operation failed");
    } finally { setBusy(false); }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = address.trim();
    void mutate("/api/admin/suppressions", "POST", { address: value }, `${value} blocked.`).then(() => setAddress(""));
  }

  return (
    <section className="settings-section admin-domain-panel" id="admin-suppressions" aria-label="Suppressed recipients">
      <div className="admin-section-heading">
        <div>
          <p className="admin-section-kicker">Deliverability</p>
          <h2>Suppressed recipients</h2>
          <p>Hard bounces and spam complaints reported by Resend are blocked automatically. Remove an address only if you know it can receive mail again.</p>
        </div>
        <span className="admin-mailbox-count">{items ? `${items.length} blocked` : "Loading…"}</span>
      </div>
      <form className="admin-domain-add" onSubmit={add}>
        <label htmlFor="suppress-address">
          Block an address
          <input id="suppress-address" type="email" value={address} onChange={event => setAddress(event.target.value)}
            placeholder="someone@example.net" required maxLength={254} className="mailbox-entry-input" />
        </label>
        <button type="submit" className="auth-secondary" disabled={busy}>Block</button>
      </form>
      {notice && <p className="admin-inline-state" role="status">{notice}</p>}
      {items && items.length > 0 && (
        <ul className="admin-dns-report">
          {items.map(item => (
            <li key={item.address}>
              <strong>{item.address}</strong>
              <small>{REASON[item.reason]} · {new Date(item.created_at.replace(" ", "T") + "Z").toLocaleString()}</small>
              <div className="admin-domain-actions">
                <button type="button" className="auth-secondary" disabled={busy}
                  onClick={() => void mutate(`/api/admin/suppressions/${encodeURIComponent(item.address)}`, "DELETE", undefined, `${item.address} unblocked.`)}>
                  Unblock
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
