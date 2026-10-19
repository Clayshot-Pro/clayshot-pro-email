/**
 * Runtime capabilities derived from Worker secrets. Pure and dependency-free.
 *
 * The Worker has no instance vars: the origin and admin sign-in come from the
 * request URL (config.ts), and domains, the admin@ mailbox, branding and mail
 * settings live in D1 (domains.ts, branding.ts). Only secrets, the
 * build-filled CF_EMAIL_SENDING_ACCOUNT_ID and the EMAIL binding are read here.
 */
export type AppConfig = {
  features: {
    gmail: boolean;
    emailApi: boolean;
    /** The EMAIL send binding is bound (no token needed). */
    emailBinding: boolean;
    resend: boolean;
    resendWebhook: boolean;
    setup: boolean;
  };
};

export type ConfigSource = Record<string, unknown>;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const EMAIL = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

const text = (source: ConfigSource, key: string): string => {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
};

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

export function parseConfig(source: ConfigSource): AppConfig {
  const has = (key: string) => text(source, key).length > 0;
  return {
    features: {
      gmail: has("GOOGLE_CLIENT_ID") && has("GOOGLE_CLIENT_SECRET") && has("PROVIDER_CREDENTIAL_KEY"),
      emailApi: /^[a-f0-9]{32}$/i.test(text(source, "CF_EMAIL_SENDING_ACCOUNT_ID")) && has("CF_EMAIL_SENDING_TOKEN"),
      emailBinding: typeof (source.EMAIL as { send?: unknown } | undefined)?.send === "function",
      resend: has("RESEND_API_KEY"),
      resendWebhook: has("RESEND_WEBHOOK_SECRET"),
      setup: has("AUTH_SETUP_TOKEN"),
    },
  };
}

const cache = new WeakMap<object, AppConfig>();

/** Memoized per Env object. Never throws: every capability is optional. */
export function appConfig(env: object): AppConfig {
  const cached = cache.get(env);
  if (cached) return cached;
  const config = parseConfig(env as ConfigSource);
  cache.set(env, config);
  return config;
}
