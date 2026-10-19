import { useState, type FormEvent } from "react";
import { unlockOwnerPasskey } from "./adminPasskey";
import { useInstance } from "./instance";
import { isAdminLoginEmail } from "./adminIdentity";

const DOMAIN_KEY = "ltm.signin.domain";

function rememberedDomain(): string | null {
  try { return localStorage.getItem(DOMAIN_KEY); } catch { return null; }
}

function rememberDomain(domain: string): void {
  try { localStorage.setItem(DOMAIN_KEY, domain); } catch { /* private mode: nothing to keep */ }
}

export function AccountSignIn({ onSignedIn, showGoogle = true }: { onSignedIn: () => void; showGoogle?: boolean }) {
  const [name, setName] = useState("");
  const [chosenDomain, setChosenDomain] = useState(rememberedDomain);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<"google" | "custom" | null>(null);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const { primaryDomain, domains: instanceDomains } = useInstance();
  // Type the name and pick the domain; a full address (typed, pasted or
  // filled in by a password manager) is used as it is.
  const domains = instanceDomains?.length ? instanceDomains : primaryDomain ? [primaryDomain] : [];
  const domain = chosenDomain && domains.includes(chosenDomain) ? chosenDomain : domains[0] ?? "";
  const typed = name.trim();
  const fullAddress = typed.includes("@") || !domain;
  const email = fullAddress ? typed : `${typed}@${domain}`;
  // Client routing only: any admin@ address goes to the administrator
  // password + passkey flow. The Worker authenticates the exact identity.
  const isAdmin = isAdminLoginEmail(email);

  async function addGoogle() {
    setPending("google"); setError("");
    try {
      const response = await fetch("/api/accounts/gmail/connect", { method: "POST" });
      const result = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok || !result.authorizationUrl) throw new Error(result.error || "Google sign-in unavailable");
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Google sign-in unavailable");
      setPending(null);
    }
  }

  async function addCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("custom"); setError("");
    try {
      const response = await fetch(isAdmin ? "/api/admin/login/password" : "/api/device/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const result = await response.json() as {error?:string;passkeyRequired?:boolean};
      if (!response.ok) throw new Error(result.error || "Email sign-in failed");
      setPassword("");
      if (!fullAddress) rememberDomain(domain);
      if (result.passkeyRequired) {
        // A separate, server-bound passkey challenge completes the second factor.
        await unlockOwnerPasskey();
      }
      onSignedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Custom mailbox sign-in failed");
    } finally { setPending(null); }
  }

  return <div className="account-signin">
    {showGoogle ? (
      <button
        className="signin-google-button"
        type="button"
        disabled={pending !== null}
        onClick={() => void addGoogle()}
      >
        <span className="signin-google-mark" aria-hidden="true">G</span>
        <span>{pending === "google" ? "Connecting to Google…" : "Continue with Google"}</span>
      </button>
    ) : null}
    {showGoogle ? <div className="account-signin-divider"><span>or use a custom mailbox</span></div> : null}
    <form className="auth-setup signin-email-form" onSubmit={(event) => void addCustom(event)}>
      <div className="signin-form-heading">
        <h2>{showGoogle ? "Email and password" : "Custom email account"}</h2>
        <p>Enter the credentials for your mailbox.</p>
      </div>
      <div className="signin-field">
        <label htmlFor="device-email">{domain ? "Username" : "Email address"}</label>
        <div className="signin-address-field">
          <input
            id="device-email"
            type="text"
            inputMode="email"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={domain ? "name" : "name@example.com"}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={254}
          />
          {fullAddress ? null : domains.length > 1 ? (
            <select
              className="signin-domain"
              aria-label="Domain"
              value={domain}
              onChange={(event) => setChosenDomain(event.target.value)}
            >
              {domains.map((option) => <option key={option} value={option}>@{option}</option>)}
            </select>
          ) : <span className="signin-domain signin-domain-fixed">@{domain}</span>}
        </div>
      </div>
      <div className="signin-field">
        <label htmlFor="device-password">Password</label>
        <div className="signin-password-field">
          <input
            id="device-password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            minLength={1}
            maxLength={128}
            required
          />
          <button
            type="button"
            className="signin-show-password"
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((current) => !current)}
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isAdmin ? <p className="signin-admin-note">Confirm with your registered passkey to finish signing in.</p> : null}
      <button className="auth-primary signin-submit" type="submit" disabled={pending !== null}>
        {pending === "custom" ? "Verifying…" : isAdmin ? "Sign in as administrator" : "Sign in to mailbox"}
      </button>
    </form>
    {error ? <p className="auth-error" role="alert">{error}</p> : null}
  </div>;
}
