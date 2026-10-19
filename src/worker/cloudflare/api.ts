/**
 * Minimal Cloudflare API client for the "Connect Cloudflare" token (v3.12):
 * first-run setup, the encryption key secret and automatic domain wiring.
 * Errors carry Cloudflare's codes and a hint naming the permission to add,
 * never the token.
 */
export type CfApiError = { code: number; message: string };
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.cloudflare.com/client/v4";

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: CfApiError[];
  readonly path: string;
  constructor(path: string, status: number, errors: CfApiError[], hint = "") {
    const detail = errors.map(error => `${error.message}${error.code ? ` (${error.code})` : ""}`).join("; ") || `HTTP ${status}`;
    super(`${detail}${hint ? `. ${hint}` : ""}`);
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = errors;
    this.path = path;
  }
  hasCode(code: number): boolean {
    return this.errors.some(error => error.code === code);
  }
}

/** The permission a request needs, for error messages. */
export function permissionHint(path: string): string {
  if (/\/email\/routing\/rules/.test(path)) return "The token needs Email Routing Rules: Edit on this zone";
  if (/\/email\/routing/.test(path)) return "The token needs Zone Settings: Edit and DNS: Edit on this zone";
  if (/\/email\/sending/.test(path)) return "The token needs Email Sending: Edit";
  if (/\/dns_records/.test(path)) return "The token needs DNS: Edit on this zone";
  if (/\/workers\/scripts/.test(path)) return "The token needs Workers Scripts: Edit on this account";
  if (/^\/zones/.test(path)) return "The token needs Zone: Read on this zone";
  return "";
}

export type CloudflareClient = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

export function cloudflareClient(token: string, fetcher: Fetcher = (input, init) => fetch(input, init)): CloudflareClient {
  return async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const response = await fetcher(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }).catch(() => null);
    if (!response) throw new CloudflareApiError(path, 0, [{ code: 0, message: "Could not reach the Cloudflare API" }]);
    const payload = await response.json().catch(() => null) as { success?: boolean; result?: T; errors?: CfApiError[] } | null;
    if (!response.ok || !payload?.success) {
      const denied = response.status === 401 || response.status === 403;
      throw new CloudflareApiError(path, response.status, payload?.errors ?? [], denied ? permissionHint(path) : "");
    }
    return payload.result as T;
  };
}

/** A token's value as pasted: no "Bearer", no whitespace. Cloudflare tokens are 40+ URL-safe characters. */
export function normalizeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().replace(/^Bearer\s+/i, "");
  return /^[A-Za-z0-9_-]{30,200}$/.test(token) ? token : null;
}
