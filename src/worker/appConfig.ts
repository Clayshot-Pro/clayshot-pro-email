/**
 * Typed instance configuration derived from Worker vars and secrets.
 *
 * Pure and dependency-free so it can be unit tested without the Cloudflare
 * runtime. Every instance-specific value (origin, addresses, brand) must come
 * from here rather than from source constants.
 */
export type AppConfig = {
  origin: string;
  rpId: string;
  primaryAddress: string;
  primaryDomain: string;
  adminAddress: string;
  brand: { name: string; shortName: string };
  ownerDisplayName: string;
  primaryDisplayName: string;
  forwardTo: string | null;
  mailDomains: string[];
  brandingSource: "admin" | "env";
  features: {
    gmail: boolean;
    push: boolean;
    multiSender: boolean;
    purge: boolean;
    resend: boolean;
    resendWebhook: boolean;
  };
  limits: { maxMailboxes: number };
};

export type ConfigSource = Record<string, unknown>;

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Instance configuration invalid: ${problems.join(", ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const EMAIL = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function text(source: ConfigSource, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function safeLabel(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function isValidDomain(value: string): boolean {
  return DOMAIN.test(value) && !value.split(".").some(label => label.startsWith("-") || label.endsWith("-"));
}

export function isValidAddress(value: string): boolean {
  if (value.length > 254 || !EMAIL.test(value)) return false;
  const [local, domain] = value.split("@");
  return local.length <= 64 && !local.includes("..") && isValidDomain(domain);
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

function parseOrigin(raw: string, problems: string[]): { origin: string; rpId: string } {
  try {
    const url = new URL(raw);
    const local = LOCAL_HOSTS.has(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
      || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      problems.push("APP_ORIGIN must be an https origin without a path");
      return { origin: "", rpId: "" };
    }
    return { origin: url.origin, rpId: url.hostname };
  } catch {
    problems.push(raw ? "APP_ORIGIN is not a valid URL" : "APP_ORIGIN is required");
    return { origin: "", rpId: "" };
  }
}

function address(source: ConfigSource, key: string, problems: string[]): string {
  const value = text(source, key).toLowerCase();
  if (!value) problems.push(`${key} is required`);
  else if (!isValidAddress(value)) problems.push(`${key} is not a valid email address`);
  return value;
}

/** Parse and validate configuration. Throws ConfigError listing key names only. */
export function parseConfig(source: ConfigSource): AppConfig {
  const problems: string[] = [];
  const { origin, rpId } = parseOrigin(text(source, "APP_ORIGIN"), problems);
  const primaryAddress = address(source, "PRIMARY_ADDRESS", problems);
  const adminAddress = address(source, "ADMIN_ADDRESS", problems);
  if (primaryAddress && primaryAddress === adminAddress) problems.push("ADMIN_ADDRESS must differ from PRIMARY_ADDRESS");

  const forwardRaw = text(source, "FORWARD_TO").toLowerCase();
  if (forwardRaw && !isValidAddress(forwardRaw)) problems.push("FORWARD_TO is not a valid email address");

  const primaryDomain = primaryAddress ? domainOf(primaryAddress) : "";
  const mailDomains = [...new Set(text(source, "MAIL_DOMAINS").toLowerCase().split(/[\s,]+/).filter(Boolean))];
  for (const domain of mailDomains) {
    if (!isValidDomain(domain)) problems.push("MAIL_DOMAINS contains an invalid domain");
  }

  const maxRaw = text(source, "MAX_MAILBOXES");
  const maxMailboxes = maxRaw ? Number(maxRaw) : 100;
  if (!Number.isInteger(maxMailboxes) || maxMailboxes < 1 || maxMailboxes > 10_000) {
    problems.push("MAX_MAILBOXES must be an integer between 1 and 10000");
  }

  const brandingSource = text(source, "BRANDING_SOURCE").toLowerCase() || "admin";
  if (brandingSource !== "admin" && brandingSource !== "env") problems.push("BRANDING_SOURCE must be admin or env");

  if (problems.length) throw new ConfigError([...new Set(problems)]);

  const brandName = safeLabel(text(source, "BRAND_NAME"), 40) || "Mail";
  const shortName = safeLabel(text(source, "BRAND_SHORT_NAME"), 20) || brandName.slice(0, 20);
  const has = (key: string) => text(source, key).length > 0;

  return {
    origin,
    rpId,
    primaryAddress,
    primaryDomain,
    adminAddress,
    brand: { name: brandName, shortName },
    ownerDisplayName: safeLabel(text(source, "OWNER_DISPLAY_NAME"), 80) || brandName,
    primaryDisplayName: safeLabel(text(source, "PRIMARY_DISPLAY_NAME"), 80) || brandName,
    forwardTo: forwardRaw || null,
    mailDomains: mailDomains.filter(domain => domain !== primaryDomain),
    brandingSource: brandingSource as "admin" | "env",
    features: {
      gmail: has("GOOGLE_CLIENT_ID") && has("GOOGLE_CLIENT_SECRET") && has("PROVIDER_CREDENTIAL_KEY"),
      push: has("VAPID_PUBLIC_KEY") && has("VAPID_PRIVATE_KEY"),
      multiSender: text(source, "MULTI_SENDER_APPROVED") === "true",
      purge: text(source, "MAILBOX_PURGE_ENABLED") === "true",
      resend: has("RESEND_API_KEY"),
      resendWebhook: has("RESEND_WEBHOOK_SECRET"),
    },
    limits: { maxMailboxes },
  };
}

const cache = new WeakMap<object, AppConfig>();

/** Memoized per Env object; throws ConfigError when required values are missing. */
export function appConfig(env: object): AppConfig {
  const cached = cache.get(env);
  if (cached) return cached;
  const config = parseConfig(env as ConfigSource);
  cache.set(env, config);
  return config;
}

/** Public, unauthenticated subset. Never include addresses or secrets. */
export function publicInstanceInfo(config: AppConfig) {
  return {
    brandName: config.brand.name,
    brandShortName: config.brand.shortName,
    primaryDomain: config.primaryDomain,
    features: { gmail: config.features.gmail, push: config.features.push },
  };
}
