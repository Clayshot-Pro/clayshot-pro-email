import { TransportError, type OutboundMessage, type OutboundTransport, type TransportResult } from "./types.ts";

const ENDPOINT = "https://api.resend.com/emails";
const ALLOWED_HEADERS = new Set(["in-reply-to", "references"]);

/** "Name" <address>, with the display name stripped of quoting and control characters. */
export function formatSender(name: string, email: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f"\<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return clean ? `"${clean}" <${email}>` : email;
}

export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function resendPayload(message: OutboundMessage): Record<string, unknown> {
  const headers = Object.fromEntries(Object.entries(message.headers ?? {})
    .filter(([name, value]) => ALLOWED_HEADERS.has(name.toLowerCase()) && !/[\r\n]/.test(value)));
  return {
    from: formatSender(message.from.name, message.from.email),
    to: message.to,
    ...(message.cc.length ? { cc: message.cc } : {}),
    ...(message.bcc.length ? { bcc: message.bcc } : {}),
    reply_to: message.replyTo,
    subject: message.subject,
    text: message.text,
    html: message.html,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(message.attachments.length ? {
      attachments: message.attachments.map(attachment => ({
        filename: attachment.filename,
        content: toBase64(attachment.content),
        content_type: attachment.type,
      })),
    } : {}),
  };
}

/** Map a Resend error response onto a safe delivery code. Unknown names never leak. */
export function mapResendError(status: number, name: unknown): string {
  const code = typeof name === "string" ? name.toLowerCase() : "";
  if (status === 429 || code === "rate_limit_exceeded" || code === "concurrent_idempotent_requests") return "E_RATE_LIMIT_EXCEEDED";
  if (code === "daily_quota_exceeded" || code === "monthly_quota_exceeded") return "E_DAILY_LIMIT_EXCEEDED";
  if (code === "invalid_from_address" || status === 403) return "E_SENDER_DOMAIN_NOT_AVAILABLE";
  if (status === 413) return "E_CONTENT_TOO_LARGE";
  if (status >= 500 || code === "application_error" || code === "internal_server_error") return "E_INTERNAL_SERVER_ERROR";
  return "E_DELIVERY_FAILED";
}

export class ResendTransport implements OutboundTransport {
  readonly kind = "resend" as const;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(apiKey: string, fetcher: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  async send(message: OutboundMessage): Promise<TransportResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (message.idempotencyKey) headers["Idempotency-Key"] = message.idempotencyKey.slice(0, 256);
    let response: Response;
    try {
      response = await this.fetcher(ENDPOINT, {
        method: "POST", headers, body: JSON.stringify(resendPayload(message)), signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // The request may have reached Resend; never retry automatically.
      throw new TransportError("E_DELIVERY_UNCERTAIN", true);
    }
    const body = await response.json().catch(() => null) as { id?: unknown; name?: unknown } | null;
    if (!response.ok) throw new TransportError(mapResendError(response.status, body?.name));
    // Resend's response has only its own id; the Message-ID arrives with its
    // webhooks (or is learned from the first reply, see receive.ts).
    return { providerMessageId: typeof body?.id === "string" ? body.id : null, messageIdHeader: null };
  }
}
