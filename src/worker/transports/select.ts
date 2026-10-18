/**
 * Pure outbound transport selection. The UI (`sendEnabled`) and the send
 * handler both use this, so they always agree on whether a mailbox can send.
 */
export type TransportChoice =
  | { kind: "cloudflare" }
  | { kind: "resend" }
  | { kind: "unavailable"; reason: string };

export type SelectionInput = {
  domainStatus: "pending" | "active" | "disabled" | null;
  domainTransport: "cloudflare" | "resend" | "none" | null;
  /** CF_EMAIL_SENDING_ACCOUNT_ID and CF_EMAIL_SENDING_TOKEN are present. */
  emailApiConfigured: boolean;
  resendConfigured: boolean;
};

export function selectTransport(input: SelectionInput): TransportChoice {
  if (input.domainStatus !== "active") {
    return { kind: "unavailable", reason: "Sending is not enabled for this mailbox's domain" };
  }
  switch (input.domainTransport) {
    case "cloudflare":
      // Every active mailbox on an onboarded domain sends through the API.
      return input.emailApiConfigured
        ? { kind: "cloudflare" }
        : { kind: "unavailable", reason: "Cloudflare Email Sending is not configured (set CF_EMAIL_SENDING_TOKEN)" };
    case "resend":
      return input.resendConfigured
        ? { kind: "resend" }
        : { kind: "unavailable", reason: "This domain sends through Resend, but RESEND_API_KEY is not configured" };
    default:
      return { kind: "unavailable", reason: "This domain is receive-only" };
  }
}
