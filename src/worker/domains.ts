import { appConfig, isValidDomain } from "./appConfig";
import { evaluateDns, CLOUDFLARE_DKIM_SELECTORS, RESEND_DKIM_SELECTORS, type DnsAnswers, type OutboundTransportKind } from "./domainDns";
import type { AddressRules } from "./mailboxRules";

export type RulesScope = "routing" | "create";
export type DomainStatus = "pending" | "active" | "disabled";

export type DomainRow = {
  domain: string;
  status: DomainStatus;
  is_primary: number;
  outbound_transport: OutboundTransportKind;
  postmaster_mailbox_id: string | null;
  dns_checked_at: string | null;
  dns_report: string | null;
  created_at: string;
  updated_at: string;
};

const PRIMARY_MAILBOX_ID = "native:primary";
const TRANSPORTS = new Set<OutboundTransportKind>(["cloudflare", "resend", "none"]);
const jsonError = (error: string, status: number) => Response.json({ error }, { status });

/**
 * Create the primary domain (always active) and any MAIL_DOMAINS seeds
 * (pending). Removing a seed from .env never disables a domain.
 */
export async function ensureDomains(env: Env): Promise<void> {
  const config = appConfig(env);
  await env.DB.batch([
    env.DB.prepare("UPDATE domains SET is_primary = 0 WHERE is_primary = 1 AND domain != ?1").bind(config.primaryDomain),
    env.DB.prepare(`INSERT INTO domains (domain, status, is_primary) VALUES (?1, 'active', 1)
      ON CONFLICT(domain) DO UPDATE SET status = 'active', is_primary = 1, updated_at = CURRENT_TIMESTAMP
      WHERE domains.status != 'active' OR domains.is_primary != 1`).bind(config.primaryDomain),
    ...config.mailDomains.map(domain =>
      env.DB.prepare("INSERT OR IGNORE INTO domains (domain, status) VALUES (?1, 'pending')").bind(domain)),
    env.DB.prepare(`UPDATE native_mailboxes SET domain = lower(substr(email_address, instr(email_address, '@') + 1))
      WHERE domain IS NULL OR domain != lower(substr(email_address, instr(email_address, '@') + 1))`),
  ]);
}

/** Domains addresses may use: active for routing/sign-in, active + pending for creation. */
export async function addressRules(env: Env, scope: RulesScope = "routing"): Promise<AddressRules> {
  const config = appConfig(env);
  const statuses = scope === "create" ? ["active", "pending"] : ["active"];
  const rows = await env.DB.prepare(`SELECT domain FROM domains WHERE status IN (${statuses.map(() => "?").join(",")})`)
    .bind(...statuses).all<{ domain: string }>().catch(() => ({ results: [] as { domain: string }[] }));
  const domains = new Set(rows.results.map(row => row.domain.toLowerCase()));
  domains.add(config.primaryDomain);
  return { domains, defaultDomain: config.primaryDomain, adminAddress: config.adminAddress };
}

export async function domainRow(env: Env, domain: string): Promise<DomainRow | null> {
  return env.DB.prepare("SELECT * FROM domains WHERE domain = ?1").bind(domain.toLowerCase()).first<DomainRow>();
}

/** Mailbox that receives postmaster@ / abuse@ for a domain. */
export async function postmasterMailboxId(env: Env, domain: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT d.postmaster_mailbox_id AS id FROM domains d
    JOIN native_mailboxes m ON m.id = d.postmaster_mailbox_id AND m.status = 'active' AND m.deleted_at IS NULL
    WHERE d.domain = ?1`).bind(domain.toLowerCase()).first<{ id: string }>();
  return row?.id ?? PRIMARY_MAILBOX_ID;
}

/** Outbound policy for a sender address's domain. */
export async function sendingDomain(env: Env, address: string): Promise<{ status: DomainStatus; transport: OutboundTransportKind } | null> {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  const row = await domainRow(env, domain);
  if (row) return { status: row.status, transport: row.outbound_transport };
  return domain === appConfig(env).primaryDomain ? { status: "active", transport: "cloudflare" } : null;
}

function present(row: DomainRow & { mailbox_count?: number }) {
  let report = null;
  try { report = row.dns_report ? JSON.parse(row.dns_report) : null; } catch { report = null; }
  return {
    domain: row.domain,
    status: row.status,
    isPrimary: row.is_primary === 1,
    outboundTransport: row.outbound_transport,
    postmasterMailboxId: row.postmaster_mailbox_id,
    dnsCheckedAt: row.dns_checked_at,
    dnsReport: report,
    mailboxCount: row.mailbox_count ?? 0,
    createdAt: row.created_at,
  };
}

export async function listDomainsResponse(env: Env): Promise<Response> {
  const config = appConfig(env);
  const rows = await env.DB.prepare(`SELECT d.*, (SELECT COUNT(*) FROM native_mailboxes m WHERE m.domain = d.domain) AS mailbox_count
    FROM domains d ORDER BY d.is_primary DESC, d.domain`).all<DomainRow & { mailbox_count: number }>();
  return Response.json({
    domains: rows.results.map(present),
    transports: {
      cloudflare: { available: true, multiSenderApproved: config.features.multiSender },
      resend: { available: config.features.resend, webhookConfigured: config.features.resendWebhook },
    },
    webhookUrl: `${config.origin}/api/webhooks/resend`,
  });
}

export async function createDomain(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ domain?: unknown }>().catch(() => null);
  const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!isValidDomain(domain)) return jsonError("Enter a valid ASCII or punycode domain such as example.org", 400);
  if (domain === new URL(appConfig(env).origin).hostname) return jsonError("Use the mail domain, not the web app host", 400);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM domains").first<{ n: number }>();
  if ((count?.n ?? 0) >= 50) return jsonError("Domain limit reached", 409);
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO domains (domain, status) VALUES (?1, 'pending')").bind(domain).run();
  if (!inserted.meta.changes) return jsonError("Domain already exists", 409);
  return Response.json({ domain: present((await domainRow(env, domain))!) }, { status: 201 });
}

export async function updateDomain(request: Request, env: Env, domain: string): Promise<Response> {
  const row = await domainRow(env, domain);
  if (!row) return jsonError("Domain not found", 404);
  const body = await request.json<{ status?: unknown; postmasterMailboxId?: unknown; outboundTransport?: unknown }>().catch(() => null);
  if (!body || (body.status === undefined && body.postmasterMailboxId === undefined && body.outboundTransport === undefined)) {
    return jsonError("No changes requested", 400);
  }
  let status = row.status;
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") return jsonError("Invalid status", 400);
    if (row.is_primary === 1 && body.status !== "active") return jsonError("The primary domain cannot be disabled", 403);
    if (body.status === "active" && row.status !== "active") {
      let report: { canActivate?: boolean } | null = null;
      try { report = row.dns_report ? JSON.parse(row.dns_report) : null; } catch { report = null; }
      if (!report?.canActivate) return jsonError("Run a DNS check first; MX records must point to Cloudflare Email Routing", 409);
    }
    status = body.status;
  }
  let postmaster = row.postmaster_mailbox_id;
  if (body.postmasterMailboxId !== undefined) {
    if (body.postmasterMailboxId === null) postmaster = null;
    else if (typeof body.postmasterMailboxId !== "string") return jsonError("Invalid postmaster mailbox", 400);
    else {
      const box = await env.DB.prepare("SELECT id FROM native_mailboxes WHERE id = ?1 AND status = 'active' AND deleted_at IS NULL")
        .bind(body.postmasterMailboxId).first<{ id: string }>();
      if (!box) return jsonError("Postmaster mailbox must be an active mailbox", 400);
      postmaster = box.id;
    }
  }
  let transport = row.outbound_transport;
  if (body.outboundTransport !== undefined) {
    if (typeof body.outboundTransport !== "string" || !TRANSPORTS.has(body.outboundTransport as OutboundTransportKind)) {
      return jsonError("Invalid outbound transport", 400);
    }
    transport = body.outboundTransport as OutboundTransportKind;
    if (transport === "resend" && !appConfig(env).features.resend) {
      return jsonError("Set RESEND_API_KEY and run npm run secrets:push before switching a domain to Resend", 409);
    }
  }
  await env.DB.prepare(`UPDATE domains SET status = ?2, postmaster_mailbox_id = ?3, outbound_transport = ?4,
    updated_at = CURRENT_TIMESTAMP WHERE domain = ?1`).bind(row.domain, status, postmaster, transport).run();
  return Response.json({ domain: present((await domainRow(env, row.domain))!) });
}

export async function deleteDomain(env: Env, domain: string): Promise<Response> {
  const row = await domainRow(env, domain);
  if (!row) return jsonError("Domain not found", 404);
  if (row.is_primary === 1) return jsonError("The primary domain cannot be removed", 403);
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM native_mailboxes WHERE domain = ?1").bind(row.domain).first<{ n: number }>();
  if ((used?.n ?? 0) > 0) return jsonError("Remove or purge this domain's mailboxes first", 409);
  await env.DB.prepare("DELETE FROM domains WHERE domain = ?1").bind(row.domain).run();
  return Response.json({ ok: true });
}

async function lookup(name: string, type: "MX" | "TXT"): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  const response = await fetch(url, { headers: { Accept: "application/dns-json" } }).catch(() => null);
  if (!response?.ok) return [];
  const payload = await response.json().catch(() => null) as { Answer?: { type: number; data: string }[] } | null;
  const code = type === "MX" ? 15 : 16;
  return (payload?.Answer ?? []).filter(answer => answer.type === code).map(answer => String(answer.data)).slice(0, 20);
}

/** Look up the domain's mail records and store an advisory report. */
export async function checkDomainDns(env: Env, domain: string): Promise<Response> {
  const row = await domainRow(env, domain);
  if (!row) return jsonError("Domain not found", 404);
  const selectors = [...CLOUDFLARE_DKIM_SELECTORS, ...RESEND_DKIM_SELECTORS];
  const [mx, rootTxt, dmarcTxt, sendSubdomainTxt, sendSubdomainMx, ...dkim] = await Promise.all([
    lookup(row.domain, "MX"),
    lookup(row.domain, "TXT"),
    lookup(`_dmarc.${row.domain}`, "TXT"),
    lookup(`send.${row.domain}`, "TXT"),
    lookup(`send.${row.domain}`, "MX"),
    ...selectors.map(selector => lookup(`${selector}._domainkey.${row.domain}`, "TXT")),
  ]);
  const answers: DnsAnswers = {
    mx, rootTxt, dmarcTxt, sendSubdomainTxt, sendSubdomainMx,
    dkim: Object.fromEntries(selectors.map((selector, index) => [selector, dkim[index]])),
  };
  const report = evaluateDns(answers, row.outbound_transport);
  await env.DB.prepare("UPDATE domains SET dns_checked_at = ?2, dns_report = ?3 WHERE domain = ?1")
    .bind(row.domain, report.checkedAt, JSON.stringify(report)).run();
  return Response.json({ domain: present((await domainRow(env, row.domain))!) });
}
