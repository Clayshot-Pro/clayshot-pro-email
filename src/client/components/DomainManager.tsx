import "../admin-domains.css";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { adminActionFetch } from "../adminActions";
import { THEMES, type ThemeId } from "../../worker/customization";
import { THEME_LABELS } from "./AppearanceSettings";
import { ConnectReportView } from "./CloudflareSetup";
import type { ConnectReport } from "../cloudflareToken";

export type DnsCheck = { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string };
export type Transport = "cloudflare" | "resend" | "none";
export type Domain = {
  domain: string;
  status: "pending" | "active" | "disabled";
  isPrimary: boolean;
  outboundTransport: Transport;
  postmasterMailboxId: string | null;
  theme: ThemeId | null;
  dnsCheckedAt: string | null;
  dnsReport: { checkedAt: string; checks: DnsCheck[]; canActivate: boolean } | null;
  mailboxCount: number;
};
type DomainsPayload = {
  domains: Domain[];
  transports: { cloudflare: { available: boolean; mode: "api" | "binding" | null }; resend: { available: boolean; webhookConfigured: boolean } };
  webhookUrl: string;
  cloudflareConnected?: boolean;
};
type MailboxOption = { id: string; email_address: string; status: string; deleted_at: string | null };

const TRANSPORT_LABEL: Record<Transport, string> = { cloudflare: "Cloudflare", resend: "Resend", none: "Receive only" };

async function call(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const response = method === "GET" ? await fetch(path, { cache: "no-store" }) : await adminActionFetch(path, method, payload);
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Domain operation failed");
  return result;
}

const domainPath = (domain: string) => `/api/admin/domains/${encodeURIComponent(domain)}`;

export function DomainManager({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<DomainsPayload | null>(null);
  const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, ConnectReport>>({});

  const load = useCallback(async () => {
    try {
      const [domains, boxes] = await Promise.all([call("/api/admin/domains", "GET"), call("/api/mailboxes", "GET")]);
      setData(domains as unknown as DomainsPayload);
      setMailboxes((boxes.mailboxes as MailboxOption[]).filter(box => box.status === "active" && !box.deleted_at));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load domains");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(key: string, action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(key); setNotice(null);
    try {
      await action();
      await load();
      onChanged?.();
      setNotice(success || null);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Domain operation failed");
      return false;
    } finally { setBusy(null); }
  }

  const connected = Boolean(data?.cloudflareConnected);
  const keepReport = (result: Record<string, unknown>) => {
    const report = result.report as ConnectReport | undefined;
    if (report) setReports(current => ({ ...current, [report.domain]: report }));
    return report;
  };
  const outcome = (report: ConnectReport | undefined, domain: string) => !report ? `${domain} added.`
    : report.mxConflict ? `${domain} still receives mail elsewhere. Review the MX records below.`
    : report.catchAllConflict ? `The catch-all for ${domain} delivers somewhere else. Review it below.`
    : report.steps.some(step => step.status === "failed") ? `${domain} is partly set up. See the steps below.`
    : report.routingReady ? `${domain} is set up and active.` : `${domain} is set up. Run a DNS check in a few minutes.`;

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const domain = newDomain.trim().toLowerCase();
    let report: ConnectReport | undefined;
    const ok = await run("new", async () => {
      report = keepReport(await call("/api/admin/domains", "POST", { domain, connect: connected }));
      setNewDomain("");
      setOpen(domain);
    }, connected ? "" : `${domain} added as pending. Complete the checklist, run a DNS check, then activate it.`);
    if (ok && connected) setNotice(outcome(report, domain));
  }

  async function connect(domain: Domain, replace: { replaceMx?: boolean; replaceCatchAll?: boolean } = {}) {
    if (replace.replaceMx && !window.confirm(`Delete the MX records that send ${domain.domain} mail to another service? Mail will come here instead.`)) return;
    if (replace.replaceCatchAll && !window.confirm(`Replace the catch-all that sends unmatched mail to ${reports[domain.domain]?.catchAllConflict ?? "another destination"}? Unmatched mail will come here instead.`)) return;
    let report: ConnectReport | undefined;
    const ok = await run(domain.domain, async () => {
      report = keepReport(await call(`${domainPath(domain.domain)}/connect`, "POST", replace));
    }, "");
    if (ok) setNotice(outcome(report, domain.domain));
  }

  const checkDns = (domain: Domain) =>
    run(domain.domain, () => call(`${domainPath(domain.domain)}/dns`, "GET"), `DNS checked for ${domain.domain}.`);
  const update = (domain: Domain, change: Record<string, unknown>, success: string) =>
    run(domain.domain, () => call(domainPath(domain.domain), "PATCH", change), success);
  async function remove(domain: Domain) {
    if (!window.confirm(`Remove ${domain.domain}? Mail to this domain will be rejected.`)) return;
    await run(domain.domain, () => call(domainPath(domain.domain), "DELETE"), `${domain.domain} removed.`);
  }
  function changeTransport(domain: Domain, transport: Transport) {
    if (transport === "resend" && !window.confirm(
      `Send ${domain.domain} mail through Resend? Message content for this domain will pass through Resend as a third-party processor.`)) return;
    void update(domain, { outboundTransport: transport }, `${domain.domain} now sends via ${TRANSPORT_LABEL[transport]}.`);
  }

  return (
    <section className="settings-section admin-domain-panel" id="admin-domains" aria-label="Mail domains">
      <div className="admin-section-heading">
        <div>
          <p className="admin-section-kicker">Domains</p>
          <h2>Mail domains</h2>
          <p>{connected
            ? "Adding a domain sets it up in Cloudflare with your connected token: Email Routing, delivery to this app, Email Sending and DMARC."
            : "Each domain needs Cloudflare Email Routing with its catch-all rule sent to this Worker. Connect a Cloudflare token in Admin → Keys to do this automatically."}</p>
        </div>
        <span className="admin-mailbox-count">{data ? `${data.domains.length} total` : "Loading…"}</span>
      </div>

      <form className="admin-domain-add" onSubmit={event => void add(event)}>
        <label htmlFor="new-domain">
          Add a domain
          <input id="new-domain" value={newDomain} onChange={event => setNewDomain(event.target.value)}
            placeholder="example.org" autoCapitalize="none" spellCheck={false} maxLength={253} required className="mailbox-entry-input" />
        </label>
        <button type="submit" className="settings-primary" disabled={busy !== null}>{busy === "new" ? "Adding…" : "Add domain"}</button>
      </form>

      {notice && <p className="admin-inline-state" role="status">{notice}</p>}

      <ul className="admin-domain-list">
        {data && data.domains.map(domain => (
          <li key={domain.domain} className={`admin-domain-row domain-${domain.status}`}>
            <div className="admin-domain-summary">
              <div>
                <strong>{domain.domain}</strong>
                <span className={`admin-domain-chip chip-${domain.status}`}>{domain.isPrimary ? "main" : domain.status}</span>
              </div>
              <small>
                {domain.mailboxCount} mailbox{domain.mailboxCount === 1 ? "" : "es"} · sends via {TRANSPORT_LABEL[domain.outboundTransport]}
                {domain.dnsCheckedAt ? ` · DNS checked ${new Date(domain.dnsCheckedAt).toLocaleString()}` : " · DNS not checked"}
              </small>
              <button type="button" className="auth-secondary" onClick={() => setOpen(open === domain.domain ? null : domain.domain)}>
                {open === domain.domain ? "Close" : "Manage"}
              </button>
            </div>

            {open === domain.domain && (
              <div className="admin-domain-details">
                {reports[domain.domain] && <ConnectReportView report={reports[domain.domain]} />}
                {reports[domain.domain]?.mxConflict && (
                  <button type="button" className="auth-secondary danger" disabled={busy !== null} onClick={() => void connect(domain, { replaceMx: true })}>
                    Replace the MX records and connect
                  </button>
                )}
                {reports[domain.domain]?.catchAllConflict && (
                  <button type="button" className="auth-secondary danger" disabled={busy !== null} onClick={() => void connect(domain, { replaceCatchAll: true })}>
                    Replace the catch-all and connect
                  </button>
                )}
                {domain.status === "pending" && !connected && (
                  <ol className="admin-domain-checklist">
                    <li>Add {domain.domain} as a zone on Cloudflare DNS in the same account.</li>
                    <li>Enable Email Routing for the zone (Cloudflare adds the MX records).</li>
                    <li>Routing rules → Catch-all → <em>Send to a Worker</em> → this Worker.</li>
                    <li>Publish SPF and DKIM for the sending provider, and a DMARC record.</li>
                    <li>Run a DNS check, then activate the domain.</li>
                  </ol>
                )}

                {domain.dnsReport && (
                  <ul className="admin-dns-report" aria-label={`DNS report for ${domain.domain}`}>
                    {domain.dnsReport.checks.map(check => (
                      <li key={check.id} className={`dns-${check.status}`}>
                        <strong>{check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✕"} {check.label}</strong>
                        <small>{check.detail}</small>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="admin-domain-actions">
                  {connected && (
                    <button type="button" className="settings-primary" disabled={busy !== null} onClick={() => void connect(domain)}>
                      {busy === domain.domain ? "Working…" : domain.status === "pending" ? "Set up in Cloudflare" : "Re-check Cloudflare setup"}
                    </button>
                  )}
                  <button type="button" className="auth-secondary" disabled={busy !== null} onClick={() => void checkDns(domain)}>
                    {busy === domain.domain ? "Working…" : "Check DNS"}
                  </button>
                  {domain.status !== "active" && (
                    <button type="button" className="settings-primary" disabled={busy !== null || !domain.dnsReport?.canActivate}
                      onClick={() => void update(domain, { status: "active" }, `${domain.domain} is active.`)}>
                      Activate
                    </button>
                  )}
                  {domain.status === "active" && !domain.isPrimary && (
                    <button type="button" className="auth-secondary" disabled={busy !== null}
                      onClick={() => void update(domain, { status: "disabled" }, `${domain.domain} disabled. Its mailboxes are kept.`)}>
                      Disable
                    </button>
                  )}
                  {!domain.isPrimary && domain.mailboxCount === 0 && (
                    <button type="button" className="auth-secondary danger" disabled={busy !== null} onClick={() => void remove(domain)}>
                      Remove
                    </button>
                  )}
                </div>

                <div className="admin-domain-fields">
                  <label>
                    Outbound sending
                    <select value={domain.outboundTransport} disabled={busy !== null}
                      onChange={event => changeTransport(domain, event.target.value as Transport)}>
                      <option value="cloudflare">Cloudflare Email Sending (default)</option>
                      <option value="resend" disabled={!data.transports.resend.available}>
                        Resend{data.transports.resend.available ? "" : " — set RESEND_API_KEY first"}
                      </option>
                      <option value="none">Receive only</option>
                    </select>
                  </label>
                  <label>
                    Theme for this domain's mailboxes
                    <select value={domain.theme ?? ""} disabled={busy !== null}
                      onChange={event => void update(domain, { theme: event.target.value || null }, "Domain theme saved. It applies when one of its mailboxes is open.")}>
                      <option value="">Instance default</option>
                      {THEMES.map(theme => <option key={theme} value={theme}>{THEME_LABELS[theme]}</option>)}
                    </select>
                  </label>
                  <label>
                    Postmaster and abuse mail
                    <select value={domain.postmasterMailboxId ?? ""} disabled={busy !== null}
                      onChange={event => void update(domain, { postmasterMailboxId: event.target.value || null }, "Postmaster mailbox updated.")}>
                      <option value="">Admin mailbox (default)</option>
                      {mailboxes.map(box => <option key={box.id} value={box.id}>{box.email_address}</option>)}
                    </select>
                  </label>
                </div>

                {domain.outboundTransport === "cloudflare" && (
                  <p className="admin-domain-note">
                    {data.transports.cloudflare.available
                      ? `Every active mailbox on this domain can send once the domain is onboarded for Cloudflare Email Sending (via the ${
                        data.transports.cloudflare.mode === "api" ? "Email Sending API" : "Worker's send binding, no token needed"}).`
                      : "Cloudflare Email Sending is unavailable: the Worker's EMAIL send binding is missing."}
                  </p>
                )}
                {domain.outboundTransport === "resend" && (
                  <div className="admin-domain-note">
                    <p>Message content for this domain passes through Resend. Verify the domain in Resend, then add this webhook
                      for delivery and bounce events:</p>
                    <code>{data.webhookUrl}</code>
                    {!data.transports.resend.webhookConfigured && <p>RESEND_WEBHOOK_SECRET is not set; webhook events will be rejected.</p>}
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
