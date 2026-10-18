/**
 * Pure outbound transport selection. The UI (`sendEnabled`) and the send
 * handler both use this, so they always agree on whether a mailbox can send.
 */
export type TransportChoice =
  | { kind: "cloudflare"; binding: "EMAIL" | "EMAIL_MULTI" }
  | { kind: "resend" }
  | { kind: "unavailable"; reason: string };

export type SelectionInput = {
  isPrimaryMailbox: boolean;
  domainStatus: "pending" | "active" | "disabled" | null;
  domainTransport: "cloudflare" | "resend" | "none" | null;
  multiSenderApproved: boolean;
  resendConfigured: boolean;
};

export function selectTransport(input: SelectionInput): TransportChoice {
  if (input.domainStatus !== "active") {
    return { kind: "unavailable", reason: "Sending is not enabled for this mailbox's domain" };
  }
  switch (input.domainTransport) {
    case "cloudflare":
      if (input.isPrimaryMailbox) return { kind: "cloudflare", binding: "EMAIL" };
      return input.multiSenderApproved
        ? { kind: "cloudflare", binding: "EMAIL_MULTI" }
        : { kind: "unavailable", reason: "Sending from this mailbox is not enabled yet" };
    case "resend":
      return input.resendConfigured
        ? { kind: "resend" }
        : { kind: "unavailable", reason: "This domain sends through Resend, but RESEND_API_KEY is not configured" };
    default:
      return { kind: "unavailable", reason: "This domain is receive-only" };
  }
}
