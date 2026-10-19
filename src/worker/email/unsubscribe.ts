/** Extract a safe, user-opened subscription-management link from RFC 2369 headers.
 * Never fetch this URL on the server or automatically visit it on message load.
 */
export function listUnsubscribeUrl(header: string | null | undefined): string | null {
  if (!header || header.length > 8192) return null;
  const bracketed = Array.from(header.matchAll(/<([^<>]{1,2048})>/g), (match) => match[1].trim());
  const candidates = bracketed.length ? bracketed : header.split(",").map((part) => part.trim());
  // Prefer an HTTPS subscription-management page to opening a mail application.
  for (const desiredProtocol of ["https:", "mailto:"]) for (const candidate of candidates) {
    if (/[\r\n\u0000-\u001f\u007f]/.test(candidate)) continue;
    try {
      const url = new URL(candidate);
      if (desiredProtocol === "https:" && url.protocol === "https:" && !url.username && !url.password && !url.port
          && url.hostname.includes(".")
          && !url.hostname.endsWith(".localhost")
          && !url.hostname.endsWith(".local")
          && !url.hostname.endsWith(".internal")
          && !/^(?:\d+\.\d+\.\d+\.\d+|\[.*\])$/.test(url.hostname)) return url.href;
      if (desiredProtocol === "mailto:" && url.protocol === "mailto:" && /^[^\s@?]+@[^\s@?]+\.[^\s@?]+$/.test(url.pathname)
          && !/%0[ad]/i.test(candidate)) return url.href;
    } catch {
      // Ignore malformed or unsupported scheme candidates.
    }
  }
  return null;
}

/**
 * Best-effort fallback for messages that omit List-Unsubscribe. Only extract
 * links explicitly associated with unsubscribe wording; never visit a link
 * automatically. Validate with the same strict rules as the header path.
 */
const UNSUBSCRIBE_WORDING = /unsubscri(?:be|bing|ption)|opt[ -]?out|stop receiving (?:these )?emails|manage (?:email )?(?:subscription|preferences)|email preferences/i;

function validatedCandidate(candidate: string): string | null {
  // HTML attributes commonly encode query-string separators.
  const decoded = candidate.replace(/&(?:amp|#38|#x26);/gi, "&").trim();
  return listUnsubscribeUrl(decoded);
}

export function messageUnsubscribeUrl(bodyHtml: string | null | undefined, bodyText: string | null | undefined): string | null {
  if (bodyHtml) {
    const html = bodyHtml.slice(0, 512 * 1024);
    // One forward pass: each anchor's closing tag is found by a search that
    // never revisits text, so link-heavy or unclosed HTML stays linear.
    const anchors = /<a\b([^<>]{0,4096})>/gi;
    const closing = /<\/a\s*>/gi; // not </abbr> or </address>
    let close = -1;
    for (const match of html.matchAll(anchors)) {
      const start = match.index + match[0].length;
      if (close !== Infinity && close < start) {
        closing.lastIndex = start;
        const found = closing.exec(html);
        close = found ? found.index : Infinity;
      }
      if (close === Infinity || close - start > 4096) continue;
      const label = html.slice(start, close).replace(/<[^<>]{0,4096}>/g, " ").replace(/&nbsp;/gi, " ");
      // Permit a "click here" anchor when an immediately adjacent sentence
      // identifies it as an unsubscribe action.
      const context = html.slice(Math.max(0, match.index - 130), match.index)
        .replace(/<[^<>]*>/g, " ");
      if (!UNSUBSCRIBE_WORDING.test(label) && !UNSUBSCRIBE_WORDING.test(context)) continue;
      const href = /\bhref\s*=\s*(?:"([^"]{1,2048})"|'([^']{1,2048})')/i.exec(match[1]);
      const url = href && validatedCandidate(href[1] || href[2]);
      if (url) return url;
    }
  }

  if (bodyText) {
    const lines = bodyText.slice(0, 256 * 1024).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const current = lines[i];
      if (!UNSUBSCRIBE_WORDING.test(current)) continue;
      // Mailing lists often put their link on the line immediately after the
      // unsubscribe instruction. Do not search arbitrary unrelated URLs.
      for (const segment of [current, lines[i + 1] ?? ""]) {
        const candidate = /(?:https:\/\/|mailto:)[^\s<>"']{1,2048}/i.exec(segment)?.[0];
        if (!candidate) continue;
        const url = validatedCandidate(candidate.replace(/[),.;\]]+$/, ""));
        if (url) return url;
      }
    }
  }
  return null;
}
