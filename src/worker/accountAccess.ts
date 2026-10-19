/** Profile photo routes; each photo belongs to one mailbox (?accountId=). */
export const primaryProfilePath = (pathname: string): boolean =>
  pathname === "/api/profile/photo";

/** Resolve the account a protected mail API request ACTUALLY operates on.
 *
 * A URL query must never authorize a different account supplied by the POST
 * body. Sending and draft creation use the body as their canonical account
 * identity, while reads and mutations use the query string.
 */
export type AccountTarget = { accountId: string | null; error?: string };

export const protectedAccountPath = (pathname: string): boolean =>
  pathname === "/api/messages"
  || pathname.startsWith("/api/messages/")
  || pathname === "/api/send"
  || pathname === "/api/drafts"
  || pathname.startsWith("/api/drafts/")
  || pathname.startsWith("/api/attachment-previews/")
  || pathname.startsWith("/api/attachments/")
  || pathname === "/api/contact-avatar"
  || pathname === "/api/blocked-senders";

export async function requestedMailAccount(request: Request, url: URL): Promise<AccountTarget> {
  const query = url.searchParams.get("accountId")?.trim() || null;
  if (request.method !== "POST") return { accountId: query };
  if (url.pathname === "/api/send") {
    const form = await request.clone().formData().catch(() => null);
    if (!form) return { accountId: null, error: "Invalid email form data" };
    const value = form.get("accountId");
    const body = typeof value === "string" ? value.trim() || null : null;
    if (query && body && query !== body) return { accountId: null, error: "Conflicting account IDs" };
    return { accountId: body };
  }
  if (url.pathname === "/api/drafts") {
    const payload = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      return { accountId: null, error: "Invalid draft data" };
    }
    const body = typeof payload.accountId === "string" ? payload.accountId.trim() || null : null;
    if (query && body && query !== body) return { accountId: null, error: "Conflicting account IDs" };
    return { accountId: body };
  }
  return { accountId: query };
}
