import { appConfig } from "./appConfig";

const PRIMARY = "native:primary";
let ready: Promise<void> | null = null;

/**
 * Align stored instance identity with configuration once per isolate.
 *
 * Migration 0010 seeds native:primary with the original LTM address. A fresh
 * install (no mail, drafts or credentials on the primary mailbox) adopts
 * PRIMARY_ADDRESS. An install that already holds mail is never renamed
 * automatically; the admin panel reports the mismatch instead.
 */
export function bootstrapInstance(env: Env): Promise<void> {
  ready ??= ensurePrimaryMailbox(env).catch(error => {
    ready = null;
    console.error("instance_bootstrap_failed", error instanceof Error ? error.name : "unknown");
  });
  return ready;
}

async function ensurePrimaryMailbox(env: Env): Promise<void> {
  const config = appConfig(env);
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO native_mailboxes (id, email_address, display_name) VALUES (?1, ?2, ?3)`)
      .bind(PRIMARY, config.primaryAddress, config.primaryDisplayName),
    env.DB.prepare(`UPDATE native_mailboxes SET email_address = ?2, display_name = ?3, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?1 AND email_address != ?2
        AND NOT EXISTS (SELECT 1 FROM messages WHERE mailbox_id = ?1)
        AND NOT EXISTS (SELECT 1 FROM drafts WHERE mailbox_id = ?1)
        AND NOT EXISTS (SELECT 1 FROM native_mailbox_credentials WHERE mailbox_id = ?1)
        AND NOT EXISTS (SELECT 1 FROM native_mailboxes WHERE email_address = ?2 AND id != ?1)`)
      .bind(PRIMARY, config.primaryAddress, config.primaryDisplayName),
  ]);
}

/** Non-null when the stored primary mailbox differs from PRIMARY_ADDRESS. */
export async function primaryAddressMismatch(env: Env): Promise<{ stored: string; configured: string } | null> {
  const row = await env.DB.prepare("SELECT email_address FROM native_mailboxes WHERE id = ?1")
    .bind(PRIMARY).first<{ email_address: string }>();
  const configured = appConfig(env).primaryAddress;
  return row && row.email_address.toLowerCase() !== configured ? { stored: row.email_address, configured } : null;
}
