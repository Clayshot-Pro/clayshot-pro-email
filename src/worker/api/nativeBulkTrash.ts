/** Commit native Trash removals in one D1 transaction instead of executing
 * each message's R2 cleanup synchronously in the HTTP request. Repeated requests
 * are safe when a prior request committed but its response was interrupted. */
type RemovedRow = {
  id: string;
  thread_id: string;
  raw_r2_key: string | null;
  body_text: string | null;
  body_html: string | null;
  is_deleted: number;
};
type RemovedAttachment = { r2_key: string };

async function cleanupObjects(env: Env, mailboxId: string, rows: RemovedRow[], attachments: RemovedAttachment[]) {
  const encoder = new TextEncoder();
  let reclaimed = rows.reduce((sum, row) => sum + (row.raw_r2_key ? 0 :
    encoder.encode(row.body_text ?? "").byteLength + encoder.encode(row.body_html ?? "").byteLength), 0);
  for (const key of new Set(
    [...rows.map(row => row.raw_r2_key), ...attachments.map(a => a.r2_key)]
      .filter((key): key is string => Boolean(key))
  )) {
    try {
      const [messageReference, attachmentReference] = await Promise.all([
        env.DB.prepare("SELECT 1 FROM messages WHERE raw_r2_key=?1 LIMIT 1").bind(key).first(),
        env.DB.prepare("SELECT 1 FROM attachments WHERE r2_key=?1 LIMIT 1").bind(key).first(),
      ]);
      if (messageReference || attachmentReference) continue;
      const object = await env.MAIL.head(key);
      await env.MAIL.delete(key);
      reclaimed += object?.size ?? 0;
    } catch {
      // A failed R2 cleanup must not falsely report that the D1 delete failed.
      // A future storage reconciliation can recover quota accounting.
    }
  }
  await env.DB.prepare(
    "UPDATE native_mailboxes SET used_bytes=MAX(0,used_bytes-?2),usage_version=usage_version+1 WHERE id=?1"
  ).bind(mailboxId, reclaimed).run();
}

export type TrashBulkResult = {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
  cleanupPending: boolean;
};

export async function permanentlyDeleteNativeTrashBatch(
  env: Env,
  mailboxId: string,
  ids: string[],
  ctx: ExecutionContext,
): Promise<TrashBulkResult> {
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id,thread_id,raw_r2_key,body_text,body_html,is_deleted
     FROM messages WHERE mailbox_id=? AND id IN (${placeholders})`
  ).bind(mailboxId, ...ids).all<RemovedRow>();
  const deletable = rows.results.filter(row => row.is_deleted === 1);
  const failed = rows.results.filter(row => row.is_deleted !== 1)
    .map(row => ({ id: row.id, error: "Message is not in Trash" }));
  const failedIds = new Set(failed.map(row => row.id));
  // Missing rows are an idempotent success: a retry may arrive after the prior
  // D1 transaction committed but a mobile connection lost its response.
  if (!deletable.length) {
    return { succeeded: ids.filter(id => !failedIds.has(id)), failed, cleanupPending: false };
  }
  const foundIds = deletable.map(row => row.id);
  const foundPlaceholders = foundIds.map(() => "?").join(",");
  const attachments = await env.DB.prepare(
    `SELECT r2_key FROM attachments WHERE message_id IN (${foundPlaceholders})`
  ).bind(...foundIds).all<RemovedAttachment>();
  const threads = [...new Set(deletable.map(row => row.thread_id))];
  const threadPlaceholders = threads.map(() => "?").join(",");

  // All deletions, thread counts and empty-thread removals commit together.
  // The WHERE constraints prevent touching other mailboxes or non-Trash mail.
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM messages WHERE mailbox_id=? AND is_deleted=1 AND id IN (${foundPlaceholders})`
    ).bind(mailboxId, ...foundIds),
    env.DB.prepare(
      `UPDATE threads SET
        message_count=(SELECT COUNT(*) FROM messages WHERE thread_id=threads.id AND mailbox_id=?),
        latest_message_at=COALESCE(
          (SELECT MAX(COALESCE(sent_at,received_at)) FROM messages WHERE thread_id=threads.id AND mailbox_id=?),
          latest_message_at
        ) WHERE mailbox_id=? AND id IN (${threadPlaceholders})`
    ).bind(mailboxId, mailboxId, mailboxId, ...threads),
    env.DB.prepare(
      `DELETE FROM threads WHERE mailbox_id=? AND id IN (${threadPlaceholders})
       AND NOT EXISTS(SELECT 1 FROM messages WHERE thread_id=threads.id AND mailbox_id=?)
       AND NOT EXISTS(SELECT 1 FROM drafts WHERE thread_id=threads.id AND mailbox_id=?)`
    ).bind(mailboxId, ...threads, mailboxId, mailboxId),
  ]);
  const removedCount = results[0]?.meta.changes ?? 0;
  if (removedCount !== foundIds.length) {
    // A concurrent deletion may have removed a row after the SELECT; refresh
    // will reconcile the real mailbox state instead of trusting this response.
    throw new Error("Trash changed during deletion; refresh and retry");
  }
  // Return the committed D1 result immediately; R2 operations are best-effort
  // background cleanup and should never block the UI for dozens of messages.
  ctx.waitUntil(cleanupObjects(env, mailboxId, deletable, attachments.results).catch(() => undefined));
  return {
    succeeded: ids.filter(id => !failedIds.has(id)),
    failed,
    cleanupPending: true,
  };
}
