const BLOCKED_CONTAINERS = ["script", "iframe", "object", "embed", "form", "svg", "math", "video", "audio", "template"];
// Every repetition is length-bounded so crafted input (thousands of unclosed
// tags or quotes) costs linear time, never quadratic.
const VALUE = `(?:"[^"]{0,16384}"|'[^']{0,16384}'|[^\\s>]{1,16384})`;
const BLOCKED_TAGS = /<\/?(?:script|iframe|object|embed|form|input|button|textarea|select|option|meta|base|link|svg|math|video|audio|source|track|template)\b[^>]{0,8192}>?/gi;
const EVENT_ATTRIBUTES = new RegExp(`\\s{1,16}on[a-z0-9_-]{1,64}\\s{0,16}=\\s{0,16}${VALUE}`, "gi");
const DANGEROUS_ATTRIBUTES = new RegExp(`\\s{1,16}(?:srcdoc|formaction|action|ping)\\s{0,16}=\\s{0,16}${VALUE}`, "gi");
const DANGEROUS_QUOTED_URL = /\s{1,16}(href|src|xlink:href)\s{0,16}=\s{0,16}(["'])\s{0,16}(?:javascript|vbscript|file|data:text\/html)[^"']{0,16384}\2/gi;
const DANGEROUS_UNQUOTED_URL = /\s{1,16}(href|src|xlink:href)\s{0,16}=\s{0,16}(?:javascript|vbscript|file|data:text\/html):[^\s>]{0,16384}/gi;
// Each <img …> tag is matched once (matches never overlap), then its src is checked inside it.
const IMAGE_TAG = /<img\b[^>]{0,8192}>?/gi;
const REMOTE_SRC = /\s{1,16}src\s{0,16}=\s{0,16}(?:(["'])\s{0,16}https?:\/\/[^"']{0,16384}\1|https?:\/\/[^\s>]{0,16384})/gi;
const IMAGE_SRCSET = new RegExp(`\\s{1,16}srcset\\s{0,16}=\\s{0,16}${VALUE}`, "gi");
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
    .replace(DANGEROUS_QUOTED_URL, " $1=\"#\"")
    .replace(DANGEROUS_UNQUOTED_URL, " $1=\"#\"")
    .replace(IMAGE_TAG, tag => tag.replace(REMOTE_SRC, " data-remote-image-blocked=\"true\""))
    .replace(IMAGE_SRCSET, "")
    .trim();
}

/** Readable text from HTML (when a message has no text part). Linear for any input. */
export function htmlToText(html: string): string {
  return removeElements(html.slice(0, MAX_SANITIZE_CHARS), ["script", "style"], " ").replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n").replace(/<[^<>]{0,8192}>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/[ \t]+/g, " ").replace(/\n(?:[ \t]*\n){2,}/g, "\n\n").trim();
}
