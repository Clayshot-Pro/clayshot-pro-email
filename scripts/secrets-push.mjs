// Upload every non-empty `kind: "secret"` value from .env as Worker secrets via
// `wrangler secret bulk`. Values are written to a private temp file that is
// deleted immediately; only key names are printed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keysOf, loadConfigValues } from "../config/schema.mjs";

const { values, hasFile } = loadConfigValues();
if (!hasFile) throw new Error("No .env file found. Copy .env.example to .env first.");

const secrets = {};
for (const key of keysOf("secret")) {
  const value = String(values[key] ?? "").trim();
  if (value) secrets[key] = value;
}
const names = Object.keys(secrets);
if (!names.length) {
  console.log("No secret values set in .env; nothing to upload.");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "ltm-secrets-"));
const file = join(dir, "secrets.json");
try {
  writeFileSync(file, JSON.stringify(secrets), { encoding: "utf8", mode: 0o600 });
  const result = spawnSync("npx", ["wrangler", "secret", "bulk", file, "--name", values.WORKER_NAME], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`Uploaded Worker secrets: ${names.join(", ")}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// CF_EMAIL_SENDING_ACCOUNT_ID is rendered as a plain var, which cannot share a
// name with a secret; older installs may also hold secrets v3 no longer reads.
// Report names only, so the operator can delete them once.
const RENDERED_VARS = ["CF_EMAIL_SENDING_ACCOUNT_ID"];
const RETIRED = ["APP_ORIGIN", "PRIMARY_ADDRESS", "ADMIN_ADDRESS", "FORWARD_TO", "MULTI_SENDER_APPROVED", "MAILBOX_PURGE_ENABLED"];
const listed = spawnSync("npx", ["wrangler", "secret", "list", "--name", values.WORKER_NAME, "--format", "json"], {
  encoding: "utf8", shell: process.platform === "win32",
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN },
});
let existing = [];
try { existing = JSON.parse(listed.stdout.slice(listed.stdout.indexOf("["))).map(entry => entry.name); } catch { /* listing is advisory */ }
const conflicting = existing.filter(name => RENDERED_VARS.includes(name));
if (conflicting.length) {
  console.warn(`These secrets are now plain vars and must be deleted before deploying:\n${conflicting
    .map(name => `  npx wrangler secret delete ${name} --name ${values.WORKER_NAME}`).join("\n")}`);
}
const retired = existing.filter(name => RETIRED.includes(name));
if (retired.length) {
  console.warn(`These secrets are no longer used (settings now live in D1) and can be deleted: ${retired.join(", ")}`);
}
