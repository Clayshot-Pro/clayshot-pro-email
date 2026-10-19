/** Plain-text body rendered as escaped HTML; shared by quota accounting and sending. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function textToHtml(value: string): string {
  // A "\r" left in the pre-wrap block would render as a second line break.
  return `<div style="white-space:pre-wrap;font-family:Arial,sans-serif">${escapeHtml(value).replace(/\r\n?|\n/g, "<br>")}</div>`;
}

/** One-line message preview stored with each message. */
export function messagePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}
