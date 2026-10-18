import type { Folder, MessageListItem } from "./mailTypes";

export const MAIL_MUTATION_SHIELD_MS = 120_000;

export type MailMutationFlags = Partial<Pick<
  MessageListItem,
  "isDeleted" | "isArchived" | "isJunk" | "isRead" | "isStarred"
>>;

export type MailMutationShield = {
  flags: MailMutationFlags;
  updatedAt: number;
  hide?: boolean;
};

export const mailMutationKey = (accountId: string, id: string, scope: "message" | "thread" = "message") =>
  JSON.stringify([accountId, scope, id]);

function hiddenInFolder(folder: Folder, mutation: MailMutationShield): boolean {
  if (mutation.hide) return true;
  const { flags } = mutation;
  if (flags.isDeleted === true && folder !== "trash") return true;
  if (flags.isDeleted === false && folder === "trash") return true;
  if (flags.isJunk === true && folder !== "junk") return true;
  if (flags.isJunk === false && folder === "junk") return true;
  if (flags.isArchived === true && (folder === "inbox" || folder === "sent")) return true;
  if (flags.isArchived === false && folder === "archive") return true;
  if (flags.isStarred === false && folder === "starred") return true;
  if (flags.isRead === true && folder === "inbox") return false;
  return false;
}

/**
 * Read-your-writes guard for mailbox results.
 *
 * A refresh initiated while a PATCH is pending can finish after the local
 * optimistic update and contain the pre-delete message. Gmail search indexes
 * can also lag a successful label mutation. Keep a short-lived per-account
 * overlay so those GETs cannot resurrect already deleted rows.
 */
export function applyMailMutationShields(
  folder: Folder,
  accountId: string,
  messages: MessageListItem[],
  shields: Map<string, MailMutationShield>,
  now = Date.now(),
): MessageListItem[] {
  for (const [key, state] of shields) {
    if (now - state.updatedAt >= MAIL_MUTATION_SHIELD_MS) shields.delete(key);
  }
  const result: MessageListItem[] = [];
  for (const message of messages) {
    // In All inboxes each message carries its own account.
    const owner = message.accountId ?? accountId;
    const a = shields.get(mailMutationKey(owner, message.id));
    const b = shields.get(mailMutationKey(owner, message.threadId, "thread"));
    const state = a && b ? (a.updatedAt >= b.updatedAt ? a : b) : a ?? b;
    if (!state) {
      result.push(message);
    } else if (!hiddenInFolder(folder, state)) {
      result.push({ ...message, ...state.flags });
    }
  }
  return result;
}
