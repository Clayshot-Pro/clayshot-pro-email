import type { MessageListItem, NotificationState } from "./mailTypes";

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }
  ).format(date);
}

export function formatFullDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** Preview and download links of an attachment. Gmail needs the message (and part) to find it. */
export function attachmentUrls(accountId: string, messageId: string, attachment: { id: string; partId?: string }) {
  const query = new URLSearchParams({ accountId, messageId });
  if (attachment.partId) query.set("partId", attachment.partId);
  const id = encodeURIComponent(attachment.id);
  return { preview: `/api/attachment-previews/${id}?${query}`, download: `/api/attachments/${id}?${query}` };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function senderLabel(message: MessageListItem): string {
  if (message.direction === "outbound") return message.toAddresses.join(", ") || "Unknown recipient";
  return message.fromName || message.fromAddress;
}

/**
 * A name shown on one line: its spaces (and any line or paragraph separators
 * in it) become non-breaking spaces, so no browser can break it across lines;
 * a long name still ends in an ellipsis.
 */
export function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, "\u00a0");
}

export function senderInitial(message: MessageListItem): string {
  return senderLabel(message).trim().slice(0, 1).toUpperCase() || "?";
}

export function notificationLabel(state: NotificationState): string {
  switch (state) {
    case "on": return "Disable notifications";
    case "off": return "Enable notifications";
    case "blocked": return "Notifications blocked";
    case "unsupported": return "Notifications unavailable";
    case "install": return "Add to Home Screen for notifications";
    case "unconfigured": return "Notification setup needed";
    case "working": return "Updating notifications";
    default: return "Checking notifications";
  }
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function forwardSubject(subject: string): string {
  return /^(fwd|fw):/i.test(subject) ? subject : `Fwd: ${subject}`;
}
