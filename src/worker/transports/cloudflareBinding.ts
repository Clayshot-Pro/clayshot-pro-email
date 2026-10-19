import type { OutboundMessage, OutboundTransport, TransportResult } from "./types";

/** Only threading headers, and never a value with a line break or NUL (header injection). */
const ALLOWED_HEADERS = new Set(["in-reply-to", "references"]);
export const safeHeaders = (headers: Record<string, string> | undefined) => Object.fromEntries(Object.entries(headers ?? {})
  .filter(([name, value]) => ALLOWED_HEADERS.has(name.toLowerCase()) && !/[\r\n\u0000]/.test(value)));

/**
 * Cloudflare Email Sending through the unrestricted `EMAIL` send_email
 * binding. It needs no API token: Cloudflare authorizes it through the
 * Worker's own account, and it can send from any domain onboarded for Email
 * Sending there. From is always the authenticated mailbox, never client data.
 */
export class CloudflareBindingTransport implements OutboundTransport {
  readonly kind = "cloudflare" as const;
  private readonly binding: EmailServiceBinding;

  constructor(binding: EmailServiceBinding) {
    this.binding = binding;
  }

  async send(message: OutboundMessage): Promise<TransportResult> {
    const headers = safeHeaders(message.headers);
    const result = await this.binding.send({
      from: message.from,
      to: message.to,
      cc: message.cc.length ? message.cc : undefined,
      bcc: message.bcc.length ? message.bcc : undefined,
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: Object.keys(headers).length ? headers : undefined,
      attachments: message.attachments.map(attachment => ({
        content: attachment.content,
        filename: attachment.filename,
        type: attachment.type,
        disposition: "attachment" as const,
      })),
    });
    return { providerMessageId: result.messageId };
  }
}
