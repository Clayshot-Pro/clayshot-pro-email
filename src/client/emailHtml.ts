const BLOCKED_ELEMENTS = "script,iframe,object,embed,form,input,button,textarea,select,option,meta,base,link,svg,math,video,audio,source,track,template";
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function isSafeLink(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return true;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

/** Inline data, an embedded image stored with the mail, or the app's image proxy. */
function isSafeImage(value: string, origin: string): boolean {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("data:image/")
    || trimmed.startsWith(`${origin}/api/attachment-previews/`)
    || trimmed.startsWith(`${origin}/api/image-proxy?`);
}

/** Remote image addresses the Worker kept in data-remote-src (never loaded directly). */
export function remoteImageCount(html: string): number {
  return (html.match(/\bdata-remote-src\s*=/gi) ?? []).length;
}

type EmailDocumentOptions = {
  /** Load remote images through the app's image proxy. */
  remoteImages?: boolean;
  origin?: string;
};

/**
 * Creates an isolated email document. The source HTML has already been cleaned
 * on the worker, but this performs a second browser-side sanitization pass and
 * adds a restrictive CSP before it is handed to the sandboxed iframe.
 */
export function buildSafeEmailDocument(html: string, options: EmailDocumentOptions = {}): string {
  const origin = options.origin ?? location.origin;
  const document = new DOMParser().parseFromString(html, "text/html");

  document.querySelectorAll(BLOCKED_ELEMENTS).forEach((element) => element.remove());

  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || ["srcdoc", "formaction", "action", "ping", "nonce", "integrity", "crossorigin"].includes(name)) {
        element.removeAttribute(attribute.name);
      }
    }

    if (element instanceof HTMLAnchorElement) {
      const href = element.getAttribute("href");
      if (href && !isSafeLink(href)) element.removeAttribute("href");
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer nofollow");
    }

    if (element instanceof HTMLImageElement) {
      const remote = element.getAttribute("data-remote-src")?.trim() ?? "";
      element.removeAttribute("data-remote-src");
      if (options.remoteImages && /^https?:\/\//i.test(remote)) {
        element.setAttribute("src", `${origin}/api/image-proxy?url=${encodeURIComponent(remote)}`);
      }
      const src = element.getAttribute("src");
      if (src && !isSafeImage(src, origin)) element.removeAttribute("src");
      element.removeAttribute("srcset");
      element.removeAttribute("usemap");
    }

    element.removeAttribute("background");
    element.removeAttribute("poster");
  });

  document.documentElement.removeAttribute("bgcolor");
  document.body?.removeAttribute("bgcolor");

  const securityHead = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${origin}; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">`;
  const finalSafetyStyles = `<style>
  html, body { margin: 0 !important; padding: 0 !important; min-width: 0; max-width: 100%; background: transparent !important; }
  /* break-word, not anywhere: "anywhere" also lets a single letter count as a
     table cell's minimum width, so a squeezed layout stacked text one letter
     per line. Wide tables keep their width and the reader scales them to fit. */
  body { overflow-wrap: break-word; word-break: normal; }
  img { max-width: 100% !important; }
  img { height: auto !important; }
  pre { white-space: pre-wrap; }
  a { cursor: pointer; }
</style>`;

  document.head.innerHTML = securityHead + document.head.innerHTML + finalSafetyStyles;
  return `<!doctype html>${document.documentElement.outerHTML}`;
}
