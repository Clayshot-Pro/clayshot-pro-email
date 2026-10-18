/** Provider-neutral outbound message, built by the native provider. */
export type OutboundMessage = {
  from: { email: string; name: string };
  replyTo: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
  attachments: { filename: string; type: string; content: ArrayBuffer }[];
  /** Stable per mailbox + client send key, so a retried request cannot send twice. */
  idempotencyKey?: string;
};

export type TransportKind = "cloudflare" | "resend";
export type TransportResult = { providerMessageId: string | null };

/** User-safe delivery codes. Raw provider messages never reach the client. */
export const SAFE_DELIVERY_CODES = new Set([
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_DELIVERY_FAILED",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
  "E_DELIVERY_UNCERTAIN",
]);

/** Error carrying a safe delivery code; `code` matches the Cloudflare binding's shape. */
export class TransportError extends Error {
  readonly code: string;
  readonly uncertain: boolean;
  constructor(code: string, uncertain = false) {
    super(code);
    this.name = "TransportError";
    this.code = SAFE_DELIVERY_CODES.has(code) ? code : "E_DELIVERY_FAILED";
    this.uncertain = uncertain;
  }
}

export interface OutboundTransport {
  readonly kind: TransportKind;
  send(message: OutboundMessage): Promise<TransportResult>;
}
