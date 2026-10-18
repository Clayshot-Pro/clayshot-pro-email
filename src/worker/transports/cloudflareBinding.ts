import type { OutboundMessage, OutboundTransport, TransportResult } from "./types";

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
    const result = await this.binding.send({
      from: message.from,
      to: message.to,
      cc: message.cc.length ? message.cc : undefined,
      bcc: message.bcc.length ? message.bcc : undefined,
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers && Object.keys(message.headers).length ? message.headers : undefined,
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
