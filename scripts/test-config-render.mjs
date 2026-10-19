import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFIG, keysOf, loadConfigValues, parseDotEnv, renderEnvExample } from "../config/schema.mjs";
import { parseJsonc, wranglerDefaults } from "../config/wrangler-file.mjs";
import { renderWrangler } from "./config-lib.mjs";

const committedText = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const committed = parseJsonc(committedText);
const defaults = wranglerDefaults(committed);
const DB_ID = "11111111-2222-3333-4444-555555555555";

// The committed wrangler.jsonc is the Deploy to Cloudflare button's source: no
// account-specific IDs, resources named so the button can create them.
assert.equal(committed.d1_databases[0].database_id, undefined, "no D1 database ID is committed");
assert.deepEqual(defaults, { WORKER_NAME: "ltm-email-service", D1_DATABASE_NAME: "ltm-email-service",
  R2_BUCKET_NAME: "ltm-email-service-mail", D1_DATABASE_ID: "" });
assert.deepEqual(committed.vars, { LTM_WORKER_NAME: "ltm-email-service" }, "the Worker knows its own name");
assert.deepEqual(committed.version_metadata, { binding: "CF_VERSION_METADATA" });
assert.doesNotMatch(committedText, /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-/, "no account or database IDs in the committed file");
// Names in .env and CI variables still win; otherwise they come from the file.
const saved = process.env.WORKER_NAME;
process.env.WORKER_NAME = "custom-mail";
assert.equal(loadConfigValues(new URL("file:///nonexistent/.env")).values.WORKER_NAME, "custom-mail");
delete process.env.WORKER_NAME;
assert.equal(loadConfigValues(new URL("file:///nonexistent/.env")).values.WORKER_NAME, "ltm-email-service");
if (saved !== undefined) process.env.WORKER_NAME = saved;
assert.match(parseJsonc('{ "a": "x // not a comment", /* c */ "b": [1, 2,], }').a, /not a comment/);

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
const rendered = parseJsonc(renderWrangler(committed, production, DB_ID));
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
assert.equal(rendered.d1_databases[0].database_id, DB_ID);
assert.equal(committed.d1_databases[0].database_id, undefined, "rendering never changes the parsed base");
assert.deepEqual(rendered.send_email, [{ name: "EMAIL" }], "one unrestricted send binding, no token needed");
assert.deepEqual(rendered.vars, { LTM_WORKER_NAME: "ltm-email-service", CF_EMAIL_SENDING_ACCOUNT_ID: accountId },
  "the Worker's name and the account ID are the only Worker vars");
assert.deepEqual(parseJsonc(renderWrangler(committed, { ...defaults }, DB_ID)).vars, { LTM_WORKER_NAME: "ltm-email-service" }, "no account ID, no account var");
const renamed = parseJsonc(renderWrangler(committed, { ...defaults, WORKER_NAME: "mail-two", R2_BUCKET_NAME: "mail-two-r2" }, DB_ID));
assert.equal(renamed.name, "mail-two");
assert.equal(renamed.vars.LTM_WORKER_NAME, "mail-two", "the name var follows a renamed Worker");
assert.equal(renamed.r2_buckets[0].bucket_name, "mail-two-r2");
assert.deepEqual(rendered.version_metadata, { binding: "CF_VERSION_METADATA" });
assert.deepEqual(rendered.assets.run_worker_first, ["/api/*", "/", "/index.html", "/manifest.webmanifest"]);

// Secrets never reach the rendered file, even if mis-set.
const withSecrets = { ...production, RESEND_API_KEY: "re_super_secret_value", AUTH_SETUP_TOKEN: "setup-token-1234567890" };
const text = renderWrangler(committed, withSecrets, DB_ID);
assert.ok(!text.includes("re_super_secret_value"));
assert.ok(!text.includes("setup-token-1234567890"));
assert.ok(!text.includes("deploy-token-123456"), "the deploy token is never rendered");
assert.throws(() => renderWrangler({ ...committed, leak: "re_super_secret_value" }, withSecrets, DB_ID),
  /RESEND_API_KEY/, "a secret value appearing anywhere in the output is refused");
assert.throws(() => renderWrangler(committed, { ...production, WORKER_NAME: "" }, DB_ID), /Missing value/);
assert.throws(() => renderWrangler(committed, production, ""), /Missing value for D1_DATABASE_ID/);
const escaped = parseJsonc(renderWrangler(committed, { ...production, WORKER_NAME: "odd\"name" }, DB_ID));
assert.equal(escaped.name, "odd\"name", "values cannot break out of their JSON string");

// .env parsing.
assert.deepEqual(parseDotEnv([
  "# comment", "A=1", "export B = two words # trailing", "C=\"quoted # kept\"", "D='single'", "E=", "bad line",
].join("\n")), { A: "1", B: "two words", C: "quoted # kept", D: "single", E: "" });

// config/env.example is generated, never hand-edited. It is not .env.example or
// .dev.vars.example: the Deploy to Cloudflare button would ask for every key in those.
const example = readFileSync(new URL("../config/env.example", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.equal(example, renderEnvExample(), "config/env.example is stale; run npm run config:example");
for (const asked of [".env.example", ".dev.vars.example"]) {
  assert.throws(() => readFileSync(new URL(`../${asked}`, import.meta.url)), /ENOENT/, `${asked} would make the Deploy button ask for secrets`);
}
for (const entry of CONFIG) assert.match(example, new RegExp(`^${entry.key}=`, "m"));

console.log("PASS: config schema, wrangler rendering, secret exclusion and .env handling");
