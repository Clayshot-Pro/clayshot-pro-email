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
  return `<div style="white-space:pre-wrap;font-family:Arial,sans-serif">${escapeHtml(value).replace(/\n/g, "<br>")}</div>`;
}
