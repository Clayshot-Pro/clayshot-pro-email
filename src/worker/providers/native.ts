import type { MailProvider, ProviderListOptions, ProviderMessage, ProviderMutation, ProviderSendInput, ProviderSendResult } from "./types";
import { transportChoice, transportFor } from "../transports";
import { TransportError } from "../transports/types";

type NativeMessageRow = {
  id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  from_address: string;
  from_name: string | null;
  to_addresses: string;
  subject: string;
  preview: string;
  received_at: string;
  sent_at: string | null;
  is_read: number;
  is_starred: number;
  is_archived: number;
  is_deleted: number;
  is_junk: number;
  has_attachments: number;
  delivery_status: string | null;
};

const folderWhere = {
  inbox: "direction = 'inbound' AND is_archived = 0 AND is_deleted = 0 AND is_junk = 0",
  junk: "is_junk = 1 AND is_deleted = 0",
  starred: "is_starred = 1 AND is_deleted = 0 AND is_junk = 0",
  sent: "direction = 'outbound' AND is_archived = 0 AND is_deleted = 0",
  archive: "is_archived = 1 AND is_deleted = 0 AND is_junk = 0",
  trash: "is_deleted = 1",
} as const;

function parseAddresses(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toListItem(row: NativeMessageRow): ProviderMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    direction: row.direction,
    fromAddress: row.from_address,
    fromName: row.from_name,
    senderAvatarUrl: null,
    toAddresses: parseAddresses(row.to_addresses),
    subject: row.subject,
    preview: row.preview,
    receivedAt: row.received_at,
    sentAt: row.sent_at,
    isRead: Boolean(row.is_read),
    isStarred: Boolean(row.is_starred),
    isArchived: Boolean(row.is_archived),
    isDeleted: Boolean(row.is_deleted),
    isJunk: Boolean(row.is_junk),
    hasAttachments: Boolean(row.has_attachments),
    deliveryStatus: row.delivery_status,
    isDraft: false,
  };
}

export class NativeMailProvider implements MailProvider {
  readonly kind = "native" as const;
  constructor(private readonly env: Env, readonly accountId: string, readonly address: string, readonly senderName: string) {}

  async listMessages(options: ProviderListOptions): Promise<ProviderMessage[]> {
    let where: string = folderWhere[options.folder];
    const bindings: Array<string | number> = [this.accountId];
    where = `mailbox_id = ? AND (${where})`;
    if (options.search) {
      where += " AND (LOWER(subject) LIKE ? OR LOWER(from_address) LIKE ? OR LOWER(COALESCE(from_name, '')) LIKE ? OR LOWER(preview) LIKE ?)";
      const term = `%${options.search.toLowerCase().slice(0, 200)}%`;
      bindings.push(term, term, term, term);
    }
    bindings.push(Math.max(1, Math.min(100, Math.floor(options.limit))));
    const result = await this.env.DB.prepare(`SELECT id, thread_id, direction, from_address, from_name, to_addresses, subject, preview, received_at, sent_at, is_read, is_starred, is_archived, is_deleted, is_junk, has_attachments, delivery_status FROM messages WHERE ${where} ORDER BY COALESCE(sent_at, received_at) DESC LIMIT ?`)
      .bind(...bindings)
      .all<NativeMessageRow>();
    return result.results.map(toListItem);
  }

  async getMessage(id: string): Promise<ProviderMessage | null> {
    const row = await this.env.DB.prepare("SELECT id, thread_id, direction, from_address, from_name, to_addresses, subject, preview, received_at, sent_at, is_read, is_starred, is_archived, is_deleted, is_junk, has_attachments, delivery_status FROM messages WHERE id = ?1 AND mailbox_id = ?2 LIMIT 1")
      .bind(id, this.accountId)
      .first<NativeMessageRow>();
    return row ? toListItem(row) : null;
  }

  async patchMessage(id: string, mutation: ProviderMutation): Promise<boolean> {
    const mapping: Array<[keyof ProviderMutation, string]> = [
      ["isRead", "is_read"],
      ["isStarred", "is_starred"],
      ["isArchived", "is_archived"],
      ["isDeleted", "is_deleted"],
      ["isJunk", "is_junk"],
    ];
    const sets: string[] = [];
    const values: number[] = [];
    for (const [key, column] of mapping) {
      const value = mutation[key];
      if (typeof value === "boolean") {
        sets.push(`${column} = ?`);
        values.push(value ? 1 : 0);
      }
    }
    if (!sets.length) return false;
    const result = await this.env.DB.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ? AND mailbox_id = ?`)
      .bind(...values, id, this.accountId)
      .run();
    return Boolean(result.meta.changes);
  }

  async patchThread(id: string, isDeleted: boolean): Promise<boolean> {
    // Resolve the thread from an authenticated mailbox-owned message, never
    // from an arbitrary client-provided thread identifier.
    const message = await this.env.DB.prepare(
      "SELECT thread_id FROM messages WHERE id=?1 AND mailbox_id=?2"
    ).bind(id, this.accountId).first<{ thread_id: string }>();
    if (!message) return false;
    const result = await this.env.DB.prepare(
      "UPDATE messages SET is_deleted=?1 WHERE mailbox_id=?2 AND thread_id=?3"
    ).bind(isDeleted ? 1 : 0, this.accountId, message.thread_id).run();
    return Boolean(result.meta.changes);
  }

  async sendMessage(input: ProviderSendInput): Promise<ProviderSendResult> {
    const choice = await transportChoice(this.env, this.accountId, this.address);
    const transport = transportFor(this.env, choice);
    if (!transport) throw new TransportError("E_SENDER_DOMAIN_NOT_AVAILABLE");
    const result = await transport.send({
      from: { email: this.address, name: this.senderName },
      replyTo: this.address,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: `<div style="white-space:pre-wrap;font-family:Arial,sans-serif">${input.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replace(/\n/g, "<br>")}</div>`,
      headers: input.headers,
      attachments: input.attachments,
      idempotencyKey: input.idempotencyKey,
    });
    return { providerMessageId: result.providerMessageId, transport: transport.kind };
  }
}

export function nativeProvider(env: Env, id: string, address: string, senderName: string) {
  return new NativeMailProvider(env, id, address, senderName);
}
