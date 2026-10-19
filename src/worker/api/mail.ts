import { parseAddressList, toListItem, type NativeMessageRow } from "../providers/native";
import { messagePreview } from "../email/textHtml";
import PostalMime from "postal-mime";
import { HTML_VERSION, sanitizeEmailHtml } from "../email/html";
import { contentIdOf, safeFilename } from "../email/receive";
import { listUnsubscribeUrl } from "../email/unsubscribe";
import { resolveProvider } from "../providers/registry";
import { gmailAttachment, gmailFullMessage, gmailThread } from "../providers/gmailProvider";
import type { MailFolder, ProviderMutation } from "../providers/types";

type Folder = "inbox" | "junk" | "starred" | "sent" | "drafts" | "archive" | "trash";
type MessageRow = NativeMessageRow & {
  cc_addresses: string;
  bcc_addresses: string;
  body_text: string | null;
  body_html: string | null;
  raw_r2_key: string | null;
  in_reply_to: string | null;
  reference_ids: string | null;
  delivery_error: string | null;
  html_version: number;
};
type DraftListRow = { id: string; thread_id: string | null; to_addresses: string; subject: string; body_text: string; updated_at: string };
type AttachmentRow = { id: string; message_id: string; filename: string; content_type: string; size: number; r2_key: string; content_id: string | null };

const folders = new Set<Folder>(["inbox", "junk", "starred", "sent", "drafts", "archive", "trash"]);
const INLINE_DOWNLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** Raster types an email may embed (cid:); the preview endpoint serves exactly these images. */
const EMBEDDABLE_IMAGE_TYPES = INLINE_DOWNLOAD_TYPES;
const MAX_RECOVERED_HTML = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const folderFrom = (value: string | null): Folder => value && folders.has(value as Folder) ? value as Folder : "inbox";


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

/**
 * Received mail stored in an older HTML format (or without HTML) is rebuilt
 * once from its raw message: remote image addresses come back (shown through
 * the image proxy) and attachments get their Content-IDs (embedded images).
 */
async function recoverStoredHtml(env: Env, row: MessageRow): Promise<MessageRow> {
  if (row.direction !== "inbound" || !row.raw_r2_key) return row;
  if (row.body_html !== null && (row.html_version ?? 1) >= HTML_VERSION) return row;
  try {
    const object = await env.MAIL.get(row.raw_r2_key);
    if (!object) return row;
    const raw = await object.arrayBuffer();
    const parsed = await new PostalMime({ maxNestingDepth: 30, maxHeadersSize: 256 * 1024 }).parse(raw);
    const bodyHtml = parsed.html ? truncateUtf8(sanitizeEmailHtml(parsed.html), MAX_RECOVERED_HTML) : "";
    // Stored attachments are the parsed ones, named and sized the same way.
    const contentIds = parsed.attachments.flatMap(attachment => {
      const contentId = contentIdOf(attachment.contentId);
      const size = typeof attachment.content === "string" ? new TextEncoder().encode(attachment.content).byteLength : attachment.content.byteLength;
      return contentId ? [{ contentId, filename: safeFilename(attachment.filename, "attachment"), size }] : [];
    });
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET body_html=?2, html_version=?3 WHERE id=?1").bind(row.id, bodyHtml, HTML_VERSION),
      ...contentIds.map(item => env.DB.prepare(
        "UPDATE attachments SET content_id=?4 WHERE id=(SELECT id FROM attachments WHERE message_id=?1 AND filename=?2 AND size=?3 AND content_id IS NULL LIMIT 1)",
      ).bind(row.id, item.filename, item.size, item.contentId)),
    ]);
    return { ...row, body_html: bodyHtml, html_version: HTML_VERSION };
  } catch {
    return row;
  }
}

/** Embedded images (cid:) point at their stored attachment; those are not listed as attachments. */
function resolveEmbeddedImages(html: string | null, attachments: AttachmentRow[], origin: string, accountId: string) {
  const embedded = new Set<string>();
  if (!html || !/cid:/i.test(html)) return { html, embedded };
  let next = html;
  for (const attachment of attachments) {
    if (!attachment.content_id || !EMBEDDABLE_IMAGE_TYPES.has(attachment.content_type)) continue;
    const url = `${origin}/api/attachment-previews/${encodeURIComponent(attachment.id)}?accountId=${encodeURIComponent(accountId)}`;
    for (const id of new Set([attachment.content_id, encodeURIComponent(attachment.content_id)])) {
      const pattern = new RegExp(`cid:${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=["'\\s>)])`, "gi");
      if (pattern.test(next)) {
        next = next.replace(pattern, url);
        embedded.add(attachment.id);
      }
    }
  }
  return { html: next, embedded };
}

/** Read only a bounded MIME header prefix from R2, including old stored messages. */
async function nativeUnsubscribeUrl(env: Env, key: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    const object = await env.MAIL.get(key, { range: { offset: 0, length: 64 * 1024 } });
    if (!object) return null;
    const prefix = new TextDecoder().decode(await object.arrayBuffer());
    const boundary = prefix.search(/\r?\n\r?\n/);
    if (boundary < 0) return null;
    const headers = prefix.slice(0, boundary);
    const match = headers.match(/^list-unsubscribe:[ \t]*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/im);
    return listUnsubscribeUrl(match?.[1]?.replace(/\r?\n[ \t]+/g, " ") ?? null);
  } catch {
    return null;
  }
}

function toDraftListItem(row: DraftListRow, primary: string) {
  return {
    id: row.id,
    threadId: row.thread_id ?? row.id,
    direction: "outbound" as const,
    fromAddress: primary,
    fromName: "You",
    toAddresses: parseAddressList(row.to_addresses),
    subject: row.subject,
    preview: messagePreview(row.body_text),
    receivedAt: row.updated_at,
    sentAt: null,
    isRead: true,
    isStarred: false,
    isArchived: false,
    isDeleted: false,
    isJunk: false,
    hasAttachments: false,
    deliveryStatus: "draft",
    isDraft: true,
  };
}

async function mailboxCounts(env: Env, accountId: string) {
  const [unread, drafts] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id=?1 AND direction='inbound' AND is_archived=0 AND is_deleted=0 AND is_junk=0 AND is_read=0").bind(accountId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM drafts WHERE mailbox_id=?1").bind(accountId).first<{ count: number }>(),
  ]);
  return { unreadCount: unread?.count ?? 0, draftCount: drafts?.count ?? 0 };
}

async function requestedProvider(request: Request, env: Env) {
  return resolveProvider(env, new URL(request.url).searchParams.get("accountId"));
}

export async function listMessages(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folder = folderFrom(url.searchParams.get("folder"));
  const search = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 200);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 50;

  const provider = await resolveProvider(env, url.searchParams.get("accountId"));
  if (!provider) return Response.json({ error: "Account not found or unavailable" }, { status: 404 });

  if (folder === "drafts") {
    let where = "mailbox_id = ?";
    const bindings: Array<string | number> = [provider.accountId];
    if (search) {
      where += " AND (LOWER(subject) LIKE ? OR LOWER(body_text) LIKE ? OR LOWER(to_addresses) LIKE ?)";
      const term = `%${search}%`;
      bindings.push(term, term, term);
    }
    bindings.push(limit);
    const [counts, result] = await Promise.all([
      mailboxCounts(env, provider.accountId),
      env.DB.prepare(`SELECT id,thread_id,to_addresses,subject,body_text,updated_at FROM drafts WHERE ${where} ORDER BY updated_at DESC LIMIT ?`)
        .bind(...bindings)
        .all<DraftListRow>(),
    ]);
    return Response.json({ folder, ...counts, accountId: provider.accountId, messages: result.results.map((row) => toDraftListItem(row, provider.address)) });
  }

  const [counts, messages, trashTotal] = await Promise.all([
    mailboxCounts(env, provider.accountId),
    provider.listMessages({ folder: folder as MailFolder, search, limit }),
    folder === "trash" && provider.kind === "native"
      ? env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id=?1 AND is_deleted=1")
        .bind(provider.accountId).first<{count:number}>()
      : Promise.resolve(null),
  ]);
  return Response.json({ folder, ...counts, folderTotalCount: trashTotal?.count ?? null, accountId: provider.accountId, messages });
}

function detailFrom(row: MessageRow, attachments: AttachmentRow[], unsubscribeUrl: string | null = null, images?: { origin: string; accountId: string }) {
  const resolved = images ? resolveEmbeddedImages(row.body_html, attachments, images.origin, images.accountId) : { html: row.body_html, embedded: new Set<string>() };
  return {
    ...toListItem(row),
    ccAddresses: parseAddressList(row.cc_addresses),
    bccAddresses: parseAddressList(row.bcc_addresses),
    bodyText: row.body_text ?? row.preview,
    bodyHtml: resolved.html || null,
    bodyHtmlAvailable: Boolean(row.body_html),
    inReplyTo: row.in_reply_to,
    references: row.reference_ids,
    deliveryError: row.delivery_error,
    unsubscribeUrl,
    attachments: attachments.filter(attachment => !resolved.embedded.has(attachment.id)).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      size: attachment.size,
    })),
  };
}

export async function getMessage(request: Request, id: string, env: Env): Promise<Response> {
  const provider = await requestedProvider(request, env);
  if (!provider) return Response.json({ error: "Account not found or unavailable" }, { status: 404 });

  if (provider.kind === "gmail") {
    try {
      const url = new URL(request.url);
      const hintedThreadId = url.searchParams.get("threadId")?.trim();
      let thread;
      if (hintedThreadId) {
        thread = await gmailThread(env, provider.accountId, hintedThreadId, false);
      } else {
        const initial = await gmailFullMessage(env, provider.accountId, id, false);
        thread = await gmailThread(env, provider.accountId, initial.threadId, false);
      }
      const current = thread.find((message) => message.id === id);
      if (!current) return Response.json({ error: "Message not found" }, { status: 404 });
      const newlyReadCount = current.isRead ? 0 : 1;
      if (newlyReadCount) await provider.patchMessage(id, { isRead: true });
      const message = newlyReadCount ? { ...current, isRead: true } : current;
      const updatedThread = newlyReadCount
        ? thread.map((entry) => entry.id === id ? message : entry)
        : thread;
      return Response.json({ message, thread: updatedThread, newlyReadCount, accountId: provider.accountId });
    } catch {
      return Response.json({ error: "Message not found or Gmail is unavailable" }, { status: 404 });
    }
  }

  const initialRow = await env.DB.prepare(`SELECT id,thread_id,direction,from_address,from_name,to_addresses,cc_addresses,bcc_addresses,subject,preview,body_text,body_html,received_at,sent_at,is_read,is_starred,is_archived,is_deleted,is_junk,has_attachments,raw_r2_key,in_reply_to,reference_ids,delivery_status,delivery_error,html_version FROM messages WHERE id=?1 AND mailbox_id=?2`)
    .bind(id, provider.accountId)
    .first<MessageRow>();
  if (!initialRow) return Response.json({ error: "Message not found" }, { status: 404 });
  const row = await recoverStoredHtml(env, initialRow);

  // Opening a conversation reads all of it. newlyReadCount reports only the
  // messages the unread badge counts (inbox mail), so the client can adjust it.
  const unread = await env.DB.prepare("SELECT COUNT(*) AS count, SUM(CASE WHEN is_archived=0 AND is_deleted=0 AND is_junk=0 THEN 1 ELSE 0 END) AS counted FROM messages WHERE thread_id=?1 AND mailbox_id=?2 AND direction='inbound' AND is_read=0")
    .bind(row.thread_id, provider.accountId)
    .first<{ count: number; counted: number | null }>();
  const newlyReadCount = unread?.counted ?? 0;
  if ((unread?.count ?? 0) > 0) {
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET is_read=1 WHERE thread_id=?1 AND mailbox_id=?2 AND direction='inbound' AND is_read=0").bind(row.thread_id, provider.accountId),
      env.DB.prepare("UPDATE threads SET is_read=1 WHERE id=?1 AND mailbox_id=?2").bind(row.thread_id, provider.accountId),
    ]);
  }

  const threadRows = await env.DB.prepare(`SELECT id,thread_id,direction,from_address,from_name,to_addresses,cc_addresses,bcc_addresses,subject,preview,body_text,body_html,received_at,sent_at,is_read,is_starred,is_archived,is_deleted,is_junk,has_attachments,raw_r2_key,in_reply_to,reference_ids,delivery_status,delivery_error,html_version FROM messages WHERE thread_id=?1 AND mailbox_id=?2 ORDER BY COALESCE(sent_at,received_at) ASC LIMIT 100`)
    .bind(row.thread_id, provider.accountId)
    .all<MessageRow>();
  // Older messages of the conversation are rebuilt too (a few per open), after the
  // opened one, so every message shows its images.
  let rebuilds = 10;
  const rows = [];
  for (const entry of threadRows.results) {
    rows.push(entry.id === row.id ? row : rebuilds > 0 && (entry.html_version ?? 1) < HTML_VERSION && entry.direction === "inbound"
      ? (rebuilds--, await recoverStoredHtml(env, entry))
      : entry);
  }
  const ids = rows.map((entry) => entry.id);
  const attachmentMap = new Map<string, AttachmentRow[]>();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const attachments = await env.DB.prepare(`SELECT id,message_id,filename,content_type,size,r2_key,content_id FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`)
      .bind(...ids)
      .all<AttachmentRow>();
    for (const attachment of attachments.results) {
      attachmentMap.set(attachment.message_id, [...(attachmentMap.get(attachment.message_id) ?? []), attachment]);
    }
  }
  const unsubscribeUrl = row.direction === "inbound" ? await nativeUnsubscribeUrl(env, row.raw_r2_key) : null;
  const images = { origin: new URL(request.url).origin, accountId: provider.accountId };
  const thread = rows.map((entry) => detailFrom(entry, attachmentMap.get(entry.id) ?? [], entry.id === id ? unsubscribeUrl : null, images));
  const message = thread.find((entry) => entry.id === id);
  return message
    ? Response.json({ message, thread, newlyReadCount, accountId: provider.accountId })
    : Response.json({ error: "Message not found" }, { status: 404 });
}

export async function patchMessage(request: Request, id: string, env: Env): Promise<Response> {
  const provider = await requestedProvider(request, env);
  if (!provider) return Response.json({ error: "Account not found or unavailable" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = await request.json<Record<string, unknown>>();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const mutation: ProviderMutation = {};
  for (const key of ["isRead", "isStarred", "isArchived", "isDeleted", "isJunk"] as const) {
    if (typeof body[key] === "boolean") mutation[key] = body[key];
  }
  if (!Object.keys(mutation).length) return Response.json({ error: "No supported fields supplied" }, { status: 400 });
  const scope = body.scope;
  if (scope !== undefined && scope !== "thread") {
    return Response.json({ error: "Invalid message mutation scope" }, { status: 400 });
  }
  const threadMutation = Object.keys(mutation).length === 1 &&
    (["isDeleted", "isArchived", "isJunk"] as const).find(key => typeof mutation[key] === "boolean");
  if (scope === "thread" && !threadMutation) {
    return Response.json({ error: "Only deleting, archiving or moving a conversation to Junk is supported" }, { status: 400 });
  }
  const changed = scope === "thread" && threadMutation
    ? await provider.patchThread(id, { [threadMutation]: mutation[threadMutation] })
    : await provider.patchMessage(id, mutation);
  return changed
    ? Response.json({ ok: true, accountId: provider.accountId })
    : Response.json({ error: "Message not found" }, { status: 404 });
}

export async function downloadAttachment(request: Request, id: string, env: Env): Promise<Response> {
  const provider = await requestedProvider(request, env);
  if (!provider) return Response.json({ error: "Account not found or unavailable" }, { status: 404 });

  if (provider.kind === "gmail") {
    const query = new URL(request.url).searchParams;
    const messageId = query.get("messageId")?.trim();
    if (!messageId) return Response.json({ error: "Message id is required" }, { status: 400 });
    try {
      const attachment = await gmailAttachment(env, provider.accountId, messageId, id, query.get("partId"));
      const inline = INLINE_DOWNLOAD_TYPES.has(attachment.contentType);
      return new Response(attachment.data, {
        headers: {
          "Content-Type": inline ? attachment.contentType : "application/octet-stream",
          "Content-Length": String(attachment.data.byteLength),
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    } catch {
      return Response.json({ error: "Attachment not found or unavailable" }, { status: 404 });
    }
  }

  const attachment = await env.DB.prepare("SELECT id,message_id,filename,content_type,size,r2_key,content_id FROM attachments WHERE id=?1")
    .bind(id)
    .first<AttachmentRow>();
  if (!attachment || !(await provider.getMessage(attachment.message_id))) {
    return Response.json({ error: "Attachment not found" }, { status: 404 });
  }
  const object = await env.MAIL.get(attachment.r2_key);
  if (!object) return Response.json({ error: "Attachment data is unavailable" }, { status: 404 });
  const inline = INLINE_DOWNLOAD_TYPES.has(attachment.content_type);
  return new Response(object.body, {
    headers: {
      "Content-Type": inline ? attachment.content_type : "application/octet-stream",
      "Content-Length": String(attachment.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
