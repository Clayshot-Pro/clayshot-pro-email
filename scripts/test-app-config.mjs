import assert from "node:assert/strict";
import { appConfig, ConfigError, parseConfig, publicInstanceInfo } from "../src/worker/appConfig.ts";

const base = {
  APP_ORIGIN: "https://mail.example.com",
  PRIMARY_ADDRESS: "Hello@Example.com",
  ADMIN_ADDRESS: "admin@example.com",
};

const config = parseConfig(base);
assert.equal(config.origin, "https://mail.example.com");
assert.equal(config.rpId, "mail.example.com", "RP ID is derived from the origin host");
assert.equal(config.primaryAddress, "hello@example.com", "addresses are normalized to lower case");
assert.equal(config.primaryDomain, "example.com");
assert.equal(config.brand.name, "Mail", "brand has a neutral default");
assert.equal(config.ownerDisplayName, "Mail");
assert.equal(config.limits.maxMailboxes, 100);
assert.equal(config.brandingSource, "admin");
assert.deepEqual(config.features, { gmail: false, push: false, multiSender: false, purge: false, resend: false, resendWebhook: false });
assert.equal(parseConfig({ ...base, APP_ORIGIN: "https://mail.example.com/" }).origin, "https://mail.example.com");
assert.equal(parseConfig({ ...base, APP_ORIGIN: "http://localhost:5173" }).rpId, "localhost", "local http is allowed for dev");

// Feature flags are derived from what is configured, not requested.
const full = parseConfig({
  ...base, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret",
  VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", MULTI_SENDER_APPROVED: "true",
  MAILBOX_PURGE_ENABLED: "true", RESEND_API_KEY: "re_x", RESEND_WEBHOOK_SECRET: "whsec_x",
  BRAND_NAME: " Example <Mail> ", MAIL_DOMAINS: "example.org, EXAMPLE.net example.com", MAX_MAILBOXES: "5",
  BRANDING_SOURCE: "env",
});
assert.equal(full.features.gmail, false, "Gmail also needs PROVIDER_CREDENTIAL_KEY");
assert.equal(full.features.push && full.features.multiSender && full.features.purge && full.features.resend, true);
assert.equal(full.brand.name, "Example Mail", "markup characters are stripped from labels");
assert.deepEqual(full.mailDomains, ["example.org", "example.net"], "seed list excludes the primary domain");
assert.equal(full.limits.maxMailboxes, 5);
assert.equal(full.brandingSource, "env");
assert.equal(parseConfig({ ...base, GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", PROVIDER_CREDENTIAL_KEY: "c" }).features.gmail, true);

function problems(source) {
  try { parseConfig(source); } catch (error) { assert.ok(error instanceof ConfigError); return error.problems.join(" | "); }
  return "";
}
assert.match(problems({}), /APP_ORIGIN is required/);
assert.match(problems({}), /PRIMARY_ADDRESS is required/);
assert.match(problems({}), /ADMIN_ADDRESS is required/);
assert.match(problems({ ...base, APP_ORIGIN: "http://mail.example.com" }), /https origin/);
assert.match(problems({ ...base, APP_ORIGIN: "https://mail.example.com/app" }), /without a path/);
assert.match(problems({ ...base, APP_ORIGIN: "https://user:pw@mail.example.com" }), /https origin/);
assert.match(problems({ ...base, PRIMARY_ADDRESS: "not-an-address" }), /PRIMARY_ADDRESS is not a valid/);
assert.match(problems({ ...base, ADMIN_ADDRESS: base.PRIMARY_ADDRESS.toLowerCase() }), /must differ/);
assert.match(problems({ ...base, MAX_MAILBOXES: "0" }), /MAX_MAILBOXES/);
assert.match(problems({ ...base, MAIL_DOMAINS: "bad_domain" }), /MAIL_DOMAINS/);
assert.match(problems({ ...base, FORWARD_TO: "nope" }), /FORWARD_TO/);
assert.match(problems({ ...base, BRANDING_SOURCE: "db" }), /BRANDING_SOURCE/);
assert.doesNotMatch(problems({ ...base, PRIMARY_ADDRESS: "secret-value" }), /secret-value/, "errors name keys, never values");

const env = { ...base };
assert.equal(appConfig(env), appConfig(env), "config is memoized per Env object");

const info = publicInstanceInfo(full);
assert.deepEqual(Object.keys(info).sort(), ["brandName", "brandShortName", "features", "primaryDomain"]);
assert.ok(!JSON.stringify(info).includes("admin@"), "public info never includes the admin address");
assert.ok(!JSON.stringify(info).includes("hello@"), "public info never includes mailbox addresses");

console.log("PASS: instance config validation, derived values, feature flags and public subset");
