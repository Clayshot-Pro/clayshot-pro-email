import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFIG, keysOf, parseDotEnv, renderEnvExample } from "../config/schema.mjs";
import { PLACEHOLDER_DATABASE_ID, renderWrangler, withPlaceholders } from "./config-lib.mjs";

const template = readFileSync(new URL("../wrangler.template.jsonc", import.meta.url), "utf8");
const parseJsonc = text => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
const defaults = Object.fromEntries(CONFIG.filter(entry => entry.default).map(entry => [entry.key, entry.default]));

// Every key is classified exactly once and secrets are never vars.
assert.equal(new Set(CONFIG.map(entry => entry.key)).size, CONFIG.length, "duplicate config keys");
for (const entry of CONFIG) assert.ok(["var", "secret", "deploy"].includes(entry.kind), entry.key);
for (const key of ["AUTH_SETUP_TOKEN", "GOOGLE_CLIENT_SECRET", "PROVIDER_CREDENTIAL_KEY", "VAPID_PRIVATE_KEY", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"]) {
  assert.ok(keysOf("secret").includes(key), `${key} must be a secret`);
}
assert.ok(!keysOf("var").includes("CLOUDFLARE_API_TOKEN"));

// The rendered config for the existing production values matches today's
// wrangler.jsonc apart from the deliberately added worker-first routes.
const production = {
  ...defaults,
  APP_ORIGIN: "https://email.liamthemo.com",
  PRIMARY_ADDRESS: "contact@liamthemo.com",
  ADMIN_ADDRESS: "admin@liamthemo.com",
  BRAND_NAME: "LTM Mails",
};
const rendered = parseJsonc(renderWrangler(template, production, "11111111-2222-3333-4444-555555555555"));
const legacy = {
  name: "ltm-email-service",
  main: "./src/worker/index.ts",
  compatibility_date: "2026-09-12",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [{ binding: "DB", database_name: "ltm-email-service", migrations_dir: "./migrations" }],
  r2_buckets: [{ binding: "MAIL", bucket_name: "ltm-email-service-mail" }],
  send_email: [{ name: "EMAIL", allowed_sender_addresses: ["contact@liamthemo.com"] }, { name: "EMAIL_MULTI" }],
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
assert.deepEqual(rendered.assets.run_worker_first, ["/api/*", "/", "/index.html", "/manifest.webmanifest"]);
assert.equal(rendered.vars.PRIMARY_ADDRESS, "contact@liamthemo.com");
assert.equal(rendered.vars.APP_ORIGIN, "https://email.liamthemo.com");
assert.equal(rendered.vars.FORWARD_TO, undefined, "empty vars are omitted");

// Secrets never reach the rendered file, even if mis-set.
const withSecrets = { ...production, RESEND_API_KEY: "re_super_secret_value", AUTH_SETUP_TOKEN: "setup-token-1234567890" };
const text = renderWrangler(template, withSecrets, PLACEHOLDER_DATABASE_ID);
assert.ok(!text.includes("re_super_secret_value"));
assert.ok(!text.includes("setup-token-1234567890"));
assert.throws(() => renderWrangler(template.replace("__VARS__\"", "__VARS__\", \"leak\": \"re_super_secret_value\""), withSecrets, PLACEHOLDER_DATABASE_ID),
  /RESEND_API_KEY/, "a secret value appearing anywhere in the output is refused");

// JSON-escaping: values cannot break out of their string.
assert.throws(() => renderWrangler(template, { ...production, WORKER_NAME: "" }, PLACEHOLDER_DATABASE_ID), /Missing value/);
const escaped = parseJsonc(renderWrangler(template, { ...production, BRAND_NAME: "Quote \" and \\ slash" }, PLACEHOLDER_DATABASE_ID));
assert.equal(escaped.vars.BRAND_NAME, "Quote \" and \\ slash");

// Placeholder builds never look deployable.
const { values, used } = withPlaceholders({ ...defaults });
assert.deepEqual(used.sort(), ["ADMIN_ADDRESS", "APP_ORIGIN", "PRIMARY_ADDRESS"]);
assert.ok(values.APP_ORIGIN.includes("example.com"));

// .env parsing.
assert.deepEqual(parseDotEnv([
  "# comment", "A=1", "export B = two words # trailing", "C=\"quoted # kept\"", "D='single'", "E=", "bad line",
].join("\n")), { A: "1", B: "two words", C: "quoted # kept", D: "single", E: "" });

// .env.example is generated, never hand-edited.
const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.equal(example, renderEnvExample(), ".env.example is stale; run npm run config:example");
for (const entry of CONFIG) assert.match(example, new RegExp(`^${entry.key}=`, "m"));

console.log("PASS: config schema, wrangler rendering parity, secret exclusion and .env handling");
