import { appConfig } from "../appConfig";
import { sendingDomain } from "../domains";
import { CloudflareApiTransport } from "./cloudflareApi";
import { ResendTransport } from "./resend";
import { selectTransport, type TransportChoice } from "./select";
import type { OutboundTransport } from "./types";

export async function transportChoice(env: Env, _mailboxId: string, address: string): Promise<TransportChoice> {
  const { features } = appConfig(env);
  const domain = await sendingDomain(env, address);
  return selectTransport({
    domainStatus: domain?.status ?? null,
    domainTransport: domain?.transport ?? null,
    emailApiConfigured: features.emailApi,
    resendConfigured: features.resend,
  });
}

export function transportFor(env: Env, choice: TransportChoice): OutboundTransport | null {
  if (choice.kind === "cloudflare" && env.CF_EMAIL_SENDING_ACCOUNT_ID && env.CF_EMAIL_SENDING_TOKEN) {
    return new CloudflareApiTransport(env.CF_EMAIL_SENDING_ACCOUNT_ID.trim(), env.CF_EMAIL_SENDING_TOKEN.trim());
  }
  if (choice.kind === "resend" && env.RESEND_API_KEY) return new ResendTransport(env.RESEND_API_KEY);
  return null;
}
