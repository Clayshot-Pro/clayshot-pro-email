// v3.21: Admin → Keys shows what is set up, missing (essential) or optional.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";

const source = readFileSync(new URL("../src/client/keyStatus.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { keyChecklist, keySummary } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "CF_EMAIL_SENDING_TOKEN"]
  .map(name => ({ name, source: name === "RESEND_API_KEY" ? "stored" : "none" }));
const state = (checks, id) => checks.find(item => item.id === id);

// A fresh fork without the encryption key: both essentials are missing.
{
  const checks = keyChecklist({ encryption: false, keys, push: { source: "none" }, cloudflare: { connected: false } });
  assert.deepEqual(checks.slice(0, 2).map(item => [item.id, item.state, item.chip]),
    [["encryption", "missing", "Missing"], ["push", "missing", "Missing"]], "essential keys come first");
  assert.equal(state(checks, "cloudflare").chip, "Not connected");
  assert.equal(state(checks, "cloudflare").state, "optional");
  assert.equal(state(checks, "RESEND_API_KEY").state, "ok");
  assert.equal(state(checks, "GOOGLE_CLIENT_ID").chip, "Not set");
  const summary = keySummary(checks);
  assert.equal(summary.tone, "missing");
  assert.equal(summary.title, "Setup incomplete: missing encryption key and push notification keys");
  assert.match(state(checks, "push").impact, /once the encryption key is set/);
}

// Encryption set but push keys not generated yet: only push is missing.
{
  const checks = keyChecklist({ encryption: true, keys, push: { source: "none" } });
  assert.deepEqual(keySummary(checks).missing.map(item => item.id), ["push"]);
  assert.match(state(checks, "push").impact, /next request/);
  assert.equal(keySummary(checks).title, "Setup incomplete: missing push notification keys");
}

// Everything essential in place: green, with a count.
{
  const checks = keyChecklist({ encryption: true, keys, push: { source: "stored" }, cloudflare: { connected: true } });
  assert.equal(checks.filter(item => item.state === "missing").length, 0);
  assert.equal(state(checks, "cloudflare").chip, "Connected");
  const summary = keySummary(checks);
  assert.equal(summary.tone, "ok");
  assert.equal(summary.title, "Essential keys are set up · 4 of 8 configured");
}

// Unknown keys from a newer server are ignored rather than shown unlabeled.
assert.equal(keyChecklist({ encryption: true, keys: [{ name: "FUTURE_KEY", source: "stored" }], push: { source: "worker" } }).length, 3);

console.log("PASS: Keys setup status (set up, missing, optional) and summary");
