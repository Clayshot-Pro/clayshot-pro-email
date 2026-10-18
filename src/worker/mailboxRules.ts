/** Shared, dependency-free address validation for inbound and login. */
import { isValidDomain } from "./appConfig.ts";

const RESERVED = new Set(["postmaster", "abuse", "mailer-daemon", "root", "admin"]);

export type AddressRules = {
  /** Domains an address may use (lower-case, ASCII/punycode). */
  domains: ReadonlySet<string>;
  /** Domain applied to a bare local part such as "work". */
  defaultDomain: string;
  /** The reserved administrator sign-in, never a mailbox. */
  adminAddress?: string;
};

export function normalizeMailboxAddress(value: string, rules: AddressRules, allowReserved = false): string | null {
  const address = value.trim().toLowerCase();
  const at = address.indexOf("@");
  if (at !== address.lastIndexOf("@")) return null;
  const local = at >= 0 ? address.slice(0, at) : address;
  const domain = at >= 0 ? address.slice(at + 1) : rules.defaultDomain;
  if (!rules.domains.has(domain) || !isValidDomain(domain) || local.length < 1 || local.length > 64
    || !/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/.test(local)
    || local.includes("..") || (!allowReserved && RESERVED.has(local))) return null;
  const normalized = `${local}@${domain}`;
  if (normalized.length > 254) return null;
  if (!allowReserved && rules.adminAddress && normalized === rules.adminAddress) return null;
  return normalized;
}

export type AliasTarget =
  | { kind: "postmaster"; domain: string }
  | { kind: "plus"; parent: string }
  | null;

/**
 * Fallback routing for a normalized recipient with no exact mailbox. RFC
 * postmaster/abuse go to the domain's postmaster mailbox; plus suffixes go to
 * the parent address on the SAME domain only.
 */
export function aliasTarget(normalized: string): AliasTarget {
  const at = normalized.lastIndexOf("@");
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (local === "postmaster" || local === "abuse") return { kind: "postmaster", domain };
  if (local.includes("+")) {
    const parent = local.split("+", 1)[0];
    return parent ? { kind: "plus", parent: `${parent}@${domain}` } : null;
  }
  return null;
}
