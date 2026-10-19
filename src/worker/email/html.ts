const BLOCKED_CONTAINERS = ["script", "iframe", "object", "embed", "form", "svg", "math", "video", "audio", "template"];
// Crafted input (thousands of unclosed tags or quotes, long whitespace runs)
// must cost linear time: every pattern is anchored by a literal name and has
// no two adjacent unbounded runs that could trade characters while backtracking.
// Attributes may be separated by whitespace or "/" (`<img src=x/onerror=...>`).
const SEP = `[\\s/]`;
const VALUE = `(?:"[^"]*"|'[^']*'|[^\\s>]+)`;
const BLOCKED_TAGS = /<\/?(?:script|iframe|object|embed|form|input|button|textarea|select|option|meta|base|link|svg|math|video|audio|source|track|template)\b[^>]{0,8192}>?/gi;
const EVENT_ATTRIBUTES = new RegExp(`${SEP}on[a-z0-9_-]{1,64}\\s*=\\s*${VALUE}`, "gi");
const DANGEROUS_ATTRIBUTES = new RegExp(`${SEP}(?:srcdoc|formaction|action|ping)\\s*=\\s*${VALUE}`, "gi");
// Neutralize the scheme itself, whatever the quoting or length of the URL:
// `href="javascript:..."` becomes `href="blocked:javascript:..."`.
const DANGEROUS_URL = new RegExp(`(${SEP}(?:href|src|xlink:href)\\s*=\\s*(?:["']\\s*)?)(?=javascript|vbscript|file|data:text\\/html)`, "gi");
// Each <img …> tag is matched once (matches never overlap), then its remote src is removed inside it.
const IMAGE_TAG = /<img\b[^>]*>?/gi;
const REMOTE_SRC = new RegExp(`(${SEP})src\\s*=\\s*(?=["']?\\s*https?:)${VALUE}`, "gi");
const IMAGE_SRCSET = new RegExp(`${SEP}srcset\\s*=\\s*${VALUE}`, "gi");
/** HTML beyond this is not processed; the stored copy is capped at 2 MB anyway. */
export const MAX_SANITIZE_CHARS = 2 * 1024 * 1024;

/**
 * Remove whole elements (opening tag through matching closing tag) in one
 * linear pass. An element without a closing tag loses only its opening tag,
 * and once a closing tag is known to be absent it is never searched again.
 */
export function removeElements(html: string, tags: string[], replacement = ""): string {
  const lower = html.toLowerCase();
  const opener = new RegExp(`<\\s*(${tags.join("|")})\\b[^>]{0,8192}>?`, "gi");
  const noCloseAfter = new Map<string, number>();
  let out = "";
  let last = 0;
  for (let match = opener.exec(html); match; match = opener.exec(html)) {
    const tag = match[1].toLowerCase();
    const start = match.index;
    let end = start + match[0].length;
    const missingFrom = noCloseAfter.get(tag);
    const close = missingFrom !== undefined && end >= missingFrom ? -1 : lower.indexOf(`</${tag}`, end);
    if (close >= 0) {
      const closeEnd = lower.indexOf(">", close);
      end = closeEnd >= 0 ? closeEnd + 1 : lower.length;
    } else if (missingFrom === undefined) {
      noCloseAfter.set(tag, end);
    }
    out += html.slice(last, start) + replacement;
    last = end;
    opener.lastIndex = end;
  }
  return out + html.slice(last);
}

/**
 * Removes active/interactive markup before HTML is persisted. Rendering still
 * happens inside a sandboxed iframe with a restrictive CSP, so this is the
 * first layer of a defense-in-depth model rather than the only protection.
 */
export function sanitizeEmailHtml(html: string): string {
  return removeElements(html.slice(0, MAX_SANITIZE_CHARS), BLOCKED_CONTAINERS)
    .replace(BLOCKED_TAGS, "")
    .replace(EVENT_ATTRIBUTES, "")
    .replace(DANGEROUS_ATTRIBUTES, "")
    .replace(DANGEROUS_URL, "$1blocked:")
    .replace(IMAGE_TAG, tag => tag.replace(REMOTE_SRC, "$1data-remote-image-blocked=\"true\""))
    .replace(IMAGE_SRCSET, "")
    .trim();
}

/** Readable text from HTML (when a message has no text part). Linear for any input. */
export function htmlToText(html: string): string {
  return removeElements(html.slice(0, MAX_SANITIZE_CHARS), ["script", "style"], " ").replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n").replace(/<[^<>]{0,8192}>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/[ \t]+/g, " ").replace(/\n(?:[ \t]*\n){2,}/g, "\n\n").trim();
}
