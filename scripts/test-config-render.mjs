import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFIG, keysOf, parseDotEnv, renderEnvExample } from "../config/schema.mjs";
import { PLACEHOLDER_DATABASE_ID, renderWrangler } from "./config-lib.mjs";

const template = readFileSync(new URL("../wrangler.template.jsonc", import.meta.url), "utf8");
const parseJsonc = text => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
const defaults = Object.fromEntries(CONFIG.filter(entry => entry.default).map(entry => [entry.key, entry.default]));

// Every key is classified once; .env only holds secrets and deploy keys.
assert.equal(new Set(CONFIG.map(entry => entry.key)).size, CONFIG.length, "duplicate config keys");
for (const entry of CONFIG) assert.ok(["secret", "deploy"].includes(entry.kind), `${entry.key} must be a secret or deploy key`);
for (const key of ["AUTH_SETUP_TOKEN", "CF_EMAIL_SENDING_TOKEN", "GOOGLE_CLIENT_SECRET", "PROVIDER_CREDENTIAL_KEY",
  "VAPID_PRIVATE_KEY", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"]) {
  assert.ok(keysOf("secret").includes(key), `${key} must be a secret`);
}
for (const retired of ["APP_ORIGIN", "PRIMARY_ADDRESS", "ADMIN_ADDRESS", "BRAND_NAME", "MAIL_DOMAINS", "FORWARD_TO", "MULTI_SENDER_APPROVED"]) {
  assert.ok(!CONFIG.some(entry => entry.key === retired), `${retired} is configured in D1, not .env`);
}

// Rendering keeps today's bindings: one unrestricted EMAIL send binding,
// no restricted per-address binding, and no instance vars.
const accountId = "0123456789abcdef0123456789abcdef";
const production = { ...defaults, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: "deploy-token-123456" };
const rendered = parseJsonc(renderWrangler(template, production, "11111111-2222-3333-4444-555555555555"));
const legacy = {
  name: "ltm-email-service",
  main: "./src/worker/index.ts",
  compatibility_date: "2026-09-12",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [{ binding: "DB", database_name: "ltm-email-service", migrations_dir: "./migrations" }],
  r2_buckets: [{ binding: "MAIL", bucket_name: "ltm-email-service-mail" }],
  triggers: { crons: ["0 4 * * *"] },
  observability: { enabled: true },
};
for (const [key, value] of Object.entries(legacy)) {
  const actual = key === "d1_databases"
    ? rendered.d1_databases.map(({ database_id: _id, ...rest }) => rest)
    : rendered[key];
  assert.deepEqual(actual, value, key);
}
assert.equal(rendered.d1_databases[0].database_id, "11111111-2222-3333-4444-555555555555");
assert.deepEqual(rendered.send_email, [{ name: "EMAIL" }], "one unrestricted send binding, no token needed");
assert.deepEqual(rendered.vars, { CF_EMAIL_SENDING_ACCOUNT_ID: accountId }, "the account ID is the only Worker var");
assert.deepEqual(parseJsonc(renderWrangler(template, { ...defaults }, PLACEHOLDER_DATABASE_ID)).vars, {}, "no account ID, no vars");
assert.deepEqual(rendered.assets.run_worker_first, ["/api/*", "/", "/index.html", "/manifest.webmanifest"]);

// Secrets never reach the rendered file, even if mis-set.
const withSecrets = { ...production, RESEND_API_KEY: "re_super_secret_value", AUTH_SETUP_TOKEN: "setup-token-1234567890" };
const text = renderWrangler(template, withSecrets, PLACEHOLDER_DATABASE_ID);
assert.ok(!text.includes("re_super_secret_value"));
assert.ok(!text.includes("setup-token-1234567890"));
assert.ok(!text.includes("deploy-token-123456"), "the deploy token is never rendered");
assert.throws(() => renderWrangler(template.replace("__VARS__\"", "__VARS__\", \"leak\": \"re_super_secret_value\""), withSecrets, PLACEHOLDER_DATABASE_ID),
  /RESEND_API_KEY/, "a secret value appearing anywhere in the output is refused");
assert.throws(() => renderWrangler(template, { ...production, WORKER_NAME: "" }, PLACEHOLDER_DATABASE_ID), /Missing value/);
const escaped = parseJsonc(renderWrangler(template, { ...production, WORKER_NAME: "odd\"name" }, PLACEHOLDER_DATABASE_ID));
assert.equal(escaped.name, "odd\"name", "values cannot break out of their JSON string");

// .env parsing.
assert.deepEqual(parseDotEnv([
  "# comment", "A=1", "export B = two words # trailing", "C=\"quoted # kept\"", "D='single'", "E=", "bad line",
].join("\n")), { A: "1", B: "two words", C: "quoted # kept", D: "single", E: "" });

// .env.example is generated, never hand-edited.
const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.equal(example, renderEnvExample(), ".env.example is stale; run npm run config:example");
for (const entry of CONFIG) assert.match(example, new RegExp(`^${entry.key}=`, "m"));

console.log("PASS: config schema, wrangler rendering, secret exclusion and .env handling");
