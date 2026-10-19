const WINDOW_SECONDS = 60;
const MAX_ATTEMPTS = 12;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function checkAuthRateLimit(env: Env, bucket: string, windowSeconds = WINDOW_SECONDS, maxAttempts = MAX_ATTEMPTS): Promise<boolean> {
  const key = await sha256Hex(bucket);
  const window = `-${Math.max(1, Math.floor(windowSeconds))} seconds`;
  await env.DB.prepare(`
    INSERT INTO auth_rate_limits (bucket, attempts, window_started_at) VALUES (?1, 1, datetime('now'))
    ON CONFLICT(bucket) DO UPDATE SET
      attempts = CASE WHEN window_started_at <= datetime('now', ?2) THEN 1 ELSE attempts + 1 END,
      window_started_at = CASE WHEN window_started_at <= datetime('now', ?2) THEN datetime('now') ELSE window_started_at END
  `).bind(key, window).run();
  const row = await env.DB.prepare("SELECT attempts FROM auth_rate_limits WHERE bucket = ?1").bind(key).first<{ attempts: number }>();
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM auth_rate_limits WHERE window_started_at <= datetime('now', '-1 day')").run();
  return (row?.attempts ?? maxAttempts + 1) <= maxAttempts;
}

/**
 * The client's network for rate limiting: the IPv4 address, or the /64 an
 * IPv6 client is given (one subscriber usually controls a whole /64).
 */
export function clientNetwork(request: Request): string {
  const ip = (request.headers.get("CF-Connecting-IP") ?? "unknown").trim().toLowerCase();
  if (!ip.includes(":")) return ip;
  // IPv4-mapped IPv6 (::ffff:192.0.2.1) is that IPv4 client.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function authRateLimitBucket(request: Request, route: string): string {
  return `${route}:${clientNetwork(request)}`;
}

/**
 * Sign-in attempts on one account from anywhere, so spreading guesses over
 * many addresses doesn't help. A success clears the count, so the owner
 * signing in never uses up the allowance.
 */
const ACCOUNT_LOGIN_WINDOW_SECONDS = 15 * 60;
export const ACCOUNT_LOGIN_MAX_ATTEMPTS = 30;
export const accountRateLimitBucket = (route: string, address: string) => `${route}:account:${address.trim().toLowerCase()}`;

/** Count one attempt; false once the account's allowance for the window is used up. */
export function countAccountLoginAttempt(env: Env, bucket: string): Promise<boolean> {
  return checkAuthRateLimit(env, bucket, ACCOUNT_LOGIN_WINDOW_SECONDS, ACCOUNT_LOGIN_MAX_ATTEMPTS);
}

export async function clearAccountLoginFailures(env: Env, bucket: string): Promise<void> {
  await env.DB.prepare("DELETE FROM auth_rate_limits WHERE bucket = ?1").bind(await sha256Hex(bucket)).run();
}

export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;

/**
 * A declared length over the limit, or a streamed (chunked) body with no
 * length to check up front: refuse it, so handlers that parse JSON before
 * authentication never read unbounded input.
 */
export function requestTooLarge(request: Request, maxBytes: number): boolean {
  const raw = request.headers.get("Content-Length");
  if (!raw) return request.body !== null && request.headers.has("Transfer-Encoding");
  const length = Number(raw);
  return !Number.isFinite(length) || length > maxBytes;
}
