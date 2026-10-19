/**
 * Remote images in mail, fetched by the Worker (v3.19). The sender's server
 * sees Cloudflare, never the reader's IP address, cookies or browser; only
 * signed-in users can use it (the route sits behind the session check).
 * Responses are images only, size-capped, and sandboxed if opened directly.
 */
const MAX_PROXIED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

/** Local and private network addresses are never fetched. */
function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.includes(":") || host.startsWith("[")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** The image address to fetch, or null when it is not a public http(s) URL. */
export function proxiedImageUrl(value: string | null): URL | null {
  if (!value || value.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || (url.port && url.port !== "80" && url.port !== "443")) return null;
  return privateHost(url.hostname) ? null : url;
}

const failure = (status: number) => new Response(null, { status, headers: { "Cache-Control": "private, max-age=300" } });

export async function imageProxy(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  let url = proxiedImageUrl(new URL(request.url).searchParams.get("url"));
  if (!url) return failure(400);
  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetcher(url.toString(), {
      redirect: "manual",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8", "User-Agent": "Mozilla/5.0 (compatible; MailImageProxy)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheEverything: true, cacheTtl: 86_400 },
    } as RequestInit).catch(() => null);
    if (!response) return failure(502);
    if (response.status < 300 || response.status >= 400) break;
    // Every redirect target is checked like the original address.
    const next = proxiedImageUrl(response.headers.get("Location") ? new URL(response.headers.get("Location")!, url).toString() : null);
    if (!next || hop === MAX_REDIRECTS) return failure(502);
    url = next;
  }
  if (!response?.ok || !response.body) return failure(502);
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) return failure(415);
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_PROXIED_IMAGE_BYTES) return failure(413);
  // Undeclared or wrong lengths are enforced while streaming.
  let seen = 0;
  const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_PROXIED_IMAGE_BYTES) controller.error(new Error("Image too large"));
      else controller.enqueue(chunk);
    },
  }));
  return new Response(limited, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Content-Disposition": "inline",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    },
  });
}
