import type {
  ComposeState,
  Folder,
  FolderDefinition,
  MessageDetail,
  MessageListItem,
  NotificationState,
} from "./mailTypes";
import { formatFullDate } from "./mailUtils";

/** admin@<main domain>: the administrator's starting inbox. */
export const ADMIN_ACCOUNT_ID = "native:admin";
export const DETAIL_CACHE_MS = 5 * 60_000;

const DRAFT_SENDER_KEY_PREFIX = "ltm-draft-sender:";
const NOTIFICATION_DISABLED_STATES = new Set<NotificationState>([
  "checking",
  "working",
  "blocked",
  "unsupported",
  "install",
  "unconfigured",
]);

/** iPhone and iPad allow web push only for an app added to the Home Screen. */
export function needsHomeScreenInstall(nav: Navigator & { standalone?: boolean }, standalone: boolean): boolean {
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
  return ios && !standalone && nav.standalone !== true;
}

export const FOLDERS: FolderDefinition[] = [
  { key: "inbox", label: "Inbox", icon: "inbox" },
  { key: "junk", label: "Junk", icon: "junk" },
  { key: "starred", label: "Starred", icon: "star" },
  { key: "sent", label: "Sent", icon: "send" },
  { key: "drafts", label: "Drafts", icon: "draft" },
  { key: "archive", label: "Archive", icon: "archive" },
  { key: "trash", label: "Trash", icon: "trash" },
];

export const EMPTY_COMPOSE: ComposeState = {
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  text: "",
  replyToMessageId: "",
  forwardMessageId: "",
  draftId: "",
};

export type DetailCacheEntry = {
  savedAt: number;
  message: MessageDetail;
  thread: MessageDetail[];
};

export function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const normalized = value.trim().replace(/\s+/g, "").replace(/=+$/g, "");
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error("Notification key is invalid.");
  }

  const base64 = (
    normalized + "=".repeat((4 - normalized.length % 4) % 4)
  )
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes.buffer;
}

export function hasDraftContent(compose: ComposeState): boolean {
  return Boolean(
    compose.to.trim()
    || compose.cc.trim()
    || compose.bcc.trim()
    || compose.subject.trim()
    || compose.text.trim()
    || compose.replyToMessageId
    || compose.forwardMessageId,
  );
}

export function draftSenderKey(draftId: string): string {
  return `${DRAFT_SENDER_KEY_PREFIX}${draftId}`;
}

export function forwardedBody(message: MessageDetail): string {
  const from = message.fromName
    ? `${message.fromName} <${message.fromAddress}>`
    : message.fromAddress;
  const to = message.toAddresses.join(", ") || "undisclosed recipients";
  return `\n\n---------- Forwarded message ----------\nFrom: ${from}\nDate: ${formatFullDate(message.sentAt || message.receivedAt)}\nSubject: ${message.subject || "(no subject)"}\nTo: ${to}\n\n${message.bodyText || ""}`;
}

export function belongsInFolder(folder: Folder, message: MessageListItem): boolean {
  if (message.isDraft) return folder === "drafts";
  if (folder === "trash") return message.isDeleted;
  if (folder === "junk") return message.isJunk && !message.isDeleted;
  if (message.isJunk) return false;
  if (message.isDeleted) return false;
  if (folder === "starred") return message.isStarred;
  if (folder === "archive") return message.isArchived;
  if (folder === "sent") return message.direction === "outbound";
  if (folder === "inbox") return !message.isArchived;
  return true;
}

export function notificationControlsDisabled(state: NotificationState): boolean {
  return NOTIFICATION_DISABLED_STATES.has(state);
}
