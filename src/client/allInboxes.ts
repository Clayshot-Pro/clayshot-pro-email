import type { ConnectedAccount, MessageListItem } from "./mailTypes";

/**
 * "All inboxes": a client-side view over every account signed in on this
 * device. Each account is still listed and changed through its own
 * /api/messages request, so the server's per-account authorization applies
 * unchanged. Pure and dependency-free.
 */
export const ALL_INBOXES_ID = "all";

export type AccountListResult =
  | {
    accountId: string;
    ok: true;
    messages: MessageListItem[];
    unreadCount: number;
    draftCount: number;
    folderTotalCount?: number | null;
  }
  | { accountId: string; ok: false };

/** Accounts the merged view reads: two or more, and only usable ones. */
export function unifiedAccounts(accounts: ConnectedAccount[]): ConnectedAccount[] {
  return accounts.filter(account => account.status === "active");
}

export function allInboxesAvailable(accounts: ConnectedAccount[]): boolean {
  return unifiedAccounts(accounts).length > 1;
}

const timestamp = (message: MessageListItem) => {
  const value = Date.parse(message.sentAt || message.receivedAt);
  return Number.isFinite(value) ? value : 0;
};

/** Merge per-account pages newest first, tagging each message with its account. */
export function mergeAccountLists(results: AccountListResult[]) {
  const messages: MessageListItem[] = [];
  const seen = new Set<string>();
  let unreadCount = 0;
  let draftCount = 0;
  let folderTotalCount: number | null = null;
  const failedAccountIds: string[] = [];
  for (const result of results) {
    if (!result.ok) {
      failedAccountIds.push(result.accountId);
      continue;
    }
    unreadCount += result.unreadCount;
    draftCount += result.draftCount;
    if (typeof result.folderTotalCount === "number") folderTotalCount = (folderTotalCount ?? 0) + result.folderTotalCount;
    for (const message of result.messages) {
      const key = `${result.accountId}\u0000${message.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push({ ...message, accountId: result.accountId });
    }
  }
  messages.sort((a, b) => timestamp(b) - timestamp(a));
  return { messages, unreadCount, draftCount, folderTotalCount, failedAccountIds };
}

/** Group message IDs by the account that owns them, preserving order. */
export function groupByAccount(ids: string[], accountOf: (id: string) => string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const accountId = accountOf(id);
    const group = groups.get(accountId);
    if (group) group.push(id);
    else groups.set(accountId, [id]);
  }
  return groups;
}

/** Threads collapse per account: thread IDs are only unique within one mailbox. */
export const threadKey = (message: MessageListItem) => `${message.accountId ?? ""}\u0000${message.threadId}`;

/** Short label for the account a merged message came from. */
export function accountLabel(account: ConnectedAccount | undefined): string {
  if (!account) return "";
  return account.displayName?.trim() || account.emailAddress;
}
