import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ConnectedAccount } from "../mailTypes";

type Blocked = { pattern: string; createdAt: string };

const label = (pattern: string) => pattern.startsWith("@") ? `Everyone at ${pattern.slice(1)}` : pattern;

/** Settings: blocked senders of a custom mailbox signed in on this device. */
export function BlockedSenders({ accounts, preferredAccountId }: { accounts: ConnectedAccount[]; preferredAccountId: string | null }) {
  const mailboxes = accounts.filter(account => account.provider === "native" && account.status === "active");
  const [accountId, setAccountId] = useState(() =>
    mailboxes.find(account => account.id === preferredAccountId)?.id ?? mailboxes[0]?.id ?? "");
  const [items, setItems] = useState<Blocked[] | null>(null);
  const [sender, setSender] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setItems(null);
    const response = await fetch(`/api/blocked-senders?accountId=${encodeURIComponent(accountId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({})) as { blocked?: Blocked[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Could not load blocked senders");
    setItems(data.blocked ?? []);
  }, [accountId]);
  useEffect(() => { load().catch(error => setNotice(error instanceof Error ? error.message : "Could not load")); }, [load]);

  async function mutate(method: "POST" | "DELETE", pattern: string) {
    setBusy(true); setNotice(null);
    try {
      const query = `accountId=${encodeURIComponent(accountId)}` + (method === "DELETE" ? `&pattern=${encodeURIComponent(pattern)}` : "");
      const response = await fetch(`/api/blocked-senders?${query}`, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify({ sender: pattern, moveExisting: true }) : undefined,
      });
      const data = await response.json().catch(() => ({})) as { blocked?: Blocked[]; moved?: number; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not update blocked senders");
      setItems(data.blocked ?? []);
      if (method === "POST") {
        setSender("");
        setNotice(data.moved ? `Blocked. ${data.moved} existing message(s) moved to Junk.` : "Blocked.");
      } else {
        setNotice(`${label(pattern)} unblocked. Messages already in Junk stay there.`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update blocked senders");
    } finally { setBusy(false); }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sender.trim()) void mutate("POST", sender.trim());
  }

  return (
    <section className="settings-section" aria-label="Blocked senders">
      <h3>Blocked senders</h3>
      {!mailboxes.length ? (
        <p>Blocking is available for custom mailboxes. For Gmail accounts, block senders in Gmail.</p>
      ) : (
        <>
          <p>Mail from a blocked address or domain goes straight to Junk. Senders are not told.</p>
          {mailboxes.length > 1 ? (
            <div className="settings-row">
              <div><strong>Mailbox</strong></div>
              <select aria-label="Mailbox" value={accountId} disabled={busy} onChange={event => { setNotice(null); setAccountId(event.target.value); }}>
                {mailboxes.map(account => <option key={account.id} value={account.id}>{account.emailAddress}</option>)}
              </select>
            </div>
          ) : null}
          <form className="settings-row" onSubmit={add}>
            <input aria-label="Address or domain to block" type="text" inputMode="email" autoCapitalize="none" spellCheck={false}
              maxLength={254} placeholder="Address or domain" value={sender} onChange={event => setSender(event.target.value)} />
            <button type="submit" disabled={busy || !sender.trim()}>Block</button>
          </form>
          {items === null ? <small role="status">Loading…</small> : items.length === 0 ? (
            <small>No blocked senders.</small>
          ) : items.map(item => (
            <div className="settings-row" key={item.pattern}>
              <div><strong>{label(item.pattern)}</strong></div>
              <button type="button" disabled={busy} onClick={() => void mutate("DELETE", item.pattern)}>Unblock</button>
            </div>
          ))}
          {notice ? <small role="status">{notice}</small> : null}
        </>
      )}
    </section>
  );
}
