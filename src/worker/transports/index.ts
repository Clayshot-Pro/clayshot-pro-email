import { appConfig } from "../appConfig";
import { sendingDomain } from "../domains";
import { CloudflareTransport } from "./cloudflare";
import { ResendTransport } from "./resend";
import { selectTransport, type TransportChoice } from "./select";
import type { OutboundTransport } from "./types";

const PRIMARY_MAILBOX_ID = "native:primary";

export async function transportChoice(env: Env, mailboxId: string, address: string): Promise<TransportChoice> {
  const config = appConfig(env);
  const domain = await sendingDomain(env, address);
  return selectTransport({
    isPrimaryMailbox: mailboxId === PRIMARY_MAILBOX_ID,
    domainStatus: domain?.status ?? null,
    domainTransport: domain?.transport ?? null,
    multiSenderApproved: config.features.multiSender,
    resendConfigured: config.features.resend,
  });
}

export function transportFor(env: Env, choice: TransportChoice): OutboundTransport | null {
  if (choice.kind === "cloudflare") return new CloudflareTransport(choice.binding === "EMAIL" ? env.EMAIL : env.EMAIL_MULTI);
  if (choice.kind === "resend" && env.RESEND_API_KEY) return new ResendTransport(env.RESEND_API_KEY);
  return null;
}
