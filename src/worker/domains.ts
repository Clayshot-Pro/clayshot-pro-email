import { appConfig, isValidDomain } from "./appConfig";
import { connectDomain } from "./cloudflare/domainConnect";
import { cloudflareConnection } from "./storedKeys";
import { appOrigin } from "./config";
import { THEMES, type ThemeId } from "./customization";
import { evaluateDns, CLOUDFLARE_DKIM_SELECTORS, RESEND_DKIM_SELECTORS, type DnsAnswers, type OutboundTransportKind } from "./domainDns";
import type { AddressRules } from "./mailboxRules";
import { ADMIN_MAILBOX_ID, LEGACY_MAILBOX_ID, adminMailboxAddressFor } from "./mailboxIds";

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
  theme: string | null;
  created_at: string;
  updated_at: string;
};

const TRANSPORTS = new Set<OutboundTransportKind>(["cloudflare", "resend", "none"]);
const jsonError = (error: string, status: number) => Response.json({ error }, { status });
const validTheme = (value: unknown): value is ThemeId =>
  typeof value === "string" && (THEMES as readonly string[]).includes(value);

let cachedPrimary: { domain: string; at: number } | null = null;
const PRIMARY_CACHE_MS = 60_000;

/**
 * The primary mail domain, or null on a fresh install that has not run setup.
 * Read on every authenticated request (legacy admin alias), so a known value
 * is cached per isolate; "uninitialized" is never cached.
 */
export async function primaryDomain(env: Env, fresh = false): Promise<string | null> {
  if (!fresh && cachedPrimary && Date.now() - cachedPrimary.at < PRIMARY_CACHE_MS) return cachedPrimary.domain;
  const row = await env.DB.prepare("SELECT domain FROM domains WHERE is_primary = 1 LIMIT 1")
    .first<{ domain: string }>().catch(() => null);
  const domain = row?.domain.toLowerCase() ?? null;
  cachedPrimary = domain ? { domain, at: Date.now() } : null;
  return domain;
}

/**
 * An install is established once it holds data or an owner passkey. Migration
 * 0010 seeds native:primary with a placeholder address, so a fresh install
 * stays uninitialized until first-run setup chooses the mail domain.
 */
async function established(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT
      EXISTS (SELECT 1 FROM messages WHERE mailbox_id = ?1)
      OR EXISTS (SELECT 1 FROM drafts WHERE mailbox_id = ?1)
      OR EXISTS (SELECT 1 FROM native_mailbox_credentials WHERE mailbox_id = ?1)
      OR EXISTS (SELECT 1 FROM auth_credentials) AS yes`).bind(LEGACY_MAILBOX_ID).first<{ yes: number }>();
  return Boolean(row?.yes);
}

/** The admin@<main domain> mailbox; created once, never renamed. */
async function ensureAdminMailbox(env: Env, domain: string): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO native_mailboxes (id, email_address, display_name, domain, spam_filter_enabled)
    VALUES (?1, ?2, 'Admin', ?3, 1)`).bind(ADMIN_MAILBOX_ID, adminMailboxAddressFor(domain), domain).run();
}

/**
 * Keep native_mailboxes.domain in sync; for an install upgraded from v2, adopt
 * its mailbox's domain as the main domain; and make sure the admin mailbox
 * exists on the main domain (upgrades from v3.07 and earlier get it here).
 */
export async function ensureDomains(env: Env): Promise<void> {
  await env.DB.prepare(`UPDATE native_mailboxes SET domain = lower(substr(email_address, instr(email_address, '@') + 1))
    WHERE domain IS NULL OR domain != lower(substr(email_address, instr(email_address, '@') + 1))`).run();
  let domain = await primaryDomain(env, true);
  if (!domain && await established(env)) {
    const box = await env.DB.prepare("SELECT email_address FROM native_mailboxes WHERE id = ?1")
      .bind(LEGACY_MAILBOX_ID).first<{ email_address: string }>();
    const legacy = box?.email_address.slice(box.email_address.lastIndexOf("@") + 1).toLowerCase();
    if (legacy && isValidDomain(legacy)) {
      await env.DB.prepare(`INSERT INTO domains (domain, status, is_primary) VALUES (?1, 'active', 1)
        ON CONFLICT(domain) DO UPDATE SET status = 'active', is_primary = 1, updated_at = CURRENT_TIMESTAMP`).bind(legacy).run();
      domain = legacy;
    }
  }
  if (domain) await ensureAdminMailbox(env, domain);
}

export async function isInitialized(env: Env): Promise<boolean> {
  return Boolean(await primaryDomain(env, true));
}

/**
 * First-run setup: choose the main mail domain, which creates the admin@
 * mailbox on it. Allowed only while the instance is uninitialized; the caller
 * has already verified AUTH_SETUP_TOKEN. Returns an error message, or null.
 */
export async function initializeInstance(env: Env, input: string): Promise<string | null> {
  // Accept "example.com" or an address on it.
  const domain = input.trim().toLowerCase().replace(/^.*@/, "");
  if (!isValidDomain(domain)) return "Enter your mail domain, for example example.com";
  if (await primaryDomain(env, true) || await established(env)) return "This instance is already set up";
  await env.DB.batch([
    // Not established: native:primary is only migration 0010's placeholder.
    env.DB.prepare("DELETE FROM native_mailboxes WHERE id = ?1").bind(LEGACY_MAILBOX_ID),
    env.DB.prepare("UPDATE domains SET is_primary = 0 WHERE is_primary = 1"),
    env.DB.prepare(`INSERT INTO domains (domain, status, is_primary) VALUES (?1, 'active', 1)
      ON CONFLICT(domain) DO UPDATE SET status = 'active', is_primary = 1, updated_at = CURRENT_TIMESTAMP`).bind(domain),
    env.DB.prepare(`INSERT OR IGNORE INTO native_mailboxes (id, email_address, display_name, domain, spam_filter_enabled)
      VALUES (?1, ?2, 'Admin', ?3, 1)`).bind(ADMIN_MAILBOX_ID, adminMailboxAddressFor(domain), domain),
  ]);
  cachedPrimary = { domain, at: Date.now() };
  return null;
}

/** Domains addresses may use: active for routing/sign-in, active + pending for creation. */
export async function addressRules(env: Env, scope: RulesScope = "routing"): Promise<AddressRules> {
  const statuses = scope === "create" ? ["active", "pending"] : ["active"];
  const rows = await env.DB.prepare(`SELECT domain, is_primary FROM domains WHERE status IN (${statuses.map(() => "?").join(",")})`)
    .bind(...statuses).all<{ domain: string; is_primary: number }>()
    .catch(() => ({ results: [] as { domain: string; is_primary: number }[] }));
  const domains = new Set(rows.results.map(row => row.domain.toLowerCase()));
  const primary = rows.results.find(row => row.is_primary === 1)?.domain.toLowerCase() ?? "";
  // The admin local part is reserved on every domain (mailboxRules RESERVED).
  return { domains, defaultDomain: primary };
}

export async function domainRow(env: Env, domain: string): Promise<DomainRow | null> {
  return env.DB.prepare("SELECT * FROM domains WHERE domain = ?1").bind(domain.toLowerCase()).first<DomainRow>();
}

/** Mailbox that receives postmaster@ / abuse@ for a domain. */
export async function postmasterMailboxId(env: Env, domain: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT d.postmaster_mailbox_id AS id FROM domains d
    JOIN native_mailboxes m ON m.id = d.postmaster_mailbox_id AND m.status = 'active' AND m.deleted_at IS NULL
    WHERE d.domain = ?1`).bind(domain.toLowerCase()).first<{ id: string }>();
  return row?.id ?? ADMIN_MAILBOX_ID;
}

/** Outbound policy for a sender address's domain. */
export async function sendingDomain(env: Env, address: string): Promise<{ status: DomainStatus; transport: OutboundTransportKind } | null> {
  const row = await domainRow(env, address.slice(address.lastIndexOf("@") + 1).toLowerCase());
  return row ? { status: row.status, transport: row.outbound_transport } : null;
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
    theme: validTheme(row.theme) ? row.theme : null,
    dnsCheckedAt: row.dns_checked_at,
    dnsReport: report,
    mailboxCount: row.mailbox_count ?? 0,
    createdAt: row.created_at,
  };
}

export async function listDomainsResponse(request: Request, env: Env): Promise<Response> {
  const config = appConfig(env);
  const rows = await env.DB.prepare(`SELECT d.*, (SELECT COUNT(*) FROM native_mailboxes m WHERE m.domain = d.domain) AS mailbox_count
    FROM domains d ORDER BY d.is_primary DESC, d.domain`).all<DomainRow & { mailbox_count: number }>();
  return Response.json({
    domains: rows.results.map(present),
    transports: {
      cloudflare: {
        available: config.features.emailApi || config.features.emailBinding,
        mode: config.features.emailApi ? "api" : config.features.emailBinding ? "binding" : null,
      },
      resend: { available: config.features.resend, webhookConfigured: config.features.resendWebhook },
    },
    webhookUrl: `${appOrigin(request)}/api/webhooks/resend`,
    // Domains can be wired automatically with the stored Cloudflare token.
    cloudflareConnected: Boolean(await cloudflareConnection(env)),
  });
}

export async function createDomain(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ domain?: unknown; connect?: unknown }>().catch(() => null);
  const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!isValidDomain(domain)) return jsonError("Enter a valid ASCII or punycode domain such as example.org", 400);
  if (domain === new URL(request.url).hostname.toLowerCase()) return jsonError("Use the mail domain, not the web app host", 400);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM domains").first<{ n: number }>();
  if ((count?.n ?? 0) >= 50) return jsonError("Domain limit reached", 409);
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO domains (domain, status) VALUES (?1, 'pending')").bind(domain).run();
  if (!inserted.meta.changes) return jsonError("Domain already exists", 409);
  // With a Cloudflare connection, adding also wires the domain (one approval).
  const connection = body && "connect" in body && body.connect === true ? await cloudflareConnection(env) : null;
  if (connection) {
    const row = (await domainRow(env, domain))!;
    const report = await connectDomain(connection, domain, { sending: row.outbound_transport === "cloudflare" });
    await activateIfReady(env, row, report.routingReady);
    return Response.json({ domain: present((await domainRow(env, domain))!), report }, { status: 201 });
  }
  return Response.json({ domain: present((await domainRow(env, domain))!) }, { status: 201 });
}

export async function updateDomain(request: Request, env: Env, domain: string): Promise<Response> {
  const row = await domainRow(env, domain);
  if (!row) return jsonError("Domain not found", 404);
  const body = await request.json<{ status?: unknown; postmasterMailboxId?: unknown; outboundTransport?: unknown; theme?: unknown }>()
    .catch(() => null);
  if (!body || (body.status === undefined && body.postmasterMailboxId === undefined
    && body.outboundTransport === undefined && body.theme === undefined)) {
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
  let theme = validTheme(row.theme) ? row.theme : null;
  if (body.theme !== undefined) {
    if (body.theme !== null && !validTheme(body.theme)) return jsonError("Unknown theme", 400);
    theme = body.theme;
  }
  await env.DB.prepare(`UPDATE domains SET status = ?2, postmaster_mailbox_id = ?3, outbound_transport = ?4, theme = ?5,
    updated_at = CURRENT_TIMESTAMP WHERE domain = ?1`).bind(row.domain, status, postmaster, transport, theme).run();
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
  await refreshDnsReport(env, row);
  return Response.json({ domain: present((await domainRow(env, row.domain))!) });
}

/**
 * POST /api/admin/domains/:domain/connect { replaceMx? } (administrator
 * step-up): wire the domain with the stored Cloudflare token, then check DNS.
 * The domain is activated when Cloudflare confirms its mail reaches this app.
 */
export async function connectDomainRoute(request: Request, env: Env, domain: string): Promise<Response> {
  const row = await domainRow(env, domain);
  if (!row) return jsonError("Domain not found", 404);
  const connection = await cloudflareConnection(env);
  if (!connection) return jsonError("Connect Cloudflare first (Admin → Keys), or set the domain up in the Cloudflare dashboard.", 409);
  const body = await request.json<{ replaceMx?: unknown }>().catch(() => null);
  const report = await connectDomain(connection, row.domain, {
    replaceMx: body?.replaceMx === true,
    sending: row.outbound_transport === "cloudflare",
  });
  await activateIfReady(env, row, report.routingReady);
  return Response.json({ report, domain: present((await domainRow(env, row.domain))!) });
}

/** Refresh the DNS report; activate a pending domain whose routing Cloudflare confirmed. */
export async function activateIfReady(env: Env, row: DomainRow, routingReady: boolean): Promise<void> {
  await refreshDnsReport(env, row).catch(() => undefined);
  if (routingReady && row.status === "pending") {
    await env.DB.prepare("UPDATE domains SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE domain = ?1 AND status = 'pending'")
      .bind(row.domain).run();
  }
}

async function refreshDnsReport(env: Env, row: DomainRow): Promise<void> {
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
}
