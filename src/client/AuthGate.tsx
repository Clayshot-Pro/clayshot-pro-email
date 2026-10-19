import { AdminPanel } from "./components/AdminPanel";
import { startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AccountSignIn } from "./AccountSignIn";
import { unlockOwnerPasskey } from "./adminPasskey";
import { instanceIconUrl, useInstance } from "./instance";
import { PoweredBy } from "./components/PoweredBy";
import { AdminViewProvider, adminPanelRequested, type AdminView } from "./adminView";
import { CloudflareTokenHelp, ConnectReportView } from "./components/CloudflareSetup";
import type { ConnectReport } from "./cloudflareToken";

type AuthStatus = { configured: boolean; authenticated: boolean; setupAvailable: boolean; setupTokenEnabled?: boolean; adminPasswordConfigured:boolean };
type SetupResult = { grant: string; generatedKey: string | null; domain: string | null; domainReport: ConnectReport | null };
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
  const [useSetupToken, setUseSetupToken] = useState(false);
  const [cloudflareToken, setCloudflareToken] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [mailDomain, setMailDomain] = useState("");
  const [setupResult, setSetupResult] = useState<SetupResult | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [adminPanel, setAdminPanel] = useState(() => adminPanelRequested(window.location.hash));
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
  // First-run setup, step 1: domain, administrator password and the
  // Cloudflare token (or the optional setup secret) in one request.
  async function submitSetup() {
    if (needsInstanceSetup && !mailDomain.trim()) { setError("Enter your mail domain first."); return; }
    if (!adminPassword) { setError("Choose an administrator password."); return; }
    if (useSetupToken ? !setupToken.trim() : !cloudflareToken.trim()) {
      setError(useSetupToken ? "Enter the setup secret." : "Paste your Cloudflare API token."); return;
    }
    setBusy(true); setError("");
    try {
      const result = await apiJson<SetupResult>("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          domain: mailDomain.trim(), adminPassword,
          ...(useSetupToken ? { setupToken: setupToken.trim() } : { cloudflareToken: cloudflareToken.trim() }),
        }),
      });
      setSetupResult(result);
      setCloudflareToken(""); setSetupToken(""); setAdminPassword("");
      instance.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Setup failed"); }
    finally { setBusy(false); }
  }

  // Step 2, on its own tap (browsers require one for passkeys): register the
  // owner passkey with the grant from step 1. This signs the administrator in.
  async function createPasskey() {
    if (!setupResult) return;
    setBusy(true); setError("");
    try {
      const registration = await apiJson<Registration>("/api/auth/register/options", {
        method:"POST",body:JSON.stringify({setupToken: setupResult.grant}),
      });
      const response = await startRegistration({optionsJSON:registration.options});
      await apiJson<{ok:boolean}>("/api/auth/register/verify", {
        method:"POST",body:JSON.stringify({challengeId:registration.challengeId,response,setupToken: setupResult.grant}),
      });
      setSetupResult(null);
      await refresh();
    } catch(cause) { setError(cause instanceof Error ? cause.message : "Passkey registration failed"); }
    finally { setBusy(false); }
  }

  async function copyKey() {
    if (!setupResult?.generatedKey) return;
    try { await navigator.clipboard.writeText(setupResult.generatedKey); setKeyCopied(true); }
    catch { setKeyCopied(false); }
  }

  const needsInstanceSetup = instance.loaded && instance.initialized === false;
  // A fresh install has no mailboxes to sign in to yet: show only setup.
  const firstRun = Boolean(needsInstanceSetup && owner && !owner.configured && owner.setupAvailable);

  if (device?.isAdmin) {
    // Admins land in the mail app (admin@ first) and switch to the panel and
    // back; the panel opens first while no administrator password is set.
    const view: AdminView = {
      isAdmin: true,
      openAdmin: () => { window.history.replaceState(null, "", "#admin"); setAdminPanel(true); },
      openMail: () => { window.history.replaceState(null, "", window.location.pathname + window.location.search); setAdminPanel(false); },
    };
    const panel = adminPanel || owner?.adminPasswordConfigured === false;
    return <AdminViewProvider value={view}>{panel ? <AdminPanel /> : children}</AdminViewProvider>;
  }
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
      <p className="auth-intro">{firstRun ? "Set up your mail app. This takes a minute." : "Welcome back. Sign in to access your inbox on this device."}</p>
      {!device || !owner ? <div className="auth-state" role="status">Checking saved sessions…</div> : <>
        {!firstRun && <AccountSignIn onSignedIn={() => void refresh()} showGoogle={instance.features.gmail} />}
        {!firstRun && !owner.adminPasswordConfigured && <div className="account-signin-divider"><span>Administrator setup</span></div>}
        {owner.configured && !owner.adminPasswordConfigured ? (
          <button className="auth-secondary" disabled={busy} type="button" onClick={() => void adminLogin()}>
            {busy ? "Verifying…" : "Set up admin password using passkey"}
          </button>
        ) : !owner.configured && owner.setupAvailable && setupResult ? (
          <div className="auth-setup setup-done">
            <p className="auth-intro">
              Setup is saved{setupResult.domain ? <> for <strong>{setupResult.domain}</strong></> : null}. Last step: create the
              administrator passkey on this device. Afterwards, sign in as <strong>admin@{setupResult.domain ?? "your domain"}</strong> with
              your password and this passkey.
            </p>
            {setupResult.generatedKey && <div className="setup-key">
              <label htmlFor="setup-key">Your encryption key</label>
              <input id="setup-key" readOnly value={setupResult.generatedKey} onFocus={event => event.currentTarget.select()} />
              <button className="auth-secondary" type="button" onClick={() => void copyKey()}>{keyCopied ? "Copied" : "Copy"}</button>
              <p>Saved in Cloudflare as the <code>PROVIDER_CREDENTIAL_KEY</code> secret. Keep a copy in your password manager: it is
                shown only now, and stored keys and Gmail connections need it.</p>
            </div>}
            {setupResult.domainReport && <ConnectReportView report={setupResult.domainReport} />}
            <button className="auth-primary" type="button" disabled={busy} onClick={() => void createPasskey()}>
              {busy ? "Waiting for passkey…" : "Create administrator passkey"}
            </button>
          </div>
        ) : !owner.configured && owner.setupAvailable ? (
          <div className="auth-setup">
            {needsInstanceSetup && <>
              <label htmlFor="setup-domain">Mail domain</label>
              <input id="setup-domain" type="text" inputMode="url" value={mailDomain} autoComplete="off" autoCapitalize="none"
                spellCheck={false} placeholder="example.com" onChange={event=>setMailDomain(event.target.value)} />
              <p className="auth-intro">Creates your admin@ mailbox on this domain; it is also your administrator sign-in. You can add more domains and mailboxes later.</p>
            </>}
            <label htmlFor="setup-password">Administrator password</label>
            <input id="setup-password" type="password" value={adminPassword} autoComplete="new-password" maxLength={32}
              onChange={event=>setAdminPassword(event.target.value)} />
            {useSetupToken ? <>
              <label htmlFor="setup-token">Setup secret</label>
              <input id="setup-token" type="password" value={setupToken} autoComplete="off"
                onChange={event=>setSetupToken(event.target.value)} />
            </> : <>
              <label htmlFor="setup-cloudflare">Cloudflare API token</label>
              <input id="setup-cloudflare" type="password" value={cloudflareToken} autoComplete="off" spellCheck={false}
                onChange={event=>setCloudflareToken(event.target.value)} />
              <CloudflareTokenHelp />
              <p className="auth-intro">The app checks the token belongs to this app's Cloudflare account, creates its encryption key,
                and sets up mail routing and sending for your domain. The token is stored encrypted; remove it any time in Admin → Keys.</p>
            </>}
            {owner.setupTokenEnabled && <button className="auth-link" type="button" onClick={() => { setUseSetupToken(value => !value); setError(""); }}>
              {useSetupToken ? "Use a Cloudflare token instead" : "Use the setup secret instead"}
            </button>}
            <button className="auth-primary" type="button" disabled={busy} onClick={() => void submitSetup()}>
              {busy ? "Setting up…" : "Continue"}
            </button>
          </div>
        ) : null}
      </>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <PoweredBy />
    </section>
  </main>;
}
