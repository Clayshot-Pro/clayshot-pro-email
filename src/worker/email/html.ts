const BLOCKED_CONTAINERS = ["script", "iframe", "object", "embed", "form", "svg", "math", "video", "audio", "template"];
// Crafted input (thousands of unclosed tags or quotes, long whitespace runs)
// must cost linear time: every pattern is anchored by a literal name and has
// no two adjacent unbounded runs that could trade characters while backtracking.
// Attributes are separated by whitespace, by nothing right after a quoted
// value (`src="x"onerror=...`), or by "/" after a quoted value or the tag name
// (`<img/onerror=...>`); a "/" inside a URL (`href="https://x.test/onboarding=1"`)
// is not a separator.
const SEP = `(?:\\s|(?<=["'])/?|(?<=<[a-z][a-z0-9]{0,15})/)`;
const VALUE = `(?:"[^"]*"|'[^']*'|[^\\s>]+)`;
const BLOCKED_TAGS = /<\/?(?:script|iframe|object|embed|form|input|button|textarea|select|option|meta|base|link|svg|math|video|audio|source|track|template)\b[^>]{0,8192}>?/gi;
const EVENT_ATTRIBUTES = new RegExp(`${SEP}on[a-z0-9_-]{1,64}\\s*=\\s*${VALUE}`, "gi");
const DANGEROUS_ATTRIBUTES = new RegExp(`${SEP}(?:srcdoc|formaction|action|ping)\\s*=\\s*${VALUE}`, "gi");
// Neutralize the scheme itself, whatever the quoting or length of the URL:
// `href="javascript:..."` becomes `href="blocked:javascript:..."`.
const DANGEROUS_URL = new RegExp(`(${SEP}(?:href|src|xlink:href)\\s*=\\s*(?:["']\\s*)?)(?=javascript|vbscript|file|data:text\\/html)`, "gi");
// Each <img …> tag is matched once (matches never overlap). A remote src is
// moved to data-remote-src: it never loads by itself, and the reader shows
// it through the app's image proxy when remote images are allowed.
const IMAGE_TAG = /<img\b[^>]*>?/gi;
// No two unbounded whitespace runs may meet: `\\s*(?=["']?\\s*…)` was quadratic.
const REMOTE_SRC = new RegExp(`(${SEP})src\\s*=\\s*(?=(?:["']\\s*)?https?:)(${VALUE})`, "gi");
/** Stored HTML format: 2 keeps remote image addresses (data-remote-src). */
export const HTML_VERSION = 2;
const IMAGE_SRCSET = new RegExp(`${SEP}srcset\\s*=\\s*${VALUE}`, "gi");
/** HTML beyond this is not processed; the stored copy is capped at 2 MB anyway. */
const MAX_SANITIZE_CHARS = 2 * 1024 * 1024;

/**
 * Remove whole elements (opening tag through matching closing tag) in one
 * linear pass. An element without a closing tag loses only its opening tag,
 * and once a closing tag is known to be absent it is never searched again.
 */
function removeElements(html: string, tags: string[], replacement = ""): string {
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
  // Removing a tag can join its neighbours into a new one (`<scr<script>ipt>`):
  // repeat until nothing changes. Every pass is linear and only shrinks the input.
  let stripped = html.slice(0, MAX_SANITIZE_CHARS);
  for (let pass = 0; pass < 8; pass++) {
    const next = removeElements(stripped, BLOCKED_CONTAINERS).replace(BLOCKED_TAGS, "");
    if (next === stripped) break;
    stripped = next;
  }
  return stripped
    // Removed attributes leave a space, so the text around them cannot join
    // into a new attribute (`o/onx="1"nerror=` must not become `onerror=`).
    .replace(EVENT_ATTRIBUTES, " ")
    .replace(DANGEROUS_ATTRIBUTES, " ")
    .replace(DANGEROUS_URL, "$1blocked:")
    .replace(IMAGE_TAG, tag => tag.replace(REMOTE_SRC, "$1data-remote-src=$2"))
    .replace(IMAGE_SRCSET, " ")
    .trim();
}

// Named entities common in mail: the Latin-1 set (U+00A0 to U+00FF, in order) and
// typographic punctuation. Unknown names are left as written.
const LATIN1_ENTITIES = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
const NAMED_ENTITIES = new Map<string, string>([
  ...LATIN1_ENTITIES.split(" ").map((name, index): [string, string] => [name, String.fromCharCode(0xa0 + index)]),
  ["nbsp", " "], ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"],
  ...Object.entries({
    OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201,
    zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220,
    rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, lsaquo: 8249, rsaquo: 8250,
    euro: 8364, trade: 8482,
  }).map(([name, code]): [string, string] => [name, String.fromCharCode(code)]),
]);
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

function decodeEntity(entity: string, body: string): string {
  if (body.startsWith("#")) {
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(code);
  }
  // The few names HTML also accepts in capitals (&AMP;, &LT;, ...).
  return NAMED_ENTITIES.get(body) ?? (/^(?:amp|lt|gt|quot|nbsp)$/i.test(body) ? NAMED_ENTITIES.get(body.toLowerCase())! : entity);
}

/** Readable text from HTML (when a message has no text part). Linear for any input. */
export function htmlToText(html: string): string {
  return removeElements(html.slice(0, MAX_SANITIZE_CHARS), ["script", "style"], " ").replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n").replace(/<[^<>]{0,8192}>/g, " ")
    // One pass, so decoded text is never decoded again ("&amp;lt;" is "&lt;", not "<").
    .replace(ENTITY, decodeEntity)
    .replace(/[ \t]+/g, " ").replace(/\n(?:[ \t]*\n){2,}/g, "\n\n").trim();
}
