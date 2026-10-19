import { junkVerdict } from "./junk";
import { mailboxForRecipient, ADMIN_MAILBOX_ID } from "../mailboxes";
import PostalMime from "postal-mime";
import { sendNewMailPush } from "../push";
import { htmlToText, sanitizeEmailHtml } from "./html";
import { domainOf } from "../appConfig";
import { instanceSettings } from "../branding";
import { isBlockedSender } from "../blockedSenders";

const MAX_RAW_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 30;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_STORED_TEXT = 2 * 1024 * 1024;
/** HTML beyond this is cut before any parsing (the stored copy is capped at 2 MB anyway). */
const MAX_HTML_CHARS = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_MIME_DEPTH = 30;

const encoder = new TextEncoder();

/** The mailbox has sent mail to this address (its contacts skip content scoring). */
async function hasWrittenTo(env: Env, mailboxId: string, address: string): Promise<boolean> {
  const needle = JSON.stringify(address.trim().toLowerCase());
  if (needle.length < 5) return false;
  const row = await env.DB.prepare(`SELECT 1 FROM messages WHERE mailbox_id = ?1 AND direction = 'outbound'
    AND instr(lower(to_addresses), ?2) > 0 LIMIT 1`).bind(mailboxId, needle).first().catch(() => null);
  return Boolean(row);
}
const safePreview = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 240);
// Control characters and path separators become "_"; Unicode direction
// overrides are dropped so "invoice\u202Efdp.exe" cannot pose as a PDF.
export const safeFilename = (value: string | null | undefined, fallback: string) => (value || fallback)
  .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
  .replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 255) || fallback;
const addresses = (items: Array<{ address?: string }> | undefined) => (items ?? []).map(item => item.address?.trim()).filter((value): value is string => Boolean(value)).slice(0, 100);


function contentBytes(content: string | ArrayBuffer | Uint8Array<ArrayBufferLike>): Uint8Array {
  if (typeof content === "string") return encoder.encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, mid)).byteLength <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}

function referenceCandidates(inReplyTo: string | null, references: string | null): string[] {
  const refs = references?.match(/<[^>]+>/g) ?? references?.split(/\s+/) ?? [];
  return [...new Set([inReplyTo, ...refs].filter((value): value is string => Boolean(value)))].reverse().slice(0, 30);
}

/** Subject without reply/forward prefixes, for matching a reply to what it answers. */
export const baseSubject = (subject: string | null | undefined) =>
  (subject ?? "").trim().replace(/^(?:\s*(?:re|fwd?|aw|sv|wg)\s*(?:\[\d{1,3}\])?\s*:)+/i, "").trim().toLowerCase();

type ThreadMatch = { threadId: string; learned: { id: string; messageId: string } | null };

export async function resolveThreadId(env: Env, mailboxId: string, inReplyTo: string | null, references: string | null,
  sender: string, subject: string): Promise<ThreadMatch> {
  for (const candidate of referenceCandidates(inReplyTo, references)) {
    const match = await env.DB.prepare("SELECT thread_id FROM messages WHERE mailbox_id = ?1 AND (original_message_id = ?2 OR message_id = ?2) LIMIT 1").bind(mailboxId, candidate).first<{ thread_id: string }>();
    if (match) return { threadId: match.thread_id, learned: null };
  }
  // Some transports (the Cloudflare REST API) do not report the Message-ID
  // they gave a sent message. A reply to it names that ID in In-Reply-To:
  // match it to the recent sent message to this sender with the same subject
  // whose ID is unknown, and remember the ID for the rest of the conversation.
  const answered = /^<[^\s<>@]{1,450}@[^\s<>@]{1,450}>$/.test(inReplyTo ?? "") ? inReplyTo! : null;
  const base = baseSubject(subject);
  if (answered && base && sender) {
    const sent = await env.DB.prepare(`SELECT id, thread_id, subject FROM messages
      WHERE mailbox_id = ?1 AND direction = 'outbound' AND message_id IS NULL AND delivery_status IN ('sent', 'delivered', 'delayed')
        AND sent_at >= ?2 AND EXISTS (SELECT 1 FROM json_each(messages.to_addresses) WHERE LOWER(json_each.value) = ?3)
      ORDER BY sent_at DESC LIMIT 20`)
      .bind(mailboxId, new Date(Date.now() - 30 * 86_400_000).toISOString(), sender.trim().toLowerCase())
      .all<{ id: string; thread_id: string; subject: string }>();
    const match = sent.results.find(row => baseSubject(row.subject) === base);
    if (match) return { threadId: match.thread_id, learned: { id: match.id, messageId: answered } };
  }
  return { threadId: crypto.randomUUID(), learned: null };
}

function reject(message: ForwardableEmailMessage, reason: string): void {
  message.setReject(reason.slice(0, 100));
}

export async function receiveEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  const mailbox = await mailboxForRecipient(env, message.to);
  if (!mailbox) {
    reject(message, "Unknown or disabled mailbox");
    return;
  }
  if (message.rawSize > MAX_RAW_BYTES) {
    reject(message, "Message exceeds the maximum accepted size");
    return;
  }

  let raw: ArrayBuffer;
  try {
    raw = await new Response(message.raw).arrayBuffer();
  } catch {
    reject(message, "Message could not be read");
    return;
  }
  if (raw.byteLength > MAX_RAW_BYTES) {
    reject(message, "Message exceeds the maximum accepted size");
    return;
  }

  let parsed: Awaited<ReturnType<PostalMime["parse"]>>;
  try {
    parsed = await new PostalMime({ maxNestingDepth: MAX_MIME_DEPTH, maxHeadersSize: MAX_HEADER_BYTES }).parse(raw);
  } catch {
    reject(message, "Message MIME could not be parsed");
    return;
  }

  const parsedAttachments = parsed.attachments.map(attachment => ({ attachment, bytes: contentBytes(attachment.content) }));
  if (parsedAttachments.length > MAX_ATTACHMENTS || parsedAttachments.some(({ bytes }) => bytes.byteLength > MAX_ATTACHMENT_BYTES)) {
    reject(message, "Message contains too many or oversized attachments");
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const headerMessageId = (parsed.messageId?.trim() || message.headers.get("message-id")?.trim() || `<${id}@${domainOf(mailbox.email_address)}>`).slice(0, 998);
  // Delivery retries may reuse the same SMTP envelope/MIME, but two real
  // messages can share a sender-supplied RFC Message-ID. Dedup by MIME+recipient
  // over a short retention window, not by Message-ID.
  const contentDigest = await crypto.subtle.digest("SHA-256", raw);
  const contentHex = Array.from(new Uint8Array(contentDigest), b => b.toString(16).padStart(2, "0")).join("");
  const envelopeDigest = await crypto.subtle.digest(
    "SHA-256", encoder.encode(`${message.to.trim().toLowerCase()}:${contentHex}`),
  );
  const fingerprint = Array.from(new Uint8Array(envelopeDigest), b => b.toString(16).padStart(2, "0")).join("");
  // Everything that only reads or computes happens before the delivery is
  // claimed, so a slow or failing step can never leave a claim behind.
  const storedMessageId = null; // RFC IDs go to original_message_id (the legacy column is globally unique).
  const inReplyTo = (parsed.inReplyTo?.trim() || message.headers.get("in-reply-to")?.trim() || null)?.slice(0, 998) || null;
  const references = (parsed.references?.trim() || message.headers.get("references")?.trim() || null)?.slice(0, 8192) || null;
  const sender = parsed.from;
  const to = addresses(parsed.to);
  const cc = addresses(parsed.cc);
  const html = parsed.html ? parsed.html.slice(0, MAX_HTML_CHARS) : null;
  const bodyText = truncateUtf8(parsed.text?.trim() || (html ? htmlToText(html) : ""), MAX_STORED_TEXT);
  // Blocked senders (header From or envelope) and likely spam go to Junk.
  const fromAddress = sender?.address || message.from;
  const isJunk = await isBlockedSender(env, mailbox.id, [sender?.address, message.from])
    || (mailbox.spam_filter_enabled === 1 && junkVerdict({
      subject: parsed.subject ?? "",
      sender: fromAddress,
      senderName: sender?.name,
      replyTo: parsed.replyTo?.[0]?.address,
      text: bodyText,
      html,
      headers: message.headers,
      authenticationHeaders: parsed.headers.filter(header => /^(?:arc-)?authentication-results$/.test(header.key)),
      knownSender: await hasWrittenTo(env, mailbox.id, fromAddress),
    }).junk);
  const bodyHtml = html ? truncateUtf8(sanitizeEmailHtml(html), MAX_STORED_TEXT) || null : null;
  const { threadId, learned } = await resolveThreadId(env, mailbox.id, inReplyTo, references, fromAddress, parsed.subject ?? "");

  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO inbound_receipts(mailbox_id,fingerprint,state) VALUES (?1,?2,'pending')"
  ).bind(mailbox.id, fingerprint).run();
  if (!claim.meta.changes) {
    const recovered = await env.DB.prepare(
      "UPDATE inbound_receipts SET first_seen_at=CURRENT_TIMESTAMP WHERE mailbox_id=?1 AND fingerprint=?2 AND state='pending' AND first_seen_at<=datetime('now','-15 minutes')"
    ).bind(mailbox.id,fingerprint).run();
    if (!recovered.meta.changes) {
      const existing = await env.DB.prepare("SELECT state FROM inbound_receipts WHERE mailbox_id=?1 AND fingerprint=?2")
        .bind(mailbox.id, fingerprint).first<{ state: string }>();
      // Already stored: a duplicate delivery is accepted and dropped.
      if (existing?.state === "accepted") return;
      // Another delivery of this message is still in progress: fail
      // temporarily so the sender retries, never report success unstored.
      throw new Error("Delivery of this message is already in progress");
    }
  }
  const releaseClaim = () => env.DB.prepare("DELETE FROM inbound_receipts WHERE mailbox_id=?1 AND fingerprint=?2 AND state='pending'")
    .bind(mailbox.id, fingerprint).run();
  const key = `emails/${mailbox.id.replace(":", "_")}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}/${id}/raw.eml`;
  const rows: Array<{ id: string; filename: string; mimeType: string; size: number; key: string }> = [];

  // Reserve the raw MIME plus extracted attachment bytes before writing to
  // R2. A conditional D1 update is atomic across concurrent deliveries.
  const storageBytes = raw.byteLength + parsedAttachments.reduce((sum, part) => sum + part.bytes.byteLength, 0);
  let quotaReservation;
  try {
    quotaReservation = await env.DB.prepare(
      "UPDATE native_mailboxes SET used_bytes = used_bytes + ?1, usage_version = usage_version + 1 WHERE id = ?2 AND status = 'active' AND used_bytes + ?1 <= quota_bytes"
    ).bind(storageBytes, mailbox.id).run();
  } catch (error) {
    await releaseClaim().catch(() => undefined);
    throw error;
  }
  if (!quotaReservation.meta.changes) {
    await releaseClaim();
    reject(message, "Mailbox storage quota exceeded");
    return;
  }

  try {
    await env.MAIL.put(key, raw, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { messageId: headerMessageId.slice(0, 512) } });
    for (const { attachment, bytes } of parsedAttachments) {
      const attachmentId = crypto.randomUUID();
      const attachmentKey = `${key.slice(0, -7)}attachments/${attachmentId}`;
      const mimeType = (attachment.mimeType || "application/octet-stream").slice(0, 127);
      await env.MAIL.put(attachmentKey, bytes, { httpMetadata: { contentType: mimeType } });
      rows.push({ id: attachmentId, filename: safeFilename(attachment.filename, "attachment"), mimeType, size: bytes.byteLength, key: attachmentKey });
    }
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO threads (id, subject, latest_message_at, message_count, is_read, mailbox_id) VALUES (?1, ?2, ?3, 0, 0, ?4)").bind(threadId, (parsed.subject || "(no subject)").slice(0, 998), nowIso, mailbox.id),
      env.DB.prepare(`INSERT INTO messages (id,message_id,original_message_id,mailbox_id,thread_id,direction,from_address,from_name,to_addresses,cc_addresses,subject,preview,body_text,body_html,received_at,has_attachments,raw_r2_key,in_reply_to,reference_ids,delivery_status,is_junk) VALUES (?1,?2,?3,?4,?5,'inbound',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,'received',?19)`).bind(id, storedMessageId, headerMessageId, mailbox.id, threadId, (sender?.address || message.from).slice(0, 320), sender?.name?.slice(0, 320) || null, JSON.stringify(to.length ? to : [message.to]), JSON.stringify(cc), (parsed.subject || "(no subject)").slice(0, 998), safePreview(bodyText), bodyText, bodyHtml, nowIso, rows.length ? 1 : 0, key, inReplyTo, references, Number(isJunk)),
      ...rows.map(attachment => env.DB.prepare("INSERT INTO attachments (id,message_id,filename,content_type,size,r2_key) VALUES (?1,?2,?3,?4,?5,?6)").bind(attachment.id, id, attachment.filename, attachment.mimeType, attachment.size, attachment.key)),
      env.DB.prepare("UPDATE threads SET latest_message_at=?2,message_count=message_count+1,is_read=0,subject=CASE WHEN subject='' THEN ?3 ELSE subject END WHERE id=?1 AND mailbox_id=?4").bind(threadId, nowIso, (parsed.subject || "(no subject)").slice(0, 998), mailbox.id),
      ...(learned ? [env.DB.prepare("UPDATE messages SET message_id=?3 WHERE id=?1 AND mailbox_id=?2 AND message_id IS NULL").bind(learned.id, mailbox.id, learned.messageId)] : []),
      env.DB.prepare("UPDATE inbound_receipts SET state='accepted',message_id=?3 WHERE mailbox_id=?1 AND fingerprint=?2 AND state='pending'").bind(mailbox.id,fingerprint,id),
    ]);
  } catch {
    await Promise.allSettled([
      env.MAIL.delete(key),
      ...rows.map(row => env.MAIL.delete(row.key)),
      env.DB.prepare("UPDATE native_mailboxes SET used_bytes = MAX(0, used_bytes - ?1), usage_version = usage_version + 1 WHERE id = ?2")
        .bind(storageBytes, mailbox.id).run(),
      releaseClaim(),
    ]);
    reject(message, "Message could not be stored");
    return;
  }

  if (!isJunk) ctx.waitUntil(sendNewMailPush(env, {
    id,
    subject: parsed.subject || "(no subject)",
    fromAddress: sender?.address || message.from,
    fromName: sender?.name || null,
    toAddress: message.to,
    preview: safePreview(bodyText),
  }));
  const forwardTo = (await instanceSettings(env)).mail.forwardTo;
  // Forwarding (Admin → Mail settings) applies to the admin mailbox.
  if (forwardTo && mailbox.id === ADMIN_MAILBOX_ID && !isJunk) ctx.waitUntil(message.forward(forwardTo));
}
