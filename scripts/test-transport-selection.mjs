import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectTransport } from "../src/worker/transports/select.ts";

const base = { isPrimaryMailbox: false, domainStatus: "active", domainTransport: "cloudflare", multiSenderApproved: false, resendConfigured: false };
const pick = overrides => selectTransport({ ...base, ...overrides });

// Cloudflare (default): primary always uses the restricted EMAIL binding.
assert.deepEqual(pick({ isPrimaryMailbox: true }), { kind: "cloudflare", binding: "EMAIL" });
assert.deepEqual(pick({ isPrimaryMailbox: true, multiSenderApproved: true }), { kind: "cloudflare", binding: "EMAIL" });
// Other Cloudflare senders stay behind the MULTI_SENDER_APPROVED policy gate.
assert.equal(pick({}).kind, "unavailable");
assert.deepEqual(pick({ multiSenderApproved: true }), { kind: "cloudflare", binding: "EMAIL_MULTI" });

// Resend is opt-in per domain and needs the API key; the Cloudflare gate does not apply.
assert.deepEqual(pick({ domainTransport: "resend", resendConfigured: true }), { kind: "resend" });
assert.deepEqual(pick({ domainTransport: "resend", resendConfigured: true, isPrimaryMailbox: true }), { kind: "resend" });
assert.match(pick({ domainTransport: "resend" }).reason, /RESEND_API_KEY/);

// Receive-only and inactive domains never send.
assert.match(pick({ domainTransport: "none", isPrimaryMailbox: true }).reason, /receive-only/);
for (const domainStatus of ["pending", "disabled", null]) {
  assert.equal(pick({ domainStatus, isPrimaryMailbox: true, multiSenderApproved: true }).kind, "unavailable", String(domainStatus));
}

// The UI and the send handler use the same selection.
const registry = readFileSync(new URL("../src/worker/providers/registry.ts", import.meta.url), "utf8");
const send = readFileSync(new URL("../src/worker/email/send.ts", import.meta.url), "utf8");
const native = readFileSync(new URL("../src/worker/providers/native.ts", import.meta.url), "utf8");
assert.match(registry, /transportChoice\(env, box\.id, box\.email_address\)/);
assert.match(send, /transportChoice\(env, provider\.accountId, provider\.address\)/);
assert.match(native, /transportChoice\(this\.env, this\.accountId, this\.address\)/);
assert.doesNotMatch(native, /env\.EMAIL_MULTI|env\.EMAIL\b/, "bindings are only chosen in transports/");
// From is always server-derived: the form's accountId resolves the provider, never a client "from".
assert.doesNotMatch(send, /form\.get\("from"\)/);
assert.match(send, /suppressed_recipients/, "suppressed recipients are checked before any transport runs");

console.log("PASS: outbound transport selection, policy gate and sender derivation");
