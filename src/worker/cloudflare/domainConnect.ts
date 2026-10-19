import { cloudflareClient, CloudflareApiError, type CloudflareClient, type Fetcher } from "./api";
import type { CloudflareConnection } from "./connection";

/**
 * Wire a mail domain with the stored Cloudflare token (v3.12): Email Routing
 * on, the catch-all to this Worker, Email Sending onboarding and a monitoring
 * DMARC record. Each step is idempotent and reports what it did; a step that
 * fails does not undo the others. MX records of another mail service, and a
 * catch-all rule that already delivers somewhere else, are only replaced after
 * the administrator confirms (replaceMx, replaceCatchAll).
 */
export type StepStatus = "done" | "skipped" | "failed" | "action";
export type ConnectStep = { id: string; label: string; status: StepStatus; detail: string };
export type MxRecord = { id?: string; name?: string; content?: string; priority?: number };
export type ConnectReport = {
  domain: string;
  steps: ConnectStep[];
  /** Another mail service's MX records, when the administrator must confirm replacing them. */
  mxConflict: Array<{ host: string; priority: number }> | null;
  /** Where the zone's enabled catch-all sends mail now, when replacing it needs confirmation. */
  catchAllConflict: string | null;
  /** Cloudflare confirms mail for the domain reaches this Worker. */
  routingReady: boolean;
};
export type ConnectOptions = { replaceMx?: boolean; replaceCatchAll?: boolean; sending?: boolean };

type Zone = { id: string; name: string };
type CatchAll = { enabled?: boolean; actions?: Array<{ type: string; value?: string[] }> };

const isCloudflareMx = (record: MxRecord) => /\.mx\.cloudflare\.net\.?$/i.test(record.content ?? "");
const message = (error: unknown) => error instanceof Error ? error.message : "unknown error";

/** The zone that holds `domain`: the domain itself or its nearest parent in this account. */
async function findZone(api: CloudflareClient, accountId: string, domain: string): Promise<Zone | null> {
  const labels = domain.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join(".");
    const zones = await api<Zone[]>(`/zones?name=${encodeURIComponent(candidate)}&account.id=${accountId}&per_page=5`);
    const zone = zones.find(item => item.name.toLowerCase() === candidate);
    if (zone) return zone;
  }
  return null;
}

async function mxRecords(api: CloudflareClient, zoneId: string, domain: string): Promise<MxRecord[]> {
  return api<MxRecord[]>(`/zones/${zoneId}/dns_records?type=MX&name=${encodeURIComponent(domain)}&per_page=50`);
}

export async function connectDomain(connection: CloudflareConnection, domain: string, options: ConnectOptions = {},
  fetcher?: Fetcher): Promise<ConnectReport> {
  const api = cloudflareClient(connection.token, fetcher);
  const report: ConnectReport = { domain, steps: [], mxConflict: null, catchAllConflict: null, routingReady: false };
  const step = (id: string, label: string, status: StepStatus, detail: string) => { report.steps.push({ id, label, status, detail }); };

  let zone: Zone | null;
  try {
    zone = await findZone(api, connection.accountId, domain);
  } catch (error) {
    step("zone", "Find the domain in Cloudflare", "failed", message(error));
    return report;
  }
  if (!zone) {
    step("zone", "Find the domain in Cloudflare", "failed",
      `${domain} is not in this Cloudflare account. Add it to Cloudflare (its DNS must be on Cloudflare), then try again.`);
    return report;
  }
  step("zone", "Find the domain in Cloudflare", "done", `Zone ${zone.name}`);

  // Another provider's MX records would keep receiving the mail: ask first.
  try {
    const foreign = (await mxRecords(api, zone.id, domain)).filter(record => !isCloudflareMx(record));
    if (foreign.length && !options.replaceMx) {
      report.mxConflict = foreign.map(record => ({ host: (record.content ?? "").replace(/\.$/, ""), priority: record.priority ?? 0 }));
      step("mx", "Existing mail records", "action",
        `Mail for ${domain} currently goes to ${report.mxConflict.map(item => item.host).join(", ")}. Replace those MX records to receive it here.`);
      return report;
    }
    for (const record of foreign) {
      if (record.id) await api(`/zones/${zone.id}/dns_records/${record.id}`, { method: "DELETE" });
    }
    if (foreign.length) step("mx", "Existing mail records", "done", `Removed ${foreign.length} MX record${foreign.length === 1 ? "" : "s"} of the previous mail service`);
  } catch (error) {
    step("mx", "Existing mail records", "failed", message(error));
    return report;
  }

  try {
    // Routing is on for the zone, but a subdomain also needs its own MX records.
    const routing = await api<{ enabled?: boolean; status?: string }>(`/zones/${zone.id}/email/routing`).catch(() => null);
    const domainRouted = (await mxRecords(api, zone.id, domain)).some(isCloudflareMx);
    if (routing?.enabled && domainRouted) {
      step("routing", "Email Routing", "skipped", "Already on");
    } else {
      await api(`/zones/${zone.id}/email/routing/dns`, { method: "POST", ...(domain === zone.name ? {} : { body: { name: domain } }) });
      step("routing", "Email Routing", "done", "Turned on, with its MX and SPF records");
    }
  } catch (error) {
    step("routing", "Email Routing", "failed", message(error));
  }

  try {
    const current = await api<CatchAll>(`/zones/${zone.id}/email/routing/rules/catch_all`).catch(() => null);
    const routed = current?.enabled && current.actions?.some(action => action.type === "worker" && action.value?.includes(connection.scriptName));
    // The catch-all covers the whole zone: never silently take over one that
    // already delivers (forwards or runs another Worker) somewhere else.
    const elsewhere = current?.enabled && !routed
      ? (current.actions ?? []).filter(action => action.type !== "drop")
        .map(action => `${action.type === "worker" ? "Worker" : action.type} ${(action.value ?? []).join(", ")}`.trim())
      : [];
    if (routed) {
      step("catch-all", "Deliver mail to this app", "skipped", "The catch-all already sends mail here");
    } else if (elsewhere.length && !options.replaceCatchAll) {
      report.catchAllConflict = elsewhere.join("; ");
      step("catch-all", "Deliver mail to this app", "action",
        `The catch-all for ${zone.name} already sends mail to ${report.catchAllConflict}. Replace it to receive unknown addresses here.`);
    } else {
      await api(`/zones/${zone.id}/email/routing/rules/catch_all`, {
        method: "PUT",
        body: {
          name: `Deliver all mail to ${connection.scriptName}`,
          enabled: true,
          matchers: [{ type: "all" }],
          actions: [{ type: "worker", value: [connection.scriptName] }],
        },
      });
      step("catch-all", "Deliver mail to this app", "done", "The catch-all rule sends every address to this app, which rejects unknown ones");
    }
  } catch (error) {
    step("catch-all", "Deliver mail to this app", "failed", message(error));
  }

  if (options.sending !== false) {
    try {
      const subdomains = await api<Array<{ name?: string }>>(`/zones/${zone.id}/email/sending/subdomains`);
      if (subdomains.some(item => item.name?.toLowerCase() === domain)) {
        step("sending", "Email Sending", "skipped", "Already set up for sending");
      } else {
        await api(`/zones/${zone.id}/email/sending/subdomains`, { method: "POST", body: { name: domain } });
        step("sending", "Email Sending", "done", "Set up for sending, with its DKIM and SPF records");
      }
    } catch (error) {
      const detail = error instanceof CloudflareApiError && error.hasCode(2036)
        ? "Cloudflare refused while MX records of another mail service exist."
        : message(error);
      step("sending", "Email Sending", "failed", `${detail.replace(/\.?$/, ".")} Sending through Cloudflare needs a Workers Paid plan.`);
    }
  }

  try {
    const name = `_dmarc.${domain}`;
    const txt = await api<Array<{ content?: string }>>(`/zones/${zone.id}/dns_records?type=TXT&name=${encodeURIComponent(name)}&per_page=20`);
    if (txt.some(record => /v=DMARC1/i.test(record.content ?? ""))) {
      step("dmarc", "DMARC record", "skipped", "Already published");
    } else {
      await api(`/zones/${zone.id}/dns_records`, {
        method: "POST",
        body: { type: "TXT", name, content: "\"v=DMARC1; p=none\"", ttl: 1, comment: "Added by the mail app: monitoring-only DMARC policy" },
      });
      step("dmarc", "DMARC record", "done", "Published a monitoring-only policy (p=none); tighten it once mail flows");
    }
  } catch (error) {
    step("dmarc", "DMARC record", "failed", message(error));
  }

  // Authoritative check from the zone itself (public resolvers may lag).
  try {
    const mx = await mxRecords(api, zone.id, domain);
    const catchAll = await api<CatchAll>(`/zones/${zone.id}/email/routing/rules/catch_all`);
    report.routingReady = mx.length > 0 && mx.every(isCloudflareMx)
      && Boolean(catchAll.enabled && catchAll.actions?.some(action => action.type === "worker" && action.value?.includes(connection.scriptName)));
  } catch {
    report.routingReady = false;
  }
  return report;
}
