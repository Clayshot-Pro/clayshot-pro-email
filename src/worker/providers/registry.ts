import { gmailProvider } from "./gmailProvider";
import { nativeProvider } from "./native";
import { allNativeMailboxes, mailboxById } from "../mailboxes";
import { ADMIN_MAILBOX_ID, LEGACY_MAILBOX_ID } from "../mailboxIds";
import type { MailProvider, MailProviderKind } from "./types";
import { sendableMailboxes } from "../transports";
import { accountColors } from "../branding";

export type ConnectedAccount = {
  id: string;
  provider: MailProviderKind;
  emailAddress: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: "active" | "reauth_required" | "disabled";
  lastSyncedAt: string | null;
  sendEnabled?: boolean;
  accentColor?: string | null;
};

type AccountRow = {
  id: string;
  provider: MailProviderKind;
  email_address: string;
  display_name: string | null;
  status: ConnectedAccount["status"];
  last_synced_at: string | null;
};

export async function ensureNativeAccount(env: Env): Promise<void> {
  const primary = await mailboxById(env, LEGACY_MAILBOX_ID);
  if (!primary) return;
  // Legacy provider registry row kept for the v2 mailbox and Gmail
  // integration; every other native mailbox lives only in native_mailboxes.
  await env.DB.prepare(`
    INSERT INTO connected_accounts (
      id, provider, provider_account_id, email_address, display_name, status, updated_at
    ) VALUES (?1, 'native', ?1, ?2, ?3, 'active', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      email_address = excluded.email_address,
      status = 'active', updated_at = CURRENT_TIMESTAMP
  `).bind(LEGACY_MAILBOX_ID, primary.email_address, primary.display_name || primary.email_address).run();
}

export async function listConnectedAccounts(env: Env): Promise<ConnectedAccount[]> {
  await ensureNativeAccount(env);
  const [mailboxes, result] = await Promise.all([
    allNativeMailboxes(env),
    env.DB.prepare(`
      SELECT id, provider, email_address, display_name, status, last_synced_at
      FROM connected_accounts WHERE provider = 'gmail' AND status != 'disabled'
      ORDER BY created_at ASC
    `).all<AccountRow>(),
  ]);

  const active = mailboxes.filter((box) => box.status === "active" && !box.deleted_at);
  // Same selection the send handler applies, so the UI never offers a sender
  // the server will refuse.
  const sendable = await sendableMailboxes(env, active);
  const colors = await accountColors(env, [...active.map((box) => box.id), ...result.results.map((row) => row.id)]);
  return [
    ...active.map((box, index) => ({
      id: box.id,
      provider: "native" as const,
      emailAddress: box.email_address,
      displayName: box.display_name || null,
      avatarUrl: box.photo_version
        ? `/api/profile/photo?accountId=${encodeURIComponent(box.id)}&v=${encodeURIComponent(box.photo_version)}`
        : null,
      status: box.status,
      lastSyncedAt: null,
      sendEnabled: sendable[index],
      accentColor: colors.get(box.id) ?? null,
    })),
    ...result.results.map((row) => ({
      id: row.id,
      provider: row.provider,
      emailAddress: row.email_address,
      displayName: row.display_name,
      avatarUrl: `/api/accounts/${encodeURIComponent(row.id)}/avatar`,
      status: row.status,
      lastSyncedAt: row.last_synced_at,
      sendEnabled: true,
      accentColor: colors.get(row.id) ?? null,
    })),
  ];
}

export async function resolveProvider(env: Env, accountId?: string | null): Promise<MailProvider | null> {
  const id = accountId?.trim() || ADMIN_MAILBOX_ID;
  if (id.startsWith("native:")) {
    const box = await mailboxById(env, id);
    return box?.status === "active" ? nativeProvider(env, box.id, box.email_address, box.sender_name || box.display_name || box.email_address) : null;
  }
  const account = await env.DB.prepare(`
    SELECT provider, status, email_address
    FROM connected_accounts WHERE id = ?1 LIMIT 1
  `).bind(id).first<{ provider: MailProviderKind; status: string; email_address: string }>();
  if (!account || account.status !== "active") return null;
  if (account.provider === "gmail") return gmailProvider(env, id, account.email_address);
  return null;
}
