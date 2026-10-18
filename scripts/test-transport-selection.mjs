import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectTransport } from "../src/worker/transports/select.ts";

const base = { domainStatus: "active", domainTransport: "cloudflare", cloudflareConfigured: true, resendConfigured: false };
const pick = overrides => selectTransport({ ...base, ...overrides });

// Cloudflare (default): every active mailbox sends, via the EMAIL binding or the API.
assert.deepEqual(pick({}), { kind: "cloudflare" });
assert.match(pick({ cloudflareConfigured: false }).reason, /EMAIL send binding/);

// Resend is opt-in per domain and needs the API key.
assert.deepEqual(pick({ domainTransport: "resend", resendConfigured: true }), { kind: "resend" });
assert.deepEqual(pick({ domainTransport: "resend", resendConfigured: true, cloudflareConfigured: false }), { kind: "resend" });
assert.match(pick({ domainTransport: "resend" }).reason, /RESEND_API_KEY/);

// Receive-only and inactive domains never send.
assert.match(pick({ domainTransport: "none" }).reason, /receive-only/);
for (const domainStatus of ["pending", "disabled", null]) {
  assert.equal(pick({ domainStatus }).kind, "unavailable", String(domainStatus));
}

// The UI and the send handler use the same selection.
const registry = readFileSync(new URL("../src/worker/providers/registry.ts", import.meta.url), "utf8");
const send = readFileSync(new URL("../src/worker/email/send.ts", import.meta.url), "utf8");
const native = readFileSync(new URL("../src/worker/providers/native.ts", import.meta.url), "utf8");
assert.match(registry, /sendableMailboxes\(env, active\)/);
const transports = readFileSync(new URL("../src/worker/transports/index.ts", import.meta.url), "utf8");
assert.match(transports, /export async function sendableMailboxes[\s\S]*selectTransport\(/, "the account list uses the same selection");
assert.equal((transports.match(/cloudflareConfigured: features\.emailApi \|\| features\.emailBinding/g) ?? []).length, 2,
  "the send handler and the account list agree that the binding alone is enough");
assert.match(send, /transportChoice\(env, provider\.accountId, provider\.address\)/);
assert.match(native, /transportChoice\(this\.env, this\.accountId, this\.address\)/);
assert.doesNotMatch(native, /env\.EMAIL\b|EMAIL_MULTI|EMAIL_DYNAMIC|MULTI_SENDER/, "no send bindings or policy gate remain");
// From is always server-derived: the form's accountId resolves the provider, never a client "from".
assert.doesNotMatch(send, /form\.get\("from"\)/);
assert.match(send, /suppressed_recipients/, "suppressed recipients are checked before any transport runs");

console.log("PASS: outbound transport selection and sender derivation");
