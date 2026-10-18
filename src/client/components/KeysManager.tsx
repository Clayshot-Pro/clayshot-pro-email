import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { EditableKey, KeySource } from "../../worker/storedKeys";
import { adminActionFetch } from "../adminActions";

type KeyStatus = { name: string; source: KeySource; hint: string };
type KeysResponse = { encryption: boolean; keys: KeyStatus[]; push: KeyStatus; error?: string };

const LABELS: Record<EditableKey, { label: string; help: string; placeholder: string }> = {
  GOOGLE_CLIENT_ID: { label: "Google OAuth client ID", help: "For connecting Gmail accounts.", placeholder: "….apps.googleusercontent.com" },
  GOOGLE_CLIENT_SECRET: { label: "Google OAuth client secret", help: "For connecting Gmail accounts.", placeholder: "GOCSPX-…" },
  RESEND_API_KEY: { label: "Resend API key", help: "Only for domains that send through Resend.", placeholder: "re_…" },
  RESEND_WEBHOOK_SECRET: { label: "Resend webhook signing secret", help: "Delivery, bounce and complaint updates from Resend.", placeholder: "whsec_…" },
  CF_EMAIL_SENDING_TOKEN: { label: "Cloudflare Email Sending API token", help: "Optional. Sending uses the EMAIL binding without it.", placeholder: "API token" },
};

const SOURCE: Record<KeySource, string> = {
  worker: "Set as a Worker secret",
  stored: "Stored in the database",
  none: "Not set",
};

/** Integration keys stored encrypted in D1. Values are write-only. */
export function KeysManager() {
  const [data, setData] = useState<KeysResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/keys", { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as KeysResponse;
    if (!response.ok || !body.keys) throw new Error(body.error || "Could not load keys");
    setData(body);
  }, []);
  useEffect(() => { load().catch(error => setNotice(error instanceof Error ? error.message : "Could not load")); }, [load]);

  async function mutate(name: string, method: "PUT" | "DELETE", success: string) {
    setBusy(true); setNotice(null);
    try {
      const body = method === "PUT" ? JSON.stringify({ value: (drafts[name] ?? "").trim() }) : undefined;
      const response = await adminActionFetch(`/api/admin/keys/${name}`, method, body);
      const result = await response.json().catch(() => ({})) as KeysResponse;
      if (!response.ok || !result.keys) throw new Error(result.error || "Could not update the key");
      setData(result);
      setDrafts(current => ({ ...current, [name]: "" }));
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update the key");
    } finally { setBusy(false); }
  }

  function save(event: FormEvent<HTMLFormElement>, name: EditableKey) {
    event.preventDefault();
    void mutate(name, "PUT", `${LABELS[name].label} saved.`);
  }

  return (
    <section className="settings-section admin-domain-panel" id="admin-keys" aria-label="Integration keys">
      <div className="admin-section-heading">
        <div>
          <p className="admin-section-kicker">Integrations</p>
          <h2>Keys</h2>
          <p>Stored encrypted in the database. Saved values are never shown again; replace a key to change it. Changes can take up to a minute to reach every server.</p>
        </div>
      </div>
      {!data ? <p className="admin-inline-state" role="status">{notice ?? "Loading keys…"}</p> : (
        <>
          {!data.encryption && (
            <p className="admin-inline-state" role="alert">
              Add a <code>PROVIDER_CREDENTIAL_KEY</code> Worker secret to store keys here. Keep a copy of it: changing it makes stored keys unreadable.
            </p>
          )}
          <ul className="admin-dns-report">
            {data.keys.filter(key => key.name in LABELS).map(key => {
              const name = key.name as EditableKey;
              const meta = LABELS[name];
              const editable = data.encryption && key.source !== "worker";
              return (
                <li key={name}>
                  <strong>{meta.label}</strong>
                  <small>{SOURCE[key.source]}{key.hint ? ` · ${key.hint}` : ""} · {meta.help}</small>
                  {key.source === "worker" && <small>Delete it under Worker → Settings → Variables &amp; Secrets to manage it here; its value is kept.</small>}
                  {editable && (
                    <form className="admin-domain-add" onSubmit={event => save(event, name)}>
                      <label>
                        {key.source === "stored" ? "Replace" : "Set"}
                        <input type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={512}
                          className="mailbox-entry-input" placeholder={meta.placeholder} value={drafts[name] ?? ""}
                          onChange={event => setDrafts(current => ({ ...current, [name]: event.target.value }))} />
                      </label>
                      <div className="admin-domain-actions">
                        <button type="submit" className="auth-secondary" disabled={busy || !(drafts[name] ?? "").trim()}>Save</button>
                        {key.source === "stored" && (
                          <button type="button" className="auth-secondary" disabled={busy}
                            onClick={() => window.confirm(`Remove the ${meta.label}?`) && void mutate(name, "DELETE", `${meta.label} removed.`)}>
                            Remove
                          </button>
                        )}
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
            <li>
              <strong>Push notification keys</strong>
              <small>
                {data.push.source === "none"
                  ? "Created automatically once encryption is available."
                  : `${data.push.source === "worker" ? SOURCE.worker : "Created and stored automatically"} · ${data.push.hint}`}
              </small>
            </li>
          </ul>
          {notice && <p className="admin-inline-state" role="status">{notice}</p>}
        </>
      )}
    </section>
  );
}
