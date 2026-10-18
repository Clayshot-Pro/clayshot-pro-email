import { appConfig, domainOf } from "../appConfig";
import { sendingDomain } from "../domains";
import { CloudflareApiTransport } from "./cloudflareApi";
import { CloudflareBindingTransport } from "./cloudflareBinding";
import { ResendTransport } from "./resend";
import { selectTransport, type TransportChoice } from "./select";
import type { OutboundTransport } from "./types";

export async function transportChoice(env: Env, _mailboxId: string, address: string): Promise<TransportChoice> {
  const { features } = appConfig(env);
  const domain = await sendingDomain(env, address);
  return selectTransport({
    domainStatus: domain?.status ?? null,
    domainTransport: domain?.transport ?? null,
    cloudflareConfigured: features.emailApi || features.emailBinding,
    resendConfigured: features.resend,
  });
}

/** Send availability for many mailboxes with a single domains query. */
export async function sendableMailboxes(env: Env, boxes: { email_address: string }[]): Promise<boolean[]> {
  const { features } = appConfig(env);
  const rows = await env.DB.prepare("SELECT domain, status, outbound_transport FROM domains")
    .all<{ domain: string; status: "pending" | "active" | "disabled"; outbound_transport: "cloudflare" | "resend" | "none" }>();
  const domains = new Map(rows.results.map(row => [row.domain.toLowerCase(), row]));
  return boxes.map(box => {
    const domain = domains.get(domainOf(box.email_address).toLowerCase());
    return selectTransport({
      domainStatus: domain?.status ?? null,
      domainTransport: domain?.outbound_transport ?? null,
      cloudflareConfigured: features.emailApi || features.emailBinding,
      resendConfigured: features.resend,
    }).kind !== "unavailable";
  });
}

export function transportFor(env: Env, choice: TransportChoice): OutboundTransport | null {
  if (choice.kind === "cloudflare") {
    // The Email Sending API is used only when its token is set; otherwise the
    // EMAIL binding, which needs no credentials.
    if (appConfig(env).features.emailApi) {
      return new CloudflareApiTransport(env.CF_EMAIL_SENDING_ACCOUNT_ID!.trim(), env.CF_EMAIL_SENDING_TOKEN!.trim());
    }
    if (env.EMAIL) return new CloudflareBindingTransport(env.EMAIL);
    return null;
  }
  if (choice.kind === "resend" && env.RESEND_API_KEY) return new ResendTransport(env.RESEND_API_KEY);
  return null;
}
