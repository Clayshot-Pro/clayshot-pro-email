import { useCallback, useEffect, useState } from "react";

type SecurityEvent = {
  id: string;
  event_type: string;
  outcome: "success" | "denied" | "failure";
  actor: string;
  target_type: string;
  target_fingerprint: string;
  created_at: string;
};

function formatEvent(value: string): string {
  return value.replace(/^admin\./, "").replace(/[._-]/g, " ");
}
function formatDate(value: string): string {
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isFinite(date.valueOf()) ? date.toLocaleString() : value;
}

export function AdminSecurityLog() {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch("/api/admin/audit", { cache: "no-store" });
      const data = await response.json() as { events?: SecurityEvent[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load security events");
      setEvents(data.events ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load security audit");
    } finally { setRefreshing(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return (
    <section className="settings-section admin-audit-panel" id="admin-audit" aria-label="Administrator security audit log">
      <div className="admin-section-heading">
        <div>
          <p className="admin-section-kicker">Activity</p>
          <h2>Security activity</h2>
          <p>Recent administrator sign-ins, passkey approvals and account changes. Events are retained for up to 90 days. No passwords or email contents are stored here.</p>
        </div>
        <button className="auth-secondary" type="button" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "Loading…" : "Refresh"}
        </button>
      </div>
      {error ? <p className="auth-error" role="alert">{error}</p> : null}
      <div className="admin-audit-list" aria-live="polite">
        {events === null ? <p>Loading security activity…</p> :
          events.length === 0 ? <p>No security events recorded yet.</p> :
          events.map(event => (
            <div key={event.id} className="admin-audit-row">
              <div>
                <strong>{formatEvent(event.event_type)}</strong>
                <small>{formatDate(event.created_at)} · {event.target_type || "account"}
                  {event.target_fingerprint ? " · " + event.target_fingerprint : ""}</small>
              </div>
              <span className={"admin-audit-outcome admin-audit-" + event.outcome}>{event.outcome}</span>
            </div>
          ))}
      </div>
      <p className="admin-audit-note">Displaying the latest 100 events. Activity records are administrative metadata, not a tamper-proof external audit service.</p>
    </section>
  );
}
