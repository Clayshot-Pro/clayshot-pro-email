/** Native mailbox quota accounting. Dependency-free so Node tests can load its callers directly. */

/** Atomically reserve bytes; `meta.changes` is 0 when the mailbox is not active or the quota would be exceeded. */
export function reserveMailboxBytes(env: Env, id: string, bytes: number): Promise<D1Result> {
  return env.DB.prepare(
    "UPDATE native_mailboxes SET used_bytes=used_bytes+?1,usage_version=usage_version+1 WHERE id=?2 AND status='active' AND used_bytes+?1<=quota_bytes",
  ).bind(bytes, id).run();
}

/** Release bytes (never below zero) and invalidate any in-flight usage reconciliation. */
export function releaseMailboxBytes(env: Env, id: string, bytes: number): Promise<D1Result> {
  return env.DB.prepare(
    "UPDATE native_mailboxes SET used_bytes=MAX(0,used_bytes-?1),usage_version=usage_version+1 WHERE id=?2",
  ).bind(bytes, id).run();
}
