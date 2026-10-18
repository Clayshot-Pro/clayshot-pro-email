import { TransportError, type OutboundMessage, type OutboundTransport, type TransportResult } from "./types.ts";

/** Cloudflare Email Service limits a message, attachments included, to 5 MiB. */
export const MAX_API_MESSAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_HEADERS = new Set(["in-reply-to", "references"]);

/** Cloudflare API error codes mapped onto user-safe delivery codes. */
const REST_ERRORS: Record<number, string> = {
  10001: "E_VALIDATION_ERROR",
  10200: "E_CONTENT_TOO_LARGE",
  10101: "E_EMAIL_API_AUTH_FAILED",
  10103: "E_EMAIL_API_AUTH_FAILED",
  10102: "E_EMAIL_API_FORBIDDEN",
  10105: "E_EMAIL_SERVICE_NOT_ENTITLED",
  10203: "E_EMAIL_SENDING_DISABLED",
  10004: "E_RATE_LIMIT_EXCEEDED",
};

type ApiResult = {
  success?: boolean;
  errors?: Array<{ code?: number }>;
  result?: { delivered?: string[]; queued?: string[]; permanent_bounces?: string[] } | null;
};

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let raw = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(raw);
}

export function mapCloudflareApiError(code: unknown): string {
  return typeof code === "number" && REST_ERRORS[code] ? REST_ERRORS[code] : "E_DELIVERY_FAILED";
}

export function cloudflareApiPayload(message: OutboundMessage): Record<string, unknown> {
  const headers = Object.fromEntries(Object.entries(message.headers ?? {})
    .filter(([name, value]) => ALLOWED_HEADERS.has(name.toLowerCase()) && !/[\r\n]/.test(value)));
  return {
    from: { address: message.from.email, name: message.from.name },
    to: message.to,
    cc: message.cc.length ? message.cc : undefined,
    bcc: message.bcc.length ? message.bcc : undefined,
    reply_to: message.replyTo,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: Object.keys(headers).length ? headers : undefined,
    attachments: message.attachments.map(item => ({
      content: base64(item.content),
      filename: item.filename,
      type: item.type,
      disposition: "attachment" as const,
    })),
  };
}

/**
 * Sends through the Cloudflare Email Sending REST API. It is domain-scoped,
 * so any active mailbox on an onboarded domain can send without per-address
 * bindings. The token stays a Worker secret; From is always server-derived.
 */
export class CloudflareApiTransport implements OutboundTransport {
  readonly kind = "cloudflare" as const;
  private readonly accountId: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(accountId: string, token: string, fetcher: typeof fetch = fetch) {
    this.accountId = accountId;
    this.token = token;
    this.fetcher = fetcher;
  }

  async send(message: OutboundMessage): Promise<TransportResult> {
    if (!/^[a-f0-9]{32}$/i.test(this.accountId) || !this.token) throw new TransportError("E_EMAIL_API_NOT_CONFIGURED");
    const body = JSON.stringify(cloudflareApiPayload(message));
    if (new TextEncoder().encode(body).byteLength > MAX_API_MESSAGE_BYTES) throw new TransportError("E_CONTENT_TOO_LARGE");
    let response: Response;
    try {
      response = await this.fetcher(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/email/sending/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // The request may have reached Cloudflare even on a timeout: never auto-retry.
      throw new TransportError("E_EMAIL_DELIVERY_UNKNOWN", true);
    }
    const data = await response.json().catch(() => null) as ApiResult | null;
    if (!response.ok || data?.success !== true) throw new TransportError(mapCloudflareApiError(data?.errors?.[0]?.code));
    const accepted = (data.result?.delivered?.length ?? 0) + (data.result?.queued?.length ?? 0);
    // A 200 with only permanent bounces is not a successful send.
    if (accepted === 0) throw new TransportError("E_DELIVERY_FAILED");
    // The REST API reports delivery categories, not a message ID.
    return { providerMessageId: null };
  }
}
