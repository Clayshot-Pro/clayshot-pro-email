/** VAPID key pair parsing shared by push delivery and stored keys. Pure. */
export type VapidPair = { publicKey: string; privateKey: string };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Tolerate quotes, whitespace and padding pasted around a base64url key. */
function normalizeVapidKey(value: unknown): string {
  let normalized = (typeof value === "string" ? value : "").trim();
  for (const [open, close] of [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"]]) {
    if (normalized.startsWith(open) && normalized.endsWith(close)) {
      normalized = normalized.slice(open.length, -close.length).trim();
      break;
    }
  }
  return normalized.replace(/\s+/g, "").replace(/=+$/g, "");
}

/** A P-256 pair: 65-byte uncompressed public point and 32-byte private scalar. */
export function vapidPair(publicValue: unknown, privateValue: unknown): VapidPair | null {
  const publicKey = normalizeVapidKey(publicValue);
  const privateKey = normalizeVapidKey(privateValue);
  return publicKey.length === 87 && privateKey.length === 43 && BASE64URL.test(publicKey) && BASE64URL.test(privateKey)
    ? { publicKey, privateKey }
    : null;
}
