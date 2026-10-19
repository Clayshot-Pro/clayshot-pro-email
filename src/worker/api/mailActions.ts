import { releaseMailboxBytes } from "../mailboxQuota";
import { resolveProvider } from "../providers/registry";
import { permanentlyDeleteNativeTrashBatch } from "./nativeBulkTrash";
import type { ProviderMutation } from "../providers/types";

const MAX_BULK_MESSAGES = 50;
const ACTIONS = {
  trash: { isDeleted: true },
  restore: { isDeleted: false },
  archive: { isArchived: true },
  unarchive: { isArchived: false },
  read: { isRead: true },
  unread: { isRead: false },
  star: { isStarred: true },
  unstar: { isStarred: false },
  junk: { isJunk: true },
  notJunk: { isJunk: false },
} satisfies Record<string, ProviderMutation>;

const errorResponse = (message: string, status: number) => Response.json({ error: message }, { status });

/**
 * Permanently remove a message that is ALREADY in Trash. The mailbox ID comes
 * exclusively from the authenticated request. Never accept an arbitrary R2 key
 * or a client-supplied mailbox identity for deletion.
 */
export async function permanentlyDeleteMessage(env: Env, accountId: string, id: string): Promise<Response> {
  const provider = await resolveProvider(env, accountId);
  if (!provider) return errorResponse("Mailbox is unavailable", 404);
  if (provider.kind === "gmail") {
    // gmail.modify intentionally cannot permanently delete Gmail messages.
    // Do not silently upgrade Google OAuth to the full mail.google.com scope.
    return errorResponse("Permanent deletion of Google mail is unavailable with the current Gmail permissions. You can manage it in Gmail.", 409);
  }

  const row = await env.DB.prepare(
    "SELECT id, thread_id, raw_r2_key, body_text, body_html FROM messages WHERE id=?1 AND mailbox_id=?2 AND is_deleted=1"
  ).bind(id, provider.accountId).first<{id:string;thread_id:string;raw_r2_key:string|null;body_text:string|null;body_html:string|null}>();
  if (!row) return errorResponse("Message is not in Trash or does not exist", 404);

  const attachments = await env.DB.prepare("SELECT r2_key FROM attachments WHERE message_id=?1")
    .bind(id).all<{r2_key:string}>();

  // D1 batch is transactional: no orphaned threads or partial metadata writes.
  const mutations = await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE id=?1 AND mailbox_id=?2 AND is_deleted=1").bind(id, provider.accountId),
    env.DB.prepare(
      "UPDATE threads SET message_count=(SELECT COUNT(*) FROM messages WHERE thread_id=?1 AND mailbox_id=?2), " +
      "latest_message_at=COALESCE((SELECT MAX(COALESCE(sent_at,received_at)) FROM messages WHERE thread_id=?1 AND mailbox_id=?2),latest_message_at) " +
      "WHERE id=?1 AND mailbox_id=?2"
    ).bind(row.thread_id, provider.accountId),
    env.DB.prepare(
      "DELETE FROM threads WHERE id=?1 AND mailbox_id=?2 " +
      "AND NOT EXISTS(SELECT 1 FROM messages WHERE thread_id=?1 AND mailbox_id=?2) " +
      "AND NOT EXISTS(SELECT 1 FROM drafts WHERE thread_id=?1 AND mailbox_id=?2)"
    ).bind(row.thread_id, provider.accountId),
  ]);
  if (!mutations[0].meta.changes) return errorResponse("Message was already removed", 404);

  // Clean up objects only after committed DB deletion. Retain R2 data if any
  // other mailbox/message still refers to it (historical shared MIME keys).
  const encoder = new TextEncoder();
  // Outbound and legacy metadata-only messages occupy D1, not R2.
  let reclaimedBytes = row.raw_r2_key ? 0
    : encoder.encode(row.body_text ?? "").byteLength + encoder.encode(row.body_html ?? "").byteLength;
  let cleanupFailures = 0;
  for (const key of new Set([row.raw_r2_key, ...attachments.results.map(a => a.r2_key)].filter((key): key is string => Boolean(key)))) {
    try {
      const [messageRef, attachmentRef] = await Promise.all([
        env.DB.prepare("SELECT 1 FROM messages WHERE raw_r2_key=?1 LIMIT 1").bind(key).first(),
        env.DB.prepare("SELECT 1 FROM attachments WHERE r2_key=?1 LIMIT 1").bind(key).first(),
      ]);
      if (messageRef || attachmentRef) continue;
      const object = await env.MAIL.head(key);
      await env.MAIL.delete(key);
      reclaimedBytes += object?.size ?? 0;
    } catch {
      cleanupFailures++;
    }
  }
  // Always invalidate in-flight usage reconciliation, even if an R2 cleanup
  // failed or this message had zero physical bytes.
  await releaseMailboxBytes(env, provider.accountId, reclaimedBytes);
  return Response.json({
    ok: true,
    permanentlyDeleted: true,
    cleanupPending: cleanupFailures > 0,
  });
}

export async function bulkMailAction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const accountId = new URL(request.url).searchParams.get("accountId");
  if (!accountId) return errorResponse("Account is required", 400);
  const payload = await request.json().catch(() => null) as { ids?: unknown; action?: unknown } | null;
  const ids = payload?.ids;
  const action = payload?.action;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_MESSAGES
    || ids.some(id => typeof id !== "string" || !id || id.length > 256)
    || new Set(ids).size !== ids.length) return errorResponse("Select 1 to 50 distinct messages", 400);
  if (typeof action !== "string" || (action !== "permanent" && action !== "deleteDraft" && !(action in ACTIONS))) {
    return errorResponse("Unsupported mail action", 400);
  }
  const provider = await resolveProvider(env, accountId);
  if (!provider) return errorResponse("Account is unavailable", 404);
  if (action === "permanent" && provider.kind === "gmail") {
    return errorResponse("Permanent deletion of Gmail mail is unavailable with current Google permissions.", 409);
  }
  if (action === "permanent" && provider.kind === "native") {
    try {
      const result = await permanentlyDeleteNativeTrashBatch(env, provider.accountId, ids as string[], ctx);
      return Response.json({ ok: result.failed.length === 0, ...result },
        { status: result.failed.length && !result.succeeded.length ? 409 : 200 });
    } catch {
      return errorResponse("Bulk deletion could not finish. Refresh Trash and retry.", 503);
    }
  }
  const successes: string[] = [];
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of ids as string[]) {
    try {
      if (action === "deleteDraft") {
        const result = await env.DB.prepare("DELETE FROM drafts WHERE id=?1 AND mailbox_id=?2")
          .bind(id, provider.accountId).run();
        if (!result.meta.changes) throw new Error("Draft not found");
      } else if (action === "permanent") {
        const result = await permanentlyDeleteMessage(env, provider.accountId, id);
        if (!result.ok) {
          const body = await result.json() as {error?:string};
          throw new Error(body.error || "Unable to permanently delete");
        }
      } else {
        // Selection mode lists single messages: act on exactly those.
        const updated = await provider.patchMessage(id, ACTIONS[action as keyof typeof ACTIONS]);
        if (!updated) throw new Error("Message not found");
      }
      successes.push(id);
    } catch (error) {
      failures.push({ id, error: error instanceof Error ? error.message : "Action failed" });
    }
  }
  return Response.json({ ok: failures.length === 0, succeeded: successes, failed: failures },
    { status: failures.length > 0 && successes.length === 0 ? 409 : 200 });
}
