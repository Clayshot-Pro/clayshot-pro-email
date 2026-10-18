/** Blocked-sender patterns. Pure and dependency-free (shared with tests). */
import { isValidAddress, isValidDomain } from "./appConfig.ts";

export const MAX_BLOCKED_SENDERS = 1000;

/**
 * "someone@example.com" blocks one address; "example.com" or "@example.com"
 * blocks the domain and its subdomains. Returns the stored pattern or null.
 */
export function blockPattern(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase().replace(/^<|>$/g, "");
  if (value.length > 254) return null;
  if (value.includes("@") && !value.startsWith("@")) return isValidAddress(value) ? value : null;
  const domain = value.replace(/^@/, "");
  return isValidDomain(domain) ? `@${domain}` : null;
}

/** Every pattern that would block this sender: the address, its domain and parent domains. */
export function senderPatterns(address: string): string[] {
  const value = address.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 1) return [];
  const labels = value.slice(at + 1).split(".");
  const patterns = [value];
  // Parent domains, but never a bare top-level label such as "@com".
  for (let i = 0; i < labels.length - 1; i++) patterns.push(`@${labels.slice(i).join(".")}`);
  return patterns;
}
