// Single source of truth for the keys in .env.
//
// The Worker has no instance vars. The app origin and admin sign-in come from
// the request URL; the primary mailbox, domains, branding and mail settings
// live in D1 (first-run setup and the admin panel). .env only holds:
//   "secret" Worker secrets, uploaded with `wrangler secret bulk`, never rendered
//   "deploy" values used by local/CI scripts, never sent to the Worker as secrets
//            (CLOUDFLARE_ACCOUNT_ID is also rendered as the non-secret
//             CF_EMAIL_SENDING_ACCOUNT_ID so the Email Sending API needs no extra key)
import { readFileSync, existsSync } from "node:fs";

export const CONFIG = [
  { key: "PROVIDER_CREDENTIAL_KEY", kind: "secret", example: "", group: "Encryption",
    help: "Encrypts the keys and Gmail tokens stored in the database. npm run setup generates it. Back it up: changing it makes stored keys and connected Gmail accounts unreadable." },
  { key: "AUTH_SETUP_TOKEN", kind: "secret", example: "", group: "First-run setup",
    help: "One-time secret for choosing the primary mailbox and registering the owner passkey. Remove after setup." },
  { key: "CF_EMAIL_SENDING_TOKEN", kind: "secret", example: "", group: "Sending (optional; or set in Admin -> Keys)",
    help: "Optional. Cloudflare sending works without it through the Worker's send binding. Set an Email Sending token only to use the REST API instead." },
  { key: "GOOGLE_CLIENT_ID", kind: "secret", example: "", group: "Connected Gmail (optional; or set in Admin -> Keys)", help: "Google OAuth client ID." },
  { key: "GOOGLE_CLIENT_SECRET", kind: "secret", example: "", group: "Connected Gmail (optional; or set in Admin -> Keys)", help: "Google OAuth client secret." },
  { key: "VAPID_PUBLIC_KEY", kind: "secret", example: "", group: "Push notifications (optional; generated automatically when unset)", help: "Web Push public key (base64url)." },
  { key: "VAPID_PRIVATE_KEY", kind: "secret", example: "", group: "Push notifications (optional; generated automatically when unset)", help: "Web Push private key (base64url)." },
  { key: "RESEND_API_KEY", kind: "secret", example: "", group: "Resend (optional; or set in Admin -> Keys)",
    help: "Resend API key (sending access only). Enables Resend for domains the admin switches to it." },
  { key: "RESEND_WEBHOOK_SECRET", kind: "secret", example: "", group: "Resend (optional; or set in Admin -> Keys)", help: "Resend webhook signing secret (whsec_...)." },
  { key: "CLOUDFLARE_ACCOUNT_ID", kind: "deploy", required: true, example: "", group: "Cloudflare deployment",
    help: "Cloudflare account ID. Used by scripts and for the Email Sending API." },
  { key: "CLOUDFLARE_API_TOKEN", kind: "deploy", required: true, example: "", group: "Cloudflare deployment",
    help: "Deploy token with Workers Scripts edit, D1 edit, R2 edit and Account Settings read. Used by scripts only." },
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

export function missingRequired(values, kinds = ["secret", "deploy"]) {
  return CONFIG.filter(entry => entry.required && kinds.includes(entry.kind) && !String(values[entry.key] ?? "").trim())
    .map(entry => entry.key);
}

export function renderEnvExample() {
  const lines = [
    "# For deploying from your computer only. Copy to .env and fill in; .env is gitignored. Never commit it.",
    "# Automatic deploys from main need no .env: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN as GitHub",
    "# repository secrets (or Workers Builds build variables), PROVIDER_CREDENTIAL_KEY and AUTH_SETUP_TOKEN under",
    "# the Worker's Settings -> Variables & Secrets (type Secret), and the other keys in Admin -> Keys. See README step 2.",
    "# Generated from config/schema.mjs by `npm run config:example`. Do not edit by hand.",
    "#",
    "# Instance settings (primary mailbox, domains, branding, forwarding, limits) are not",
    "# configured here: choose them in first-run setup and the admin panel (stored in D1).",
    "#",
    "# secret -> uploaded as a Worker secret by `npm run secrets:push`",
    "# deploy -> used by local scripts and automatic deploys only, never by the running app",
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
