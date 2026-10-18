const MAX_MUTATION_BYTES = 64 * 1024;

/** Fail closed for every mutating owner-only route, including future routes. */
export function adminMutationNeedsStepUp(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (path === "/api/admin/login/password") return false;
  if (path === "/api/admin/step-up/options" || path === "/api/admin/step-up/verify") return false;
  return path === "/api/mailboxes" || path.startsWith("/api/mailboxes/")
    || path === "/api/admin" || path.startsWith("/api/admin/")
    || path === "/api/auth/sessions" || path.startsWith("/api/auth/sessions/");
}

/** Only existing mutation routes can receive an administrator approval. */
export function isApprovedAdminMutation(method: string, path: string): boolean {
  if (method === "POST" && (path === "/api/admin/password" || path === "/api/mailboxes"
    || path === "/api/auth/sessions/reset")) return true;
  if (method === "DELETE" && /^\/api\/auth\/sessions\/[^/]+$/.test(path)) return true;
  if ((method === "PATCH" || method === "DELETE") && /^\/api\/mailboxes\/[^/]+$/.test(path)) return true;
  if (method === "POST" && path === "/api/admin/domains") return true;
  if ((method === "PATCH" || method === "DELETE") && /^\/api\/admin\/domains\/[^/]+$/.test(path)) return true;
  return method === "POST" && /^\/api\/mailboxes\/[^/]+\/(reset-password|restore|purge|reconcile)$/.test(path);
}

export async function hashMutationBody(request: Request): Promise<string | null> {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_MUTATION_BYTES) return null;
  const bytes = new Uint8Array(await request.clone().arrayBuffer());
  if (bytes.byteLength > MAX_MUTATION_BYTES) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
