// Single source of truth for instance configuration keys.
//
// kind:
//   "var"    plain Worker var, rendered into wrangler.jsonc "vars"
//   "secret" Worker secret, uploaded with `wrangler secret bulk`, never rendered
//   "deploy" used only by local/CI scripts, never sent to the Worker
import { readFileSync, existsSync } from "node:fs";

export const CONFIG = [
  { key: "APP_ORIGIN", kind: "var", required: true, example: "https://mail.example.com",
    group: "Instance", help: "Public origin of the web app. Passkeys are bound to this host; do not change it after setup." },
  { key: "PRIMARY_ADDRESS", kind: "var", required: true, example: "hello@example.com",
    group: "Instance", help: "The primary native mailbox. Its domain is the primary mail domain." },
  { key: "ADMIN_ADDRESS", kind: "var", required: true, example: "admin@example.com",
    group: "Instance", help: "Reserved administrator sign-in (password + passkey). Not a mailbox." },
  { key: "BRAND_NAME", kind: "var", example: "Example Mail", group: "Branding", help: "App name shown in the UI, tab title and PWA." },
  { key: "BRAND_SHORT_NAME", kind: "var", example: "Mail", group: "Branding", help: "Short PWA name (home screen label)." },
  { key: "OWNER_DISPLAY_NAME", kind: "var", example: "Alex", group: "Branding", help: "Sender name used for the primary mailbox." },
  { key: "PRIMARY_DISPLAY_NAME", kind: "var", example: "Example Mail", group: "Branding", help: "Label for the primary mailbox in account lists." },
  { key: "BRANDING_SOURCE", kind: "var", example: "admin", group: "Branding",
    help: "admin = branding editable in the admin panel; env = these values always win and the admin UI is read-only." },
  { key: "MAIL_DOMAINS", kind: "var", example: "", group: "Mail",
    help: "Optional comma-separated extra mail domains, created as pending. Removing one here never disables it." },
  { key: "FORWARD_TO", kind: "var", example: "", group: "Mail", help: "Optional address that receives a copy of primary-mailbox mail." },
  { key: "MAX_MAILBOXES", kind: "var", example: "100", group: "Mail", help: "Maximum native mailboxes across all domains." },
  { key: "MULTI_SENDER_APPROVED", kind: "var", example: "false", group: "Mail",
    help: "true lets non-primary mailboxes send through Cloudflare Email Sending. Only enable if Cloudflare's terms allow your use." },
  { key: "MAILBOX_PURGE_ENABLED", kind: "var", example: "false", group: "Mail",
    help: "true lets the daily cron permanently purge mailboxes past their 30-day grace period." },
  { key: "AUTH_SETUP_TOKEN", kind: "secret", example: "", group: "Secrets",
    help: "One-time secret for registering the owner passkey. Remove after setup." },
  { key: "PROVIDER_CREDENTIAL_KEY", kind: "secret", example: "", group: "Secrets",
    help: "Encrypts stored Gmail OAuth tokens. Required for Gmail. Changing it invalidates connected accounts." },
  { key: "GOOGLE_CLIENT_ID", kind: "secret", example: "", group: "Secrets", help: "Google OAuth client for connected Gmail accounts." },
  { key: "GOOGLE_CLIENT_SECRET", kind: "secret", example: "", group: "Secrets", help: "Google OAuth client secret." },
  { key: "VAPID_PUBLIC_KEY", kind: "secret", example: "", group: "Secrets", help: "Web Push public key (base64url)." },
  { key: "VAPID_PRIVATE_KEY", kind: "secret", example: "", group: "Secrets", help: "Web Push private key (base64url)." },
  { key: "RESEND_API_KEY", kind: "secret", example: "", group: "Secrets",
    help: "Optional Resend API key (sending access only). Enables the Resend transport for domains switched to it." },
  { key: "RESEND_WEBHOOK_SECRET", kind: "secret", example: "", group: "Secrets", help: "Resend webhook signing secret (whsec_...)." },
  { key: "CLOUDFLARE_ACCOUNT_ID", kind: "deploy", required: true, example: "", group: "Cloudflare deployment",
    help: "Cloudflare account ID. Used by scripts only." },
  { key: "CLOUDFLARE_API_TOKEN", kind: "deploy", required: true, example: "", group: "Cloudflare deployment",
    help: "API token with Workers Scripts edit, D1 edit, R2 edit and Account Settings read. Used by scripts only." },
  { key: "WORKER_NAME", kind: "deploy", default: "ltm-email-service", example: "ltm-email-service", group: "Cloudflare deployment" },
  { key: "D1_DATABASE_NAME", kind: "deploy", default: "ltm-email-service", example: "ltm-email-service", group: "Cloudflare deployment" },
  { key: "D1_DATABASE_ID", kind: "deploy", example: "", group: "Cloudflare deployment",
    help: "Optional. Resolved by name through the Cloudflare API when empty; `npm run setup` fills it in." },
  { key: "R2_BUCKET_NAME", kind: "deploy", default: "ltm-email-service-mail", example: "ltm-email-service-mail", group: "Cloudflare deployment" },
];

export const keysOf = kind => CONFIG.filter(entry => entry.kind === kind).map(entry => entry.key);

/** Minimal .env parser: KEY=value, optional quotes, # comments, no interpolation. */
export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === "\"" || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === "\"") value = value.replace(/\\n/g, "\n").replace(/\\"/g, "\"");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

/** Process env wins over the file so CI build variables override a local .env. */
export function loadConfigValues(envFile = new URL("../.env", import.meta.url)) {
  const file = existsSync(envFile) ? parseDotEnv(readFileSync(envFile, "utf8")) : {};
  const values = {};
  for (const entry of CONFIG) {
    const fromProcess = process.env[entry.key];
    const value = (fromProcess !== undefined && fromProcess !== "" ? fromProcess : file[entry.key]) ?? "";
    values[entry.key] = value === "" && entry.default !== undefined ? entry.default : value;
  }
  return { values, hasFile: existsSync(envFile) };
}

export function missingRequired(values, kinds = ["var", "secret", "deploy"]) {
  return CONFIG.filter(entry => entry.required && kinds.includes(entry.kind) && !String(values[entry.key] ?? "").trim())
    .map(entry => entry.key);
}

export function renderEnvExample() {
  const lines = [
    "# Instance configuration. Copy to .env and fill in; .env is gitignored.",
    "# Generated from config/schema.mjs by `npm run config:example`. Do not edit by hand.",
    "#",
    "# var    -> plain Worker var (rendered into wrangler.jsonc)",
    "# secret -> uploaded as a Worker secret by `npm run secrets:push`, never written to wrangler.jsonc",
    "# deploy -> used by local scripts only",
  ];
  let group = "";
  for (const entry of CONFIG) {
    if (entry.group !== group) {
      group = entry.group;
      lines.push("", `# --- ${group} ---`);
    }
    const flags = [entry.kind, entry.required ? "required" : "optional"].join(", ");
    lines.push(`# ${entry.help ? entry.help + " " : ""}(${flags})`);
    lines.push(`${entry.key}=${entry.example ?? ""}`);
  }
  return lines.join("\n") + "\n";
}
