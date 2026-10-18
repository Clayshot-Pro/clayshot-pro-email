/**
 * Deployment-aware authentication origin. The Worker request URL (not a
 * client-supplied Origin or X-Forwarded-Host header) is authoritative.
 * WebAuthn relies on the exact browser host: HTTPS in production, or local
 * loopback/localhost for development only.
 */
export function appOrigin(request: Request): string {
  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Secure HTTPS origin required");
  }
  return url.origin;
}

export function appHostname(request: Request): string {
  appOrigin(request);
  return new URL(request.url).hostname.toLowerCase();
}

export function passkeyRpId(request: Request): string {
  return appHostname(request);
}

/** The primary administrator sign-in changes with the Worker hostname. */
export function adminLoginAddress(request: Request): string {
  return `admin@${appHostname(request)}`;
}

/** Accepts a primary mail domain or an address on it (D1 primary domain). */
function mailDomain(primary: string | null | undefined): string | null {
  if (!primary) return null;
  const domain = primary.slice(primary.lastIndexOf("@") + 1).trim().toLowerCase();
  return /^[a-z0-9.-]+$/.test(domain) ? domain : null;
}

/**
 * Preserve the existing admin@<mail domain> sign-in only when this Worker is
 * hosted on that mail domain or a subdomain, so existing owners are not locked
 * out on release. It does not turn admin into a real mailbox.
 */
export function legacyAdminLoginAddress(request: Request, primaryDomain: string | null): string | null {
  const domain = mailDomain(primaryDomain);
  if (!domain) return null;
  const host = appHostname(request);
  return host !== domain && host.endsWith("." + domain) ? `admin@${domain}` : null;
}

export function isAdministratorEmail(request: Request, email: string, primaryDomain: string | null): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized === adminLoginAddress(request)
    || normalized === legacyAdminLoginAddress(request, primaryDomain);
}
