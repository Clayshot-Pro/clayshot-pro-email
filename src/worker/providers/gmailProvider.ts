import { fromBase64Url, toBase64, toBase64Url } from "../bytes";
import { htmlToText, sanitizeEmailHtml } from "../email/html";
import { listUnsubscribeUrl } from "../email/unsubscribe";
import { getGoogleAccessToken } from "./googleCredentials";
import { gmailMatchesFolder } from "./gmailFolder";
import type { MailProvider, ProviderListOptions, ProviderMessage, ProviderMutation, ProviderSendInput, ProviderSendResult, ThreadMutation } from "./types";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_PARTS = 100;
const MAX_DEPTH = 20;
const MAX_ATTACHMENT = 4_000_000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_INLINE_IMAGE_BYTES = 1_500_000;
const MAX_INLINE_IMAGE_TOTAL = 3_000_000;
const MAX_INLINE_IMAGES = 8;
const METADATA_CONCURRENCY = 10;
const BODY_CONCURRENCY = 4;

type Header = { name?: string; value?: string };
type Part = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
};
type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
};

const enc = new TextEncoder();

const header = (message: GmailMessage, name: string) => message.payload?.headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
const partHeader = (part: Part, name: string) => part.headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
const addr = (value: string) => {
  const match = value.match(/^(.*?)\s*<([^>]+)>$/);
  return match
    ? { name: match[1].replace(/^"|"$/g, "").trim() || null, email: match[2].trim() }
    : { name: null, email: value.trim() };
};
const addresses = (value: string) => value.split(",").map((entry) => addr(entry).email).filter(Boolean);

function parts(part: Part | undefined, out: Part[] = [], depth = 0) {
  if (!part || depth > MAX_DEPTH || out.length >= MAX_PARTS) return out;
  if (part.mimeType?.startsWith("text/") || part.mimeType?.startsWith("image/") || part.filename || part.body?.attachmentId) out.push(part);
  for (const child of part.parts ?? []) parts(child, out, depth + 1);
  return out;
}


function truncateText(value: string, max = MAX_BODY_BYTES) {
  if (enc.encode(value).byteLength <= max) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (enc.encode(value.slice(0, mid)).byteLength <= max) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}

function item(message: GmailMessage): ProviderMessage {
  const labels = new Set(message.labelIds ?? []);
  const from = addr(header(message, "From"));
  const sent = labels.has("SENT");
  const date = new Date(Number(message.internalDate) || Date.now()).toISOString();
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? message.id ?? "",
    direction: sent ? "outbound" : "inbound",
    fromAddress: from.email,
    fromName: from.name,
    senderAvatarUrl: null,
    toAddresses: addresses(header(message, "To")),
    subject: header(message, "Subject") || "(no subject)",
    preview: message.snippet ?? "",
    receivedAt: date,
    sentAt: sent ? date : null,
    isRead: !labels.has("UNREAD"),
    isStarred: labels.has("STARRED"),
    isArchived: !labels.has("INBOX") && !labels.has("SENT") && !labels.has("TRASH") && !labels.has("SPAM"),
    isDeleted: labels.has("TRASH"),
    isJunk: labels.has("SPAM"),
    hasAttachments: parts(message.payload).some((part) => Boolean(part.filename && part.body?.attachmentId)),
    deliveryStatus: null,
    isDraft: false,
  };
}

async function mapLimit<T, R>(values: T[], concurrency: number, mapper: (value: T, index: number) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function clean(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}
const validHeader = (value: string) => /^[A-Za-z0-9-]{1,64}$/.test(value);
const quoted = (value: string) => `"${clean(value).replace(/["\\]/g, "\\$&")}"`;

function mime(input: ProviderSendInput, from: string) {
  const boundary = `ltm_${crypto.randomUUID().replace(/-/g, "")}`;
  const lines = [`From: ${clean(from)}`, `To: ${input.to.map(clean).join(", ")}`];
  if (input.cc.length) lines.push(`Cc: ${input.cc.map(clean).join(", ")}`);
  if (input.bcc.length) lines.push(`Bcc: ${input.bcc.map(clean).join(", ")}`);
  lines.push(`Subject: ${clean(input.subject)}`, "MIME-Version: 1.0");
  for (const [key, value] of Object.entries(input.headers ?? {})) if (validHeader(key)) lines.push(`${key}: ${clean(value)}`);
  if (!input.attachments.length) {
    lines.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", input.text);
    return lines.join("\r\n");
  }
  lines.push(
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text,
  );
  for (const attachment of input.attachments) {
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.type) ? attachment.type : "application/octet-stream";
    const data = toBase64(new Uint8Array(attachment.content)).replace(/.{1,76}/g, "$&\r\n").trimEnd();
    lines.push(
      `--${boundary}`,
      `Content-Type: ${type}; name=${quoted(attachment.filename)}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename=${quoted(attachment.filename)}`,
      "",
      data,
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

async function call(env: Env, accountId: string, path: string, init: RequestInit = {}) {
  const token = await getGoogleAccessToken(env, accountId);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(response.status === 401 ? "Gmail account requires reconnection" : "Gmail request failed");
  return response;
}

async function partBytes(env: Env, accountId: string, messageId: string, part: Part, maxBytes: number): Promise<Uint8Array | null> {
  try {
    if ((part.body?.size ?? 0) > maxBytes) return null;
    if (part.body?.data) {
      const bytes = fromBase64Url(part.body.data);
      return bytes.byteLength <= maxBytes ? bytes : null;
    }
    const attachmentId = part.body?.attachmentId;
    if (!attachmentId) return null;
    const response = await (await call(
      env,
      accountId,
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    )).json<{ data?: string; size?: number }>();
    if ((response.size ?? 0) > maxBytes || !response.data) return null;
    const bytes = fromBase64Url(response.data);
    return bytes.byteLength <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

async function partText(env: Env, accountId: string, messageId: string, part: Part | undefined): Promise<string> {
  if (!part) return "";
  const bytes = await partBytes(env, accountId, messageId, part, MAX_BODY_BYTES);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function resolveInlineImages(env: Env, accountId: string, messageId: string, message: GmailMessage, html: string) {
  const candidates = parts(message.payload)
    .filter((part) => part.mimeType?.startsWith("image/") && partHeader(part, "Content-ID"))
    .slice(0, MAX_INLINE_IMAGES);
  if (!candidates.length) return html;

  const loaded = await mapLimit(candidates, 3, async (part) => {
    const contentId = partHeader(part, "Content-ID").trim().replace(/^<|>$/g, "");
    const bytes = await partBytes(env, accountId, messageId, part, MAX_INLINE_IMAGE_BYTES);
    return contentId && bytes
      ? { contentId, mimeType: part.mimeType || "image/png", bytes }
      : null;
  });

  let total = 0;
  let next = html;
  for (const image of loaded) {
    if (!image || total + image.bytes.byteLength > MAX_INLINE_IMAGE_TOTAL) continue;
    total += image.bytes.byteLength;
    const dataUrl = `data:${image.mimeType};base64,${toBase64(image.bytes)}`;
    const ids = new Set([image.contentId, encodeURIComponent(image.contentId)]);
    for (const id of ids) next = next.replace(new RegExp(`cid:${regexEscape(id)}`, "gi"), dataUrl);
  }
  return next;
}

async function messageBody(env: Env, accountId: string, message: GmailMessage) {
  const messageId = message.id ?? "";
  const all = parts(message.payload);
  const plainPart = all.find((part) => part.mimeType === "text/plain" && (part.body?.data || part.body?.attachmentId));
  const htmlPart = all.find((part) => part.mimeType === "text/html" && (part.body?.data || part.body?.attachmentId));
  const [plain, rawHtml] = await Promise.all([
    partText(env, accountId, messageId, plainPart),
    partText(env, accountId, messageId, htmlPart),
  ]);

  const htmlWithInlineImages = rawHtml
    ? await resolveInlineImages(env, accountId, messageId, message, rawHtml)
    : "";
  const bodyHtml = htmlWithInlineImages ? truncateText(sanitizeEmailHtml(htmlWithInlineImages)) || null : null;
  const bodyText = truncateText((plain || (rawHtml ? htmlToText(rawHtml) : "")).replace(/\s+\n/g, "\n").trim());
  return { bodyText, bodyHtml };
}

const q = (folder: string) => folder === "inbox"
  ? "in:inbox"
  : folder === "junk"
    ? "in:spam"
  : folder === "starred"
    ? "is:starred"
    : folder === "sent"
      ? "in:sent"
      : folder === "trash"
        ? "in:trash"
        : folder === "archive"
          ? "-in:inbox -in:sent -in:trash -in:spam -in:drafts"
          : "";

export async function gmailFullMessage(env: Env, accountId: string, id: string, _includePhotos = false) {
  const raw = await (await call(env, accountId, `/messages/${encodeURIComponent(id)}?format=full`)).json<GmailMessage>();
  const base = item(raw);
  const body = await messageBody(env, accountId, raw);
  const attachments = parts(raw.payload)
    .filter((part) => part.filename && part.body?.attachmentId)
    .map((part) => ({
      id: part.body!.attachmentId!,
      filename: part.filename!,
      contentType: part.mimeType || "application/octet-stream",
      size: Math.max(0, part.body?.size ?? 0),
    }));
  return {
    ...base,
    ccAddresses: addresses(header(raw, "Cc")),
    bccAddresses: addresses(header(raw, "Bcc")),
    bodyText: body.bodyText || base.preview,
    bodyHtml: body.bodyHtml,
    bodyHtmlAvailable: Boolean(body.bodyHtml),
    inReplyTo: header(raw, "In-Reply-To") || null,
    references: header(raw, "References") || null,
    messageId: header(raw, "Message-ID") || null,
    unsubscribeUrl: listUnsubscribeUrl(header(raw, "List-Unsubscribe")),
    deliveryError: null,
    attachments,
  };
}

export async function gmailThread(env: Env, accountId: string, threadId: string, _includePhotos = false) {
  const thread = await (await call(env, accountId, `/threads/${encodeURIComponent(threadId)}?format=full`)).json<{ messages?: GmailMessage[] }>();
  const raw = (thread.messages ?? []).slice(-100);
  const bases = raw.map(item);
  return mapLimit(raw, BODY_CONCURRENCY, async (message, index) => {
    const base = bases[index];
    const body = await messageBody(env, accountId, message);
    return {
      ...base,
      ccAddresses: addresses(header(message, "Cc")),
      bccAddresses: addresses(header(message, "Bcc")),
      bodyText: body.bodyText || base.preview,
      bodyHtml: body.bodyHtml,
      bodyHtmlAvailable: Boolean(body.bodyHtml),
      inReplyTo: header(message, "In-Reply-To") || null,
      references: header(message, "References") || null,
      messageId: header(message, "Message-ID") || null,
      unsubscribeUrl: listUnsubscribeUrl(header(message, "List-Unsubscribe")),
      deliveryError: null,
      attachments: parts(message.payload)
        .filter((part) => part.filename && part.body?.attachmentId)
        .map((part) => ({
          id: part.body!.attachmentId!,
          filename: part.filename!,
          contentType: part.mimeType || "application/octet-stream",
          size: Math.max(0, part.body?.size ?? 0),
        })),
    };
  });
}

export async function gmailAttachment(env: Env, accountId: string, messageId: string, attachmentId: string) {
  const message = await (await call(env, accountId, `/messages/${encodeURIComponent(messageId)}?format=full`)).json<GmailMessage>();
  const part = parts(message.payload).find((entry) => entry.body?.attachmentId === attachmentId && entry.filename);
  if (!part || !part.filename) throw new Error("Attachment not found");
  if ((part.body?.size ?? 0) > MAX_ATTACHMENT) throw new Error("Attachment too large");
  const response = await (await call(env, accountId, `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`)).json<{ data?: string; size?: number }>();
  const data = response.data ? fromBase64Url(response.data) : new Uint8Array();
  if (data.byteLength > MAX_ATTACHMENT) throw new Error("Attachment too large");
  return { data, filename: part.filename, contentType: part.mimeType || "application/octet-stream" };
}

export function gmailProvider(env: Env, accountId: string, email: string): MailProvider {
  return {
    kind: "gmail",
    accountId,
    address: email,

    async listMessages(options: ProviderListOptions) {
      const query = [q(options.folder), options.search].filter(Boolean).join(" ");
      const listing = await (await call(
        env,
        accountId,
        `/messages?maxResults=${Math.min(options.limit, 50)}&q=${encodeURIComponent(query)}`,
      )).json<{ messages?: Array<{ id: string }> }>();
      const refs = listing.messages ?? [];
      const loaded = await mapLimit(refs, METADATA_CONCURRENCY, async (entry) => {
        try {
          const message = await (await call(
            env,
            accountId,
            `/messages/${encodeURIComponent(entry.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`,
          )).json<GmailMessage>();
          return gmailMatchesFolder(message.labelIds, options.folder) ? item(message) : null;
        } catch {
          return null;
        }
      });
      return loaded.filter((entry): entry is ProviderMessage => Boolean(entry));
    },

    async getMessage(id) {
      try {
        const message = await (await call(
          env,
          accountId,
          `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`,
        )).json<GmailMessage>();
        return item(message);
      } catch {
        return null;
      }
    },

    async patchMessage(id, mutation: ProviderMutation) {
      if (mutation.isDeleted !== undefined) {
        await call(env, accountId, `/messages/${encodeURIComponent(id)}/${mutation.isDeleted ? "trash" : "untrash"}`, { method: "POST" });
        return true;
      }
      const add: string[] = [];
      const remove: string[] = [];
      if (mutation.isRead !== undefined) (mutation.isRead ? remove : add).push("UNREAD");
      if (mutation.isStarred !== undefined) (mutation.isStarred ? add : remove).push("STARRED");
      if (mutation.isJunk !== undefined) {
        if (mutation.isJunk) {
          add.push("SPAM");
          remove.push("INBOX");
        } else {
          add.push("INBOX");
          remove.push("SPAM");
        }
      } else if (mutation.isArchived !== undefined) {
        (mutation.isArchived ? remove : add).push("INBOX");
      }
      await call(env, accountId, `/messages/${encodeURIComponent(id)}/modify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
      });
      return true;
    },

    async patchThread(id, mutation: ThreadMutation) {
      // The message lookup happens under this provider's already authorized
      // Gmail account. Never accept an unchecked thread ID from a request.
      const message = await (await call(
        env, accountId,
        "/messages/" + encodeURIComponent(id) + "?format=minimal",
      )).json<GmailMessage>();
      if (!message.threadId) return false;
      const thread = "/threads/" + encodeURIComponent(message.threadId);
      if (mutation.isDeleted !== undefined) {
        await call(env, accountId, thread + "/" + (mutation.isDeleted ? "trash" : "untrash"), { method: "POST" });
        return true;
      }
      const labels = mutation.isJunk !== undefined
        ? { addLabelIds: [mutation.isJunk ? "SPAM" : "INBOX"], removeLabelIds: [mutation.isJunk ? "INBOX" : "SPAM"] }
        : mutation.isArchived !== undefined
          ? { addLabelIds: mutation.isArchived ? [] : ["INBOX"], removeLabelIds: mutation.isArchived ? ["INBOX"] : [] }
          : null;
      if (!labels) return false;
      await call(env, accountId, thread + "/modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(labels),
      });
      return true;
    },

    async sendMessage(input: ProviderSendInput): Promise<ProviderSendResult> {
      if (input.attachments.reduce((total, attachment) => total + attachment.content.byteLength, 0) > MAX_ATTACHMENT) {
        throw new Error("Attachments too large");
      }
      const raw = toBase64Url(enc.encode(mime(input, email)));
      const body: Record<string, string> = { raw };
      if (input.threadId) body.threadId = input.threadId;
      const response = await (await call(env, accountId, "/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })).json<{ id?: string }>();
      return { providerMessageId: response.id ?? null };
    },
  };
}
