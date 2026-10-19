import { releaseMailboxBytes, reserveMailboxBytes } from "../mailboxQuota";
import type { ProviderAttachment } from "../providers/types";
import { forwardSubject, replySubject } from "../../client/mailUtils";
import { checkAuthRateLimit } from "../security";
import { resolveProvider } from "../providers/registry";
import { gmailAttachment, gmailFullMessage } from "../providers/gmailProvider";
import { messagePreview, textToHtml } from "./textHtml";
import { fitsCloudflareApi } from "../transports/cloudflareApi";
import { transportChoice } from "../transports";
import { SAFE_DELIVERY_CODES, TransportError } from "../transports/types";

type ReplyTarget = {
  id: string;
  message_id: string | null;
  thread_id: string;
  reference_ids: string | null;
  subject: string;
};

type ForwardTarget = {
  id: string;
  subject: string;
};

type StoredAttachment = {
  filename: string;
  content_type: string;
  r2_key: string;
};

type Upload = ProviderAttachment;

const MAX_ATTACHMENT_BYTES = 4_000_000;
const MAX_BODY_CHARS = 500_000;
const MAX_SUBJECT_CHARS = 500;
const MAX_RECIPIENTS = 50;
// A bare address only (no display name, brackets, quotes or trailing dot), so
// suppression checks always compare the address the transport will use.
export const EMAIL_PATTERN = /^[^\s@<>"(),;:\\]+@[^\s@<>"'(),;:\\]+\.[^\s@<>"'(),;:\\.]+$/;

function splitRecipients(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      value
        .split(/[;,\n]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function safeDeliveryError(error: unknown): string {
  const code = error instanceof Error
    ? (error as Error & { code?: string }).code
    : undefined;
  return code && SAFE_DELIVERY_CODES.has(code)
    ? code
    : "EMAIL_DELIVERY_FAILED";
}

function userDeliveryError(code: string): string {
  if (code === "E_DELIVERY_UNCERTAIN") return "Delivery status is uncertain. Check Sent before trying again";
  if (code === "E_SENDER_DOMAIN_NOT_AVAILABLE") return "This mailbox's domain is not set up for sending";
  if (code === "E_EMAIL_API_NOT_CONFIGURED") return "Email Sending API credentials are not configured";
  if (code === "E_EMAIL_API_AUTH_FAILED" || code === "E_EMAIL_API_FORBIDDEN") {
    return "Cloudflare Email Sending API credentials are invalid or lack Email Sending permission";
  }
  if (code === "E_EMAIL_SERVICE_NOT_ENTITLED" || code === "E_EMAIL_SENDING_DISABLED") {
    return "Cloudflare Email Sending is not enabled for this account or domain";
  }
  if (code === "E_EMAIL_DELIVERY_UNKNOWN") return "Email delivery status is unknown. Check sent activity before retrying";
  if (code === "E_RECIPIENT_SUPPRESSED") {
    return "Recipient cannot currently receive this email";
  }
  if (code === "E_SENDER_NOT_VERIFIED") {
    return "This sender domain is not enabled or verified for Cloudflare Email Sending";
  }
  if (code === "E_RECIPIENT_NOT_ALLOWED") {
    return "Cloudflare sending is restricted to verified recipients. Configure an allowed sender address for this mailbox";
  }
  if (code === "E_CONTENT_TOO_LARGE") return "Email content is too large";
  if (code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED") {
    return "Email sending limit reached";
  }
  return "Email delivery failed";
}


function attachmentKey(messageId: string, attachmentId: string, now: Date): string {
  return [
    "emails",
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    messageId,
    "attachments",
    attachmentId,
  ].join("/");
}

async function parseUploads(form: FormData): Promise<Upload[]> {
  const files = form
    .getAll("attachments")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (files.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachments are too large");
  }

  return Promise.all(
    files.map(async (file) => ({
      filename: file.name || "attachment",
      type: file.type || "application/octet-stream",
      content: await file.arrayBuffer(),
    })),
  );
}

async function forwardedUploads(messageId: string, env: Env): Promise<Upload[]> {
  const attachments = await env.DB.prepare(`
    SELECT filename, content_type, r2_key
    FROM attachments
    WHERE message_id = ?1
    ORDER BY created_at ASC
  `)
    .bind(messageId)
    .all<StoredAttachment>();

  const uploads: Upload[] = [];
  for (const attachment of attachments.results) {
    const object = await env.MAIL.get(attachment.r2_key);
    if (!object) throw new Error("Forwarded attachment is unavailable");
    uploads.push({
      filename: attachment.filename,
      type: attachment.content_type || "application/octet-stream",
      content: await object.arrayBuffer(),
    });
  }
  return uploads;
}

export async function sendEmail(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const accountId = String(form.get("accountId") ?? "").trim() || null;
  const provider = await resolveProvider(env, accountId);
  if (!provider) {
    return Response.json(
      { error: "Account not found or unavailable" },
      { status: 404 },
    );
  }

  let nativeTransport: "cloudflare" | "resend" | null = null;
  // D1 resolves the authenticated, active mailbox (never a client-supplied
  // From). It needs an active domain and an available transport: the
  // Cloudflare Email Sending API by default, or Resend where switched on.
  if (provider.kind === "native") {
    const choice = await transportChoice(env, provider.accountId, provider.address);
    if (choice.kind === "unavailable") return Response.json({ error: choice.reason }, { status: 403 });
    nativeTransport = choice.kind;
  }
  const to = splitRecipients(form.get("to"));
  const cc = splitRecipients(form.get("cc"));
  const bcc = splitRecipients(form.get("bcc"));
  // Line breaks never reach a header, whatever the transport does with them.
  let subject = String(form.get("subject") ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_SUBJECT_CHARS);
  const text = String(form.get("text") ?? "").slice(0, MAX_BODY_CHARS);
  const replyToMessageId = String(form.get("replyToMessageId") ?? "").trim() || null;
  const forwardMessageId = String(form.get("forwardMessageId") ?? "").trim() || null;
  const draftId = String(form.get("draftId") ?? "").trim() || null;
  const recipients = [...to, ...cc, ...bcc];

  if (replyToMessageId && forwardMessageId) {
    return Response.json(
      { error: "A message cannot be both a reply and a forward" },
      { status: 400 },
    );
  }
  if (!to.length) {
    return Response.json({ error: "At least one recipient is required" }, { status: 400 });
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return Response.json(
      { error: `A message can contain at most ${MAX_RECIPIENTS} recipients` },
      { status: 400 },
    );
  }
  if (provider.kind === "native") {
    // Hard bounces and complaints reported by the provider block further sends.
    const lowered = [...new Set(recipients.map(address => address.toLowerCase()))];
    const suppressed = await env.DB.prepare(
      `SELECT address FROM suppressed_recipients WHERE address IN (${lowered.map(() => "?").join(",")}) LIMIT 1`,
    ).bind(...lowered).first<{ address: string }>();
    if (suppressed) {
      return Response.json({ error: `${suppressed.address}: ${userDeliveryError("E_RECIPIENT_SUPPRESSED")}` }, { status: 422 });
    }
  }
  if (recipients.some((address) => !EMAIL_PATTERN.test(address))) {
    return Response.json(
      { error: "One or more recipient addresses are invalid" },
      { status: 400 },
    );
  }
  if (!text.trim()) {
    return Response.json({ error: "Message body cannot be empty" }, { status: 400 });
  }

  let uploads: Upload[];
  try {
    uploads = await parseUploads(form);
  } catch {
    return Response.json(
      { error: "Attachments must total less than 4 MB" },
      { status: 400 },
    );
  }

  let replyTarget: ReplyTarget | null = null;
  // Connected (Gmail) accounts: reply and forward targets are read from the
  // provider, the reply joins the Gmail thread, forwards carry the attachments.
  const gmailTarget = async (id: string) => provider.kind === "gmail"
    ? gmailFullMessage(env, provider.accountId, id).catch(() => null)
    : null;
  if (replyToMessageId) {
    if (provider.kind === "gmail") {
      const target = await gmailTarget(replyToMessageId);
      if (!target) return Response.json({ error: "Reply target was not found" }, { status: 404 });
      replyTarget = { id: target.id, message_id: target.messageId, thread_id: target.threadId, reference_ids: target.references, subject: target.subject };
    } else {
      if (!(await provider.getMessage(replyToMessageId))) {
        return Response.json({ error: "Reply target was not found" }, { status: 404 });
      }
      replyTarget = await env.DB.prepare(`
        SELECT id, COALESCE(original_message_id, message_id) AS message_id, thread_id, reference_ids, subject
        FROM messages
        WHERE id = ?1 AND mailbox_id = ?2
      `)
        .bind(replyToMessageId, provider.accountId)
        .first<ReplyTarget>();
      if (!replyTarget) {
        return Response.json({ error: "Reply target was not found" }, { status: 404 });
      }
    }
    if (!subject) subject = replySubject(replyTarget.subject);
  }

  let forwardTarget: ForwardTarget | null = null;
  let inheritedUploads: Upload[] = [];
  if (forwardMessageId) {
    if (provider.kind === "gmail") {
      const target = await gmailTarget(forwardMessageId);
      if (!target) return Response.json({ error: "Forward target was not found" }, { status: 404 });
      forwardTarget = { id: target.id, subject: target.subject };
      try {
        if (target.attachments.reduce((total, attachment) => total + attachment.size, 0) > MAX_ATTACHMENT_BYTES) {
          return Response.json({ error: "Attachments must total less than 4 MB" }, { status: 400 });
        }
        for (const attachment of target.attachments) {
          const file = await gmailAttachment(env, provider.accountId, target.id, attachment.id);
          inheritedUploads.push({ filename: file.filename, type: file.contentType, content: file.data.slice().buffer });
        }
      } catch {
        return Response.json({ error: "Forwarded attachment is unavailable" }, { status: 400 });
      }
    } else {
      if (!(await provider.getMessage(forwardMessageId))) {
        return Response.json({ error: "Forward target was not found" }, { status: 404 });
      }
      forwardTarget = await env.DB.prepare(`
        SELECT id, subject
        FROM messages
        WHERE id = ?1 AND mailbox_id = ?2
      `)
        .bind(forwardMessageId, provider.accountId)
        .first<ForwardTarget>();
      if (!forwardTarget) {
        return Response.json({ error: "Forward target was not found" }, { status: 404 });
      }
      try {
        inheritedUploads = await forwardedUploads(forwardTarget.id, env);
      } catch {
        return Response.json(
          { error: "Forwarded attachment is unavailable" },
          { status: 400 },
        );
      }
    }
    if (!subject) subject = forwardSubject(forwardTarget.subject);
  }

  const allUploads = [...inheritedUploads, ...uploads];
  const attachmentBytes = allUploads.reduce((sum, upload) => sum + upload.content.byteLength, 0);
  if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
    return Response.json(
      { error: "Attachments must total less than 4 MB" },
      { status: 400 },
    );
  }
  // The Cloudflare Email Sending API caps a message at 5 MiB after base64
  // encoding; reject before reserving quota rather than failing in transport.
  if (nativeTransport === "cloudflare" && !fitsCloudflareApi(
    attachmentBytes, text.length + subject.length,
  )) {
    return Response.json(
      { error: "Attachments are too large for Cloudflare Email Sending (5 MB per message after encoding, about 3.7 MB of files)" },
      { status: 413 },
    );
  }
  if (!subject) subject = "(no subject)";
  // Derived reply/forward subjects come from stored mail: no line breaks either.
  subject = subject.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_SUBJECT_CHARS);

  const id = crypto.randomUUID();
  const clientKey = String(form.get("sendKey") ?? draftId ?? "").trim();
  if (provider.kind === "native") {
    if (!/^[A-Za-z0-9_-]{12,120}$/.test(clientKey)) {
      return Response.json({ error: "A valid send key is required" }, { status: 400 });
    }
    const existing = await env.DB.prepare(
      "SELECT state,message_id,provider_message_id FROM outbound_attempts WHERE mailbox_id=?1 AND client_key=?2"
    ).bind(provider.accountId,clientKey).first<{state:string;message_id:string|null;provider_message_id:string|null}>();
    if (existing) {
      if (existing.state === "accepted") {
        // The first request sent it but may have failed before removing the draft.
        if (draftId) await env.DB.prepare("DELETE FROM drafts WHERE id = ?1 AND mailbox_id = ?2").bind(draftId, provider.accountId).run();
        return Response.json({ ok: true, alreadyAccepted: true, messageId: existing.message_id, providerMessageId: existing.provider_message_id, accountId: provider.accountId });
      }
      // A failed attempt was definitely not accepted by the transport, so it
      // may be retried; pending or uncertain ones may already have been sent.
      if (existing.state !== "failed") {
        return Response.json({ error: "Previous send attempt is pending or its result is uncertain; review it before trying again" }, { status: 409 });
      }
    }
    if (!(await checkAuthRateLimit(env, `outbound:${provider.accountId}`))) {
      return Response.json({ error: "Mailbox sending rate limit exceeded" }, { status: 429 });
    }
    const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbound_attempts WHERE mailbox_id=?1 AND started_at >= datetime('now','-1 day')")
      .bind(provider.accountId).first<{n:number}>();
    if ((today?.n ?? 0) >= 200) {
      return Response.json({ error: "Daily mailbox send limit exceeded" }, { status: 429 });
    }
    const reserved = existing
      ? await env.DB.prepare(
        "UPDATE outbound_attempts SET state='pending', message_id=?3, error_code=NULL, provider_message_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE mailbox_id=?1 AND client_key=?2 AND state='failed'"
      ).bind(provider.accountId,clientKey,id).run()
      : await env.DB.prepare(
        "INSERT OR IGNORE INTO outbound_attempts (mailbox_id,client_key,message_id,state) VALUES (?1,?2,?3,'pending')"
      ).bind(provider.accountId,clientKey,id).run();
    if (!reserved.meta.changes) {
      return Response.json({ error: "This send request is already being processed" }, { status: 409 });
    }
  }
  // Reserve expected D1 body and R2 attachment bytes before transport is
  // invoked. Quota checks are atomic across concurrent mailboxes/requests.
  const bodyBytes = new TextEncoder().encode(text).byteLength
    + new TextEncoder().encode(textToHtml(text)).byteLength;
  const countedBytes = bodyBytes + attachmentBytes;
  if (provider.kind === "native") {
    const quota = await reserveMailboxBytes(env, provider.accountId, countedBytes);
    if (!quota.meta.changes) {
      await env.DB.prepare("DELETE FROM outbound_attempts WHERE mailbox_id=?1 AND client_key=?2 AND state='pending'")
        .bind(provider.accountId,clientKey).run();
      return Response.json({ error: "Mailbox storage quota exceeded" }, { status: 413 });
    }
  }
  const threadId = replyTarget?.thread_id ?? crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const references = [replyTarget?.reference_ids, replyTarget?.message_id]
    .filter(Boolean)
    .join(" ") || null;
  const headers: Record<string, string> = {};
  if (replyTarget?.message_id) headers["In-Reply-To"] = replyTarget.message_id;
  if (references) headers.References = references;

  let status = "sent";
  let deliveryError: string | null = null;
  let providerMessageId: string | null = null;
  let messageIdHeader: string | null = null;
  let transportKind: string | null = null;
  let uncertain = false;
  try {
    const result = await provider.sendMessage({
      to,
      cc,
      bcc,
      subject,
      text,
      headers,
      attachments: allUploads,
      threadId: provider.kind === "gmail" ? replyTarget?.thread_id ?? null : null,
      idempotencyKey: provider.kind === "native" ? `${provider.accountId}:${clientKey}` : undefined,
    });
    providerMessageId = result.providerMessageId;
    messageIdHeader = result.messageIdHeader ?? null;
    transportKind = result.transport ?? null;
  } catch (error) {
    status = "failed";
    deliveryError = safeDeliveryError(error);
    uncertain = error instanceof TransportError && error.uncertain;
    // Log a whitelisted transport code only; never expose addresses,
    // message contents, API credentials or provider stack traces.
    console.warn("Outbound provider rejected message", { provider: provider.kind, code: deliveryError });
  }

  if (provider.kind === "native") {
    // An uncertain result (e.g. a timeout after the request left) is never
    // retried automatically; the idempotency key makes a manual retry safe.
    await env.DB.prepare(
      "UPDATE outbound_attempts SET state=?3, provider_message_id=?4, error_code=?5, transport=COALESCE(?6, transport), updated_at=CURRENT_TIMESTAMP WHERE mailbox_id=?1 AND client_key=?2"
    ).bind(provider.accountId,clientKey,status === "sent" ? "accepted" : uncertain ? "uncertain" : "failed",providerMessageId,deliveryError,transportKind).run();
  }
  if (provider.kind === "native" && status !== "sent" && attachmentBytes > 0) {
    await releaseMailboxBytes(env, provider.accountId, attachmentBytes);
  }

  if (provider.kind !== "native") {
    // Drafts of connected accounts live in D1 too: a sent draft is gone.
    if (status === "sent" && draftId) {
      await env.DB.prepare("DELETE FROM drafts WHERE id = ?1 AND mailbox_id = ?2").bind(draftId, provider.accountId).run();
    }
    return status === "sent"
      ? Response.json(
          { ok: true, providerMessageId, accountId: provider.accountId },
          { status: 201 },
        )
      : Response.json(
          { error: userDeliveryError(deliveryError ?? "") },
          { status: 502 },
        );
  }

  const attachmentRows: Array<{ id: string; key: string; upload: Upload }> = [];
  try {
  if (status === "sent") {
    for (const upload of allUploads) {
      const attachmentId = crypto.randomUUID();
      const key = attachmentKey(id, attachmentId, now);
      await env.MAIL.put(key, upload.content, {
        httpMetadata: { contentType: upload.type },
      });
      attachmentRows.push({ id: attachmentId, key, upload });
    }
  }

  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO threads (
        id,
        subject,
        latest_message_at,
        message_count,
        is_read, mailbox_id
      )
      VALUES (?1, ?2, ?3, 0, 1, ?4)
    `).bind(threadId, subject, nowIso, provider.accountId),
    env.DB.prepare(`
      INSERT INTO messages (
        id,
        message_id,
        thread_id,
        direction,
        from_address,
        to_addresses,
        cc_addresses,
        bcc_addresses,
        subject,
        preview,
        body_text,
        body_html,
        received_at,
        sent_at,
        is_read,
        has_attachments,
        in_reply_to,
        reference_ids,
        delivery_status,
        delivery_error, mailbox_id
      )
      VALUES (
        ?1, ?2, ?3, 'outbound', ?4, ?5, ?6, ?7, ?8, ?9,
        ?10, ?11, ?12, ?12, 1, ?13, ?14, ?15, ?16, ?17, ?18
      )
    `).bind(
      id,
      // The RFC Message-ID, never a provider's own id: replies are matched on it.
      messageIdHeader,
      threadId,
      provider.address,
      JSON.stringify(to),
      JSON.stringify(cc),
      JSON.stringify(bcc),
      subject,
      messagePreview(text),
      text,
      textToHtml(text),
      nowIso,
      attachmentRows.length ? 1 : 0,
      replyTarget?.message_id ?? null,
      references,
      status,
      deliveryError,
      provider.accountId,
    ),
    ...attachmentRows.map(({ id: attachmentId, key, upload }) =>
      env.DB.prepare(`
        INSERT INTO attachments (
          id,
          message_id,
          filename,
          content_type,
          size,
          r2_key
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `).bind(
        attachmentId,
        id,
        upload.filename,
        upload.type,
        upload.content.byteLength,
        key,
      )),
    env.DB.prepare(`
      UPDATE threads
      SET latest_message_at = ?2,
          message_count = message_count + 1,
          subject = ?3
      WHERE id = ?1 AND mailbox_id = ?4
    `).bind(threadId, nowIso, subject, provider.accountId),
  ]);

  } catch {
    await Promise.allSettled(attachmentRows.map(row => env.MAIL.delete(row.key)));
    // Attachment bytes of a failed send were already released above.
    await releaseMailboxBytes(env, provider.accountId, status === "sent" ? countedBytes : countedBytes - attachmentBytes).catch(() => undefined);
    // Sending may already have been accepted. Never automatically retry it.
    return Response.json({ error: "Mail transport finished, but storing its local sent record failed. Do not retry until checked." }, { status: 502 });
  }
  if (status === "failed") {
    return Response.json(
      { error: userDeliveryError(deliveryError ?? ""), messageId: id },
      { status: 502 },
    );
  }

  if (draftId) {
    await env.DB.prepare("DELETE FROM drafts WHERE id = ?1 AND mailbox_id = ?2")
      .bind(draftId, provider.accountId)
      .run();
  }

  return Response.json(
    { ok: true, messageId: id, providerMessageId, accountId: provider.accountId },
    { status: 201 },
  );
}
