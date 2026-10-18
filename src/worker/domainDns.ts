/**
 * Pure evaluation of a domain's mail DNS records. Lookups happen in
 * domains.ts over DNS-over-HTTPS; this module only judges the answers so it
 * can be unit tested.
 */
export type OutboundTransportKind = "cloudflare" | "resend" | "none";

export type DnsAnswers = {
  mx: string[];
  rootTxt: string[];
  dmarcTxt: string[];
  /** TXT answers for candidate DKIM selectors, keyed by selector. */
  dkim: Record<string, string[]>;
  /** Resend publishes SPF/MX for bounces on the "send" subdomain. */
  sendSubdomainTxt: string[];
  sendSubdomainMx: string[];
};

export type DnsCheck = { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string };
export type DnsReport = { checkedAt: string; checks: DnsCheck[]; canActivate: boolean };

export const CLOUDFLARE_DKIM_SELECTORS = ["cf2024-1"];
export const RESEND_DKIM_SELECTORS = ["resend"];

const unquote = (value: string) => value.replace(/"\s*"/g, "").replace(/^"|"$/g, "").trim();
const mxHost = (value: string) => value.trim().split(/\s+/).pop()?.replace(/\.$/, "").toLowerCase() ?? "";

export function evaluateDns(answers: DnsAnswers, transport: OutboundTransportKind, now = new Date()): DnsReport {
  const checks: DnsCheck[] = [];
  const mxHosts = answers.mx.map(mxHost).filter(Boolean);
  const cloudflareMx = mxHosts.filter(host => host.endsWith(".mx.cloudflare.net"));
  checks.push(cloudflareMx.length
    ? { id: "mx", label: "MX records point to Cloudflare Email Routing", status: "pass", detail: cloudflareMx.join(", ") }
    : { id: "mx", label: "MX records point to Cloudflare Email Routing", status: "fail",
      detail: mxHosts.length ? `Found ${mxHosts.join(", ")}` : "No MX records found. Enable Email Routing for the zone." });
  if (cloudflareMx.length && cloudflareMx.length !== mxHosts.length) {
    checks.push({ id: "mx-extra", label: "No competing MX hosts", status: "warn",
      detail: `Other MX hosts also receive mail: ${mxHosts.filter(host => !host.endsWith(".mx.cloudflare.net")).join(", ")}` });
  }

  const spf = answers.rootTxt.map(unquote).filter(value => /^v=spf1\b/i.test(value));
  if (spf.length !== 1) {
    checks.push({ id: "spf", label: "SPF record", status: transport === "none" ? "warn" : "fail",
      detail: spf.length ? "More than one SPF record; receivers will reject it." : "No SPF record found." });
  } else if (transport === "cloudflare" && !/include:_spf\.mx\.cloudflare\.net/i.test(spf[0])) {
    checks.push({ id: "spf", label: "SPF includes Cloudflare", status: "warn", detail: spf[0] });
  } else {
    checks.push({ id: "spf", label: "SPF record", status: "pass", detail: spf[0] });
  }

  if (transport === "resend") {
    const sendSpf = answers.sendSubdomainTxt.map(unquote).some(value => /^v=spf1\b.*include:amazonses\.com/i.test(value));
    checks.push({ id: "resend-spf", label: "Resend SPF on the send subdomain", status: sendSpf ? "pass" : "fail",
      detail: sendSpf ? "send subdomain authorizes Resend" : "Add the TXT record Resend shows for the send subdomain." });
    const sendMx = answers.sendSubdomainMx.map(mxHost).some(host => host.includes("amazonses.com"));
    checks.push({ id: "resend-mx", label: "Resend bounce MX on the send subdomain", status: sendMx ? "pass" : "warn",
      detail: sendMx ? "Bounce handling configured" : "Add the MX record Resend shows for the send subdomain." });
  }

  if (transport !== "none") {
    const selectors = transport === "resend" ? RESEND_DKIM_SELECTORS : CLOUDFLARE_DKIM_SELECTORS;
    const found = selectors.filter(selector =>
      (answers.dkim[selector] ?? []).map(unquote).some(value => /\bp=[A-Za-z0-9+/=]{20,}/.test(value)));
    checks.push(found.length
      ? { id: "dkim", label: "DKIM key published", status: "pass", detail: `${found.join(", ")}._domainkey` }
      : { id: "dkim", label: "DKIM key published", status: "warn",
        detail: `No key at ${selectors.map(selector => `${selector}._domainkey`).join(" or ")}. Follow the provider's domain setup.` });
  }

  const dmarc = answers.dmarcTxt.map(unquote).find(value => /^v=DMARC1\b/i.test(value));
  checks.push(dmarc
    ? { id: "dmarc", label: "DMARC policy", status: "pass", detail: dmarc }
    : { id: "dmarc", label: "DMARC policy", status: "warn", detail: "No _dmarc record. Recommended, not required." });

  return { checkedAt: now.toISOString(), checks, canActivate: checks.every(check => check.id !== "mx" || check.status === "pass") };
}
