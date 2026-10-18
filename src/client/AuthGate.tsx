import { AdminPanel } from "./components/AdminPanel";
import { startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AccountSignIn } from "./AccountSignIn";
import { unlockOwnerPasskey } from "./adminPasskey";
import { instanceIconUrl, useInstance } from "./instance";
import { PoweredBy } from "./components/PoweredBy";

type AuthStatus = { configured: boolean; authenticated: boolean; setupAvailable: boolean; adminPasswordConfigured:boolean };
type DeviceStatus = { authenticated: boolean; isAdmin: boolean; accountCount: number };
type Registration = { challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] };
async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init, cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(data.error || "Authentication failed");
  return data;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [device, setDevice] = useState<DeviceStatus | null>(null);
  const [owner, setOwner] = useState<AuthStatus | null>(null);
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const instance = useInstance();

  const refresh = useCallback(async () => {
    try {
      const [deviceStatus, ownerStatus] = await Promise.all([
        apiJson<DeviceStatus>("/api/device/status"),
        apiJson<AuthStatus>("/api/auth/status"),
      ]);
      setDevice(deviceStatus);
      setOwner(ownerStatus);
      const oauthError = new URLSearchParams(window.location.search).get("gmail");
      if (oauthError && oauthError !== "connected") setError(`Google sign-in was not completed: ${oauthError.replace(/_/g, " ")}`);
      else setError("");
      if (oauthError) {
        const next = new URL(window.location.href);
        next.searchParams.delete("gmail");
        window.history.replaceState(null, "", next.toString());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not check device sign-in");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function adminLogin() {
    setBusy(true); setError("");
    try { await unlockOwnerPasskey(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Administrator sign-in failed"); }
    finally { setBusy(false); }
  }
  async function initialSetup() {
    if (!setupToken.trim()) { setError("Enter the original setup secret first."); return; }
    setBusy(true); setError("");
    try {
      const registration = await apiJson<Registration>("/api/auth/register/options", {
        method:"POST",body:JSON.stringify({setupToken}),
      });
      const response = await startRegistration({optionsJSON:registration.options});
      await apiJson<{ok:boolean}>("/api/auth/register/verify", {
        method:"POST",body:JSON.stringify({challengeId:registration.challengeId,response,setupToken}),
      });
      setSetupToken("");
      await refresh();
    } catch(cause) { setError(cause instanceof Error ? cause.message : "Setup failed"); }
    finally { setBusy(false); }
  }

  if (device?.isAdmin) return <AdminPanel />;
  if (device?.authenticated && device.accountCount > 0) return <>{children}</>;
  return <main className="auth-shell">
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-brand-row">
        <img className="auth-logo" src={instanceIconUrl(instance, 180)} alt="" width="64" height="64" />
        <div className="auth-heading">
          <p className="auth-eyebrow">Private email</p>
          <h1 id="auth-title">{instance.brandName}</h1>
        </div>
      </div>
      <p className="auth-intro">Welcome back. Sign in to access your inbox on this device.</p>
      {!device || !owner ? <div className="auth-state" role="status">Checking saved sessions…</div> : <>
        <AccountSignIn onSignedIn={() => void refresh()} showGoogle={instance.features.gmail} />
        {!owner.adminPasswordConfigured && <div className="account-signin-divider"><span>Administrator setup</span></div>}
        {owner.configured && !owner.adminPasswordConfigured ? (
          <button className="auth-secondary" disabled={busy} type="button" onClick={() => void adminLogin()}>
            {busy ? "Verifying…" : "Set up admin password using passkey"}
          </button>
        ) : !owner.configured && owner.setupAvailable ? (
          <div className="auth-setup">
            <label htmlFor="setup-token">One-time administrator setup secret</label>
            <input id="setup-token" type="password" value={setupToken} autoComplete="off"
              onChange={event=>setSetupToken(event.target.value)} />
            <button className="auth-primary" type="button" disabled={busy} onClick={() => void initialSetup()}>
              Create administrator passkey
            </button>
          </div>
        ) : null}
      </>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <PoweredBy />
    </section>
  </main>;
}
