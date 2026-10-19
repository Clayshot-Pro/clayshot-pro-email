import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appConfig, domainOf, isValidAddress, isValidDomain, parseConfig } from "../src/worker/appConfig.ts";

// No instance vars are required: an empty Worker env is a valid configuration.
assert.deepEqual(parseConfig({}).features, { gmail: false, emailApi: false, emailBinding: false, resend: false, resendWebhook: false, setup: false });
assert.equal(parseConfig({ EMAIL: { send: async () => ({ messageId: "x" }) } }).features.emailBinding, true, "the send binding needs no token");
assert.equal(parseConfig({ EMAIL: "not a binding" }).features.emailBinding, false);

const full = parseConfig({
  GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", PROVIDER_CREDENTIAL_KEY: "key",
  VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv",
  CF_EMAIL_SENDING_ACCOUNT_ID: "a".repeat(32), CF_EMAIL_SENDING_TOKEN: "token",
  RESEND_API_KEY: "re_x", RESEND_WEBHOOK_SECRET: "whsec_x", AUTH_SETUP_TOKEN: "setup",
});
assert.deepEqual(full.features, { gmail: true, emailApi: true, emailBinding: false, resend: true, resendWebhook: true, setup: true });
assert.equal(parseConfig({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }).features.gmail, false, "Gmail also needs PROVIDER_CREDENTIAL_KEY");
assert.equal(parseConfig({ CF_EMAIL_SENDING_ACCOUNT_ID: "not-an-id", CF_EMAIL_SENDING_TOKEN: "t" }).features.emailApi, false);
assert.equal(parseConfig({ CF_EMAIL_SENDING_ACCOUNT_ID: "a".repeat(32) }).features.emailApi, false, "the token is required");
assert.equal(parseConfig({ RESEND_API_KEY: "   " }).features.resend, false, "blank secrets do not enable features");

const env = {};
assert.equal(appConfig(env), appConfig(env), "config is memoized per Env object");

assert.equal(isValidDomain("example.org"), true);
assert.equal(isValidDomain("-bad.example"), false);
assert.equal(isValidAddress("hello@example.com"), true);
assert.equal(isValidAddress("a..b@example.com"), false);
assert.equal(domainOf("hello@Example.com"), "Example.com");

// The Worker reads no instance vars: origin and admin identity come from the
// request; domains, branding and mail settings come from D1.
const typings = readFileSync(new URL("../worker-configuration.d.ts", import.meta.url), "utf8");
for (const retired of ["APP_ORIGIN", "PRIMARY_ADDRESS", "ADMIN_ADDRESS", "BRAND_NAME", "FORWARD_TO", "MULTI_SENDER_APPROVED",
  "MAILBOX_PURGE_ENABLED", "MAX_MAILBOXES", "MAIL_DOMAINS", "EMAIL_MULTI", "EMAIL_DYNAMIC"]) {
  assert.doesNotMatch(typings, new RegExp(`\\b${retired}\\b`), `${retired} is no longer part of the Worker environment`);
}
const source = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
for (const file of ["src/worker/index.ts", "src/worker/auth.ts", "src/worker/domains.ts", "src/worker/email/receive.ts",
  "src/worker/push.ts", "src/worker/providers/registry.ts", "src/worker/mailboxes.ts"]) {
  assert.doesNotMatch(source(file), /env\.(PRIMARY_ADDRESS|APP_ORIGIN|ADMIN_ADDRESS|FORWARD_TO|MAILBOX_PURGE_ENABLED)/, file);
}

console.log("PASS: Worker capabilities come from secrets only; no instance vars remain");
