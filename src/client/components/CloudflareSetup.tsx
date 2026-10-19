import { CLOUDFLARE_TOKEN_PERMISSIONS, CLOUDFLARE_TOKEN_URL, type ConnectReport } from "../cloudflareToken";

/** How to create the one Cloudflare API token: one link, two permissions to add by hand. */
export function CloudflareTokenHelp() {
  const manual = CLOUDFLARE_TOKEN_PERMISSIONS.filter(permission => !permission.key);
  return (
    <div className="cf-token-help">
      <a className="auth-secondary cf-token-link" href={CLOUDFLARE_TOKEN_URL} target="_blank" rel="noopener noreferrer">
        Create a Cloudflare token
      </a>
      <p>
        Use the same token as your fork's <code>CLOUDFLARE_API_TOKEN</code> secret: one token deploys the app and
        sets up your domains. To make one, open the link (it selects every other permission), add {manual.map((permission, index) => (
          <span key={permission.name}>{index ? " and " : ""}<strong>{permission.name}: {permission.access}</strong></span>
        ))}, create the token and paste it here.
      </p>
      <details>
        <summary>All permissions</summary>
        <ul>
          {CLOUDFLARE_TOKEN_PERMISSIONS.map(permission => (
            <li key={permission.name}>{permission.scope} · {permission.name}: {permission.access}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

const MARK: Record<ConnectReport["steps"][number]["status"], string> = { done: "✓", skipped: "✓", failed: "!", action: "?" };

/** What automatic domain wiring did, step by step. */
export function ConnectReportView({ report }: { report: ConnectReport }) {
  return (
    <ul className="connect-report" aria-label={`Setup of ${report.domain}`}>
      {report.steps.map(step => (
        <li key={step.id} className={`connect-step is-${step.status}`}>
          <span className="connect-step-mark" aria-hidden="true">{MARK[step.status]}</span>
          <span><strong>{step.label}</strong> {step.detail}</span>
        </li>
      ))}
    </ul>
  );
}
