import { resolveProvider } from "../providers/registry";
type DraftRow = {
  id: string;
  mailbox_id: string;
  thread_id: string | null;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  subject: string;
  body_text: string;
  reply_to_message_id: string | null;
  forward_message_id: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_BODY_CHARS = 500_000;
const MAX_SUBJECT_CHARS = 500;
/** Drafts live in the shared database outside mailbox quotas, so they are bounded per mailbox. */
export const MAX_DRAFTS_PER_MAILBOX = 200;
const MAX_ADDRESS_CHARS = 320;
const DRAFT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function parseArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function splitRecipients(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.slice(0, 50 * MAX_ADDRESS_CHARS).split(/[;,\n]+/).map((part) => part.trim().slice(0, MAX_ADDRESS_CHARS)).filter(Boolean))].slice(0, 50);
}

function draftResponse(row: DraftRow) {
  return {
    id: row.id,
    accountId: row.mailbox_id,
    threadId: row.thread_id,
    to: parseArray(row.to_addresses).join(", "),
    cc: parseArray(row.cc_addresses).join(", "),
    bcc: parseArray(row.bcc_addresses).join(", "),
    subject: row.subject,
    text: row.body_text,
    replyToMessageId: row.reply_to_message_id ?? "",
    forwardMessageId: row.forward_message_id ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getDraft(id: string, env: Env, accountId?: string | null): Promise<Response> {
  const provider = await resolveProvider(env, accountId);
  if (!provider) return Response.json({ error: "Account not found" }, { status: 404 });
  const row = await env.DB.prepare(
    `SELECT id, mailbox_id, thread_id, to_addresses, cc_addresses, bcc_addresses, subject, body_text,
            reply_to_message_id, forward_message_id, created_at, updated_at
       FROM drafts WHERE id = ?1 AND mailbox_id = ?2`,
  ).bind(id, provider.accountId).first<DraftRow>();

  if (!row) return Response.json({ error: "Draft not found" }, { status: 404 });
  return Response.json({ draft: draftResponse(row) });
}

export async function saveDraft(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json<Record<string, unknown>>();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const provider = await resolveProvider(env, typeof body.accountId === "string" ? body.accountId : null);
  if (!provider) return Response.json({ error: "Account not found" }, { status: 404 });
  const requestedId = typeof body.id === "string" ? body.id.trim() : "";
  if (requestedId && !DRAFT_ID.test(requestedId)) return Response.json({ error: "Invalid draft id" }, { status: 400 });
  const id = requestedId || crypto.randomUUID();
  const to = splitRecipients(body.to);
  const cc = splitRecipients(body.cc);
  const bcc = splitRecipients(body.bcc);
  const subject = typeof body.subject === "string" ? body.subject.slice(0, MAX_SUBJECT_CHARS) : "";
  const text = typeof body.text === "string" ? body.text.slice(0, MAX_BODY_CHARS) : "";
  const replyToMessageId = typeof body.replyToMessageId === "string" && body.replyToMessageId.trim() ? body.replyToMessageId.trim() : null;
  const forwardMessageId = typeof body.forwardMessageId === "string" && body.forwardMessageId.trim() ? body.forwardMessageId.trim() : null;

  if (replyToMessageId && forwardMessageId) {
    return Response.json({ error: "A draft cannot be both a reply and a forward" }, { status: 400 });
  }

  // Connected (Gmail) accounts keep their messages at the provider: the
  // reply or forward target is checked when the draft is sent.
  const native = provider.kind === "native";
  let threadId: string | null = null;
  if (replyToMessageId && native) {
    const target = await env.DB.prepare("SELECT thread_id FROM messages WHERE id = ?1 AND mailbox_id = ?2")
      .bind(replyToMessageId, provider.accountId)
      .first<{ thread_id: string }>();
    if (!target) return Response.json({ error: "Reply target was not found" }, { status: 404 });
    threadId = target.thread_id;
  }

  if (forwardMessageId && native) {
    const target = await env.DB.prepare("SELECT id FROM messages WHERE id = ?1 AND mailbox_id = ?2")
      .bind(forwardMessageId, provider.accountId)
      .first<{ id: string }>();
    if (!target) return Response.json({ error: "Forward target was not found" }, { status: 404 });
  }

  const known = await env.DB.prepare("SELECT 1 AS yes FROM drafts WHERE id = ?1 AND mailbox_id = ?2").bind(id, provider.accountId).first();
  if (!known) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE mailbox_id = ?1").bind(provider.accountId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_DRAFTS_PER_MAILBOX) {
      return Response.json({ error: `This mailbox has ${MAX_DRAFTS_PER_MAILBOX} drafts. Send or delete some first.` }, { status: 409 });
    }
  }

  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO drafts (
       id, thread_id, to_addresses, cc_addresses, bcc_addresses, subject, body_text, body_html,
       reply_to_message_id, forward_message_id, created_at, updated_at, mailbox_id
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, ?10, ?11)
     ON CONFLICT(id) DO UPDATE SET
       thread_id = excluded.thread_id,
       to_addresses = excluded.to_addresses,
       cc_addresses = excluded.cc_addresses,
       bcc_addresses = excluded.bcc_addresses,
       subject = excluded.subject,
       body_text = excluded.body_text,
       body_html = '',
       reply_to_message_id = excluded.reply_to_message_id,
       forward_message_id = excluded.forward_message_id,
       updated_at = excluded.updated_at
     WHERE drafts.mailbox_id = excluded.mailbox_id`,
  ).bind(
    id,
    threadId,
    JSON.stringify(to),
    JSON.stringify(cc),
    JSON.stringify(bcc),
    subject,
    text,
    replyToMessageId,
    forwardMessageId,
    nowIso,
    provider.accountId,
  ).run();

  const row = await env.DB.prepare(
    `SELECT id, mailbox_id, thread_id, to_addresses, cc_addresses, bcc_addresses, subject, body_text,
            reply_to_message_id, forward_message_id, created_at, updated_at
       FROM drafts WHERE id = ?1 AND mailbox_id = ?2`,
  ).bind(id, provider.accountId).first<DraftRow>();

  if (!row) return Response.json({ error: "Draft could not be saved" }, { status: 500 });
  return Response.json({ draft: draftResponse(row) });
}

export async function deleteDraft(id: string, env: Env, accountId?: string | null): Promise<Response> {
  const provider = await resolveProvider(env, accountId);
  if (!provider) return Response.json({ error: "Account not found" }, { status: 404 });
  const result = await env.DB.prepare("DELETE FROM drafts WHERE id = ?1 AND mailbox_id = ?2").bind(id, provider.accountId).run();
  if (!result.meta.changes) return Response.json({ error: "Draft not found" }, { status: 404 });
  return Response.json({ ok: true });
}
